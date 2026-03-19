import { GenericContainer, Wait } from 'testcontainers'
import type { StartedTestContainer } from 'testcontainers'
import Knex from 'knex'
import type { Knex as KnexType } from 'knex'
import path from 'path'
import { PostgresOutboxRepository } from '../../../src/infrastructure/database/repositories/PostgresOutboxRepository'
import { OutboxEvent } from '../../../src/domain/outbox/OutboxEvent'

// ──────────────────────────────────────────────────────────────────────────────
// Integration tests — PostgresOutboxRepository com PostgreSQL real
//
// O que testamos:
//   1. save()                  — INSERT + JSONB payload round-trip
//   2. findUnprocessedBatch()  — WHERE processed=false, ORDER BY created_at, LIMIT
//   3. SKIP LOCKED             — eventos bloqueados por outra trx são ignorados
//   4. markProcessed()         — processed=true, processed_at preenchido
//   5. recordFailure()         — error preenchido, retry_count incrementado
//
// Para rodar: npm run test:int
// ──────────────────────────────────────────────────────────────────────────────

const PG_USER = 'test_user'
const PG_PASS = 'test_pass'
const PG_DB   = 'test_db'

let container: StartedTestContainer
let db: KnexType

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_DB:       PG_DB,
      POSTGRES_USER:     PG_USER,
      POSTGRES_PASSWORD: PG_PASS,
    })
    .withExposedPorts(5432)
    .withWaitStrategy(
      Wait.forLogMessage('database system is ready to accept connections', 2),
    )
    .start()

  const port = container.getMappedPort(5432)
  const connectionUri = `postgresql://${PG_USER}:${PG_PASS}@localhost:${port}/${PG_DB}`

  db = Knex({
    client: 'pg',
    connection: connectionUri,
    pool: { min: 2, max: 5 },
    migrations: {
      directory: path.resolve(__dirname, '../../../src/infrastructure/database/migrations'),
      loadExtensions: ['.ts'],
    },
  })

  await db.migrate.latest()
}, 120_000)

afterAll(async () => {
  await db.destroy()
  await container.stop()
})

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<{
  eventType:     string
  aggregateId:   string
  aggregateType: string
  payload:       Record<string, unknown>
}> = {}): OutboxEvent {
  return OutboxEvent.create({
    eventType:     overrides.eventType     ?? 'PAYMENT_CAPTURED',
    aggregateId:   overrides.aggregateId   ?? crypto.randomUUID(),
    aggregateType: overrides.aggregateType ?? 'Payment',
    payload:       overrides.payload       ?? { amount: 10_000 },
  })
}

// ── Testes ────────────────────────────────────────────────────────────────────

describe('PostgresOutboxRepository (integration)', () => {
  let repo: PostgresOutboxRepository

  beforeEach(() => {
    repo = new PostgresOutboxRepository(db)
  })

  // ── save() ──────────────────────────────────────────────────────────────────

  describe('save()', () => {
    it('persiste o evento e o torna recuperável via findUnprocessedBatch', async () => {
      const event = makeEvent()

      await repo.save(event)

      const batch = await db.transaction((trx) =>
        new PostgresOutboxRepository(trx).findUnprocessedBatch(100),
      )
      const found = batch.find((e) => e.id === event.id)
      expect(found).toBeDefined()
    })

    it('persiste processed=false e retry_count=0 por padrão', async () => {
      const event = makeEvent()

      await repo.save(event)

      const [row] = await db('outbox_events').where({ id: event.id }) as Array<{
        processed: boolean
        retry_count: number
      }>
      expect(row?.processed).toBe(false)
      expect(row?.retry_count).toBe(0)
    })

    it('payload JSONB faz round-trip corretamente', async () => {
      const payload = { paymentId: 'pay-123', amount: 9_500, seller: 'acme' }
      const event   = makeEvent({ payload })

      await repo.save(event)

      const batch = await db.transaction((trx) =>
        new PostgresOutboxRepository(trx).findUnprocessedBatch(100),
      )
      const found = batch.find((e) => e.id === event.id)
      expect(found?.payload).toEqual(payload)
    })
  })

  // ── findUnprocessedBatch() ───────────────────────────────────────────────────

  describe('findUnprocessedBatch()', () => {
    it('retorna apenas eventos não processados', async () => {
      const unprocessed = makeEvent()
      const processed   = makeEvent()

      await repo.save(unprocessed)
      await repo.save(processed)
      await repo.markProcessed(processed.id, new Date())

      const batch = await db.transaction((trx) =>
        new PostgresOutboxRepository(trx).findUnprocessedBatch(100),
      )
      const ids = batch.map((e) => e.id)

      expect(ids).toContain(unprocessed.id)
      expect(ids).not.toContain(processed.id)
    })

    it('respeita o limit', async () => {
      // Insere 3 eventos garantidamente novos
      await repo.save(makeEvent())
      await repo.save(makeEvent())
      await repo.save(makeEvent())

      const batch = await db.transaction((trx) =>
        new PostgresOutboxRepository(trx).findUnprocessedBatch(2),
      )

      expect(batch.length).toBeLessThanOrEqual(2)
    })

    it('retorna array vazio quando não há eventos não processados', async () => {
      // Verifica via trx isolada — não usa repo global para evitar conflito com outros testes
      const isolatedDb = Knex({
        client: 'pg',
        connection: db.client.config.connection as string,
      })

      try {
        // Marca todos os eventos pendentes nessa conexão separada como processados para isolamento
        const batch = await isolatedDb.transaction(async (trx) => {
          const all = await new PostgresOutboxRepository(trx).findUnprocessedBatch(1000)
          for (const e of all) {
            await new PostgresOutboxRepository(trx).markProcessed(e.id, new Date())
          }
          return new PostgresOutboxRepository(trx).findUnprocessedBatch(100)
        })
        expect(batch).toHaveLength(0)
      } finally {
        await isolatedDb.destroy()
      }
    })
  })

  // ── SKIP LOCKED ─────────────────────────────────────────────────────────────

  describe('SKIP LOCKED', () => {
    it('trx B não enxerga eventos bloqueados pela trx A', async () => {
      const event1 = makeEvent()
      const event2 = makeEvent()
      await repo.save(event1)
      await repo.save(event2)

      let releaseLock!: () => void
      const lockHeld = new Promise<void>((resolve) => { releaseLock = resolve })

      let batchA: OutboxEvent[] = []

      // Trx A: adquire FOR UPDATE nos 2 eventos e segura o lock
      const txA = db.transaction(async (trxA) => {
        batchA = await new PostgresOutboxRepository(trxA).findUnprocessedBatch(100)
        await lockHeld
      })

      // Aguarda trxA adquirir os locks antes de trxB tentar
      await new Promise((r) => setTimeout(r, 80))

      // Trx B: SKIP LOCKED — deve ignorar os eventos bloqueados por trxA
      let batchB: OutboxEvent[] = []
      await db.transaction(async (trxB) => {
        batchB = await new PostgresOutboxRepository(trxB).findUnprocessedBatch(100)
      })

      const idsA = batchA.map((e) => e.id)
      const idsB = batchB.map((e) => e.id)

      expect(idsA).toContain(event1.id)
      expect(idsA).toContain(event2.id)
      // Nenhum dos eventos de A aparece em B — SKIP LOCKED funciona
      expect(idsB).not.toContain(event1.id)
      expect(idsB).not.toContain(event2.id)

      releaseLock()
      await txA
    })
  })

  // ── markProcessed() ──────────────────────────────────────────────────────────

  describe('markProcessed()', () => {
    it('define processed=true e processed_at', async () => {
      const event       = makeEvent()
      const processedAt = new Date()
      await repo.save(event)

      await repo.markProcessed(event.id, processedAt)

      const [row] = await db('outbox_events').where({ id: event.id }) as Array<{
        processed:    boolean
        processed_at: Date
      }>
      expect(row?.processed).toBe(true)
      expect(row?.processed_at).toBeInstanceOf(Date)
    })

    it('evento marcado não aparece em findUnprocessedBatch', async () => {
      const event = makeEvent()
      await repo.save(event)

      await repo.markProcessed(event.id, new Date())

      const batch = await db.transaction((trx) =>
        new PostgresOutboxRepository(trx).findUnprocessedBatch(100),
      )
      const ids = batch.map((e) => e.id)
      expect(ids).not.toContain(event.id)
    })
  })

  // ── recordFailure() ──────────────────────────────────────────────────────────

  describe('recordFailure()', () => {
    it('persiste a mensagem de erro', async () => {
      const event = makeEvent()
      await repo.save(event)

      await repo.recordFailure(event.id, 'timeout ao chamar gateway')

      const [row] = await db('outbox_events').where({ id: event.id }) as Array<{
        error: string | null
      }>
      expect(row?.error).toBe('timeout ao chamar gateway')
    })

    it('incrementa retry_count a cada chamada', async () => {
      const event = makeEvent()
      await repo.save(event)

      await repo.recordFailure(event.id, 'erro 1')
      await repo.recordFailure(event.id, 'erro 2')

      const [row] = await db('outbox_events').where({ id: event.id }) as Array<{
        retry_count: number
      }>
      expect(row?.retry_count).toBe(2)
    })

    it('evento continua não-processado após falha', async () => {
      const event = makeEvent()
      await repo.save(event)

      await repo.recordFailure(event.id, 'falha transitória')

      const batch = await db.transaction((trx) =>
        new PostgresOutboxRepository(trx).findUnprocessedBatch(100),
      )
      const ids = batch.map((e) => e.id)
      expect(ids).toContain(event.id)
    })
  })
})
