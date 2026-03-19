import { GenericContainer, Wait } from 'testcontainers'
import type { StartedTestContainer } from 'testcontainers'
import Knex from 'knex'
import type { Knex as KnexType } from 'knex'
import path from 'path'
import { PostgresLedgerRepository } from '../../../src/infrastructure/database/repositories/PostgresLedgerRepository'
import { JournalEntry } from '../../../src/domain/ledger/JournalEntry'
import { AccountCode } from '../../../src/domain/ledger/value-objects/AccountCode'
import { JournalEntryId, PaymentId, Cents, IdempotencyKey } from '../../../src/domain/shared/types'

// ──────────────────────────────────────────────────────────────────────────────
// Integration tests — PostgresLedgerRepository com PostgreSQL real
//
// O que testamos:
//   1. save()                   — INSERT em journal_entries + ledger_entries (atômico)
//   2. findById()               — reconstitui linhas e BIGINT→Cents
//   3. findByPaymentId()        — retorna todas as entradas de um pagamento
//   4. existsByOutboxEventId()  — idempotência do LedgerWorker (ADR-009)
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

let counter = 0

async function insertSeller(): Promise<string> {
  counter++
  const [row] = await db('sellers')
    .insert({
      name:     `Seller Ledger ${counter}`,
      document: `DOC-LED-${counter}-${Date.now()}`,
      email:    `ledger${counter}-${Date.now()}@test.com`,
    })
    .returning('id') as Array<{ id: string }>
  if (!row) throw new Error('insertSeller: nenhuma linha retornada')
  return row.id
}

async function insertPayment(sellerId: string): Promise<string> {
  const [row] = await db('payments')
    .insert({
      id:              PaymentId.create(),
      seller_id:       sellerId,
      amount_cents:    10_000,
      idempotency_key: IdempotencyKey.of(`idem-led-${Date.now()}-${Math.random()}`),
    })
    .returning('id') as Array<{ id: string }>
  if (!row) throw new Error('insertPayment: nenhuma linha retornada')
  return row.id
}

/**
 * Cria uma JournalEntry balanceada simulando captura de R$100,00:
 *   DEBIT  1001 (Receivable Gateway)  10.000
 *   CREDIT 3001 (Revenue Platform)    1.500
 *   CREDIT 2001 (Payable Seller)      8.500
 */
function makeEntry(paymentId: string, overrides: Partial<{
  sourceEventId: string
  amount:        number
}> = {}): JournalEntry {
  const total    = overrides.amount ?? 10_000
  const platform = Math.floor(total * 0.15)
  const seller   = total - platform

  return JournalEntry.reconstitute({
    id:          JournalEntryId.create(),
    paymentId:   PaymentId.of(paymentId),
    description: 'PaymentCaptured',
    occurredAt:  new Date(),
    createdAt:   new Date(),
    lines: [
      { accountCode: AccountCode.RECEIVABLE_GATEWAY, type: 'DEBIT',  amount: Cents.of(total) },
      { accountCode: AccountCode.REVENUE_PLATFORM,   type: 'CREDIT', amount: Cents.of(platform) },
      { accountCode: AccountCode.PAYABLE_SELLER,     type: 'CREDIT', amount: Cents.of(seller) },
    ],
    ...(overrides.sourceEventId !== undefined && { sourceEventId: overrides.sourceEventId }),
  })
}

// ── Testes ────────────────────────────────────────────────────────────────────

describe('PostgresLedgerRepository (integration)', () => {
  let repo: PostgresLedgerRepository

  beforeEach(() => {
    repo = new PostgresLedgerRepository(db)
  })

  // ── save() ──────────────────────────────────────────────────────────────────

  describe('save()', () => {
    it('persiste journal_entry e ledger_entries — findById retorna a entidade', async () => {
      const sellerId  = await insertSeller()
      const paymentId = await insertPayment(sellerId)
      const entry     = makeEntry(paymentId)

      await repo.save(entry)

      const found = await repo.findById(entry.id)
      expect(found).not.toBeNull()
      expect(found?.id).toBe(entry.id)
      expect(found?.lines).toHaveLength(3)
    })

    it('persiste todas as 3 linhas do lançamento contábil', async () => {
      const sellerId  = await insertSeller()
      const paymentId = await insertPayment(sellerId)
      const entry     = makeEntry(paymentId)

      await repo.save(entry)

      const rows = await db('ledger_entries').where({ journal_entry_id: entry.id })
      expect(rows).toHaveLength(3)
    })

    it('persiste sourceEventId quando fornecido', async () => {
      const sellerId      = await insertSeller()
      const paymentId     = await insertPayment(sellerId)
      const sourceEventId = crypto.randomUUID()
      const entry         = makeEntry(paymentId, { sourceEventId })

      await repo.save(entry)

      const [row] = await db('journal_entries').where({ id: entry.id }) as Array<{
        source_event_id: string | null
      }>
      expect(row?.source_event_id).toBe(sourceEventId)
    })

    it('source_event_id é null quando não fornecido', async () => {
      const sellerId  = await insertSeller()
      const paymentId = await insertPayment(sellerId)
      const entry     = makeEntry(paymentId)

      await repo.save(entry)

      const [row] = await db('journal_entries').where({ id: entry.id }) as Array<{
        source_event_id: string | null
      }>
      expect(row?.source_event_id).toBeNull()
    })
  })

  // ── findById() ──────────────────────────────────────────────────────────────

  describe('findById()', () => {
    it('retorna null quando o id não existe', async () => {
      const result = await repo.findById(JournalEntryId.create())
      expect(result).toBeNull()
    })

    it('converte BIGINT amount_cents para Cents corretamente', async () => {
      const sellerId  = await insertSeller()
      const paymentId = await insertPayment(sellerId)
      const entry     = makeEntry(paymentId, { amount: 99_750 })

      await repo.save(entry)

      const found = await repo.findById(entry.id)
      const debitLine = found?.lines.find((l) => l.type === 'DEBIT')
      expect(debitLine?.amount).toBe(99_750)
    })

    it('reconstitui paymentId e description corretamente', async () => {
      const sellerId  = await insertSeller()
      const paymentId = await insertPayment(sellerId)
      const entry     = makeEntry(paymentId)

      await repo.save(entry)

      const found = await repo.findById(entry.id)
      expect(found?.paymentId).toBe(paymentId)
      expect(found?.description).toBe('PaymentCaptured')
    })

    it('reconstitui sourceEventId quando presente', async () => {
      const sellerId      = await insertSeller()
      const paymentId     = await insertPayment(sellerId)
      const sourceEventId = crypto.randomUUID()
      const entry         = makeEntry(paymentId, { sourceEventId })

      await repo.save(entry)

      const found = await repo.findById(entry.id)
      expect(found?.sourceEventId).toBe(sourceEventId)
    })

    it('sourceEventId é undefined quando ausente', async () => {
      const sellerId  = await insertSeller()
      const paymentId = await insertPayment(sellerId)
      const entry     = makeEntry(paymentId)

      await repo.save(entry)

      const found = await repo.findById(entry.id)
      expect(found?.sourceEventId).toBeUndefined()
    })
  })

  // ── findByPaymentId() ────────────────────────────────────────────────────────

  describe('findByPaymentId()', () => {
    it('retorna todas as entradas de um pagamento', async () => {
      const sellerId  = await insertSeller()
      const paymentId = await insertPayment(sellerId)
      const entry1    = makeEntry(paymentId)
      const entry2    = makeEntry(paymentId)

      await repo.save(entry1)
      await repo.save(entry2)

      const results = await repo.findByPaymentId(PaymentId.of(paymentId))
      const ids = results.map((e) => e.id)

      expect(ids).toContain(entry1.id)
      expect(ids).toContain(entry2.id)
    })

    it('retorna array vazio quando o pagamento não tem entradas', async () => {
      const sellerId  = await insertSeller()
      const paymentId = await insertPayment(sellerId)

      const results = await repo.findByPaymentId(PaymentId.of(paymentId))
      expect(results).toHaveLength(0)
    })

    it('não retorna entradas de outro pagamento', async () => {
      const sellerId   = await insertSeller()
      const paymentIdA = await insertPayment(sellerId)
      const paymentIdB = await insertPayment(sellerId)
      const entry      = makeEntry(paymentIdA)

      await repo.save(entry)

      const results = await repo.findByPaymentId(PaymentId.of(paymentIdB))
      const ids = results.map((e) => e.id)
      expect(ids).not.toContain(entry.id)
    })
  })

  // ── existsByOutboxEventId() ──────────────────────────────────────────────────

  describe('existsByOutboxEventId()', () => {
    it('retorna true quando já existe uma entrada com esse outbox event id', async () => {
      const sellerId      = await insertSeller()
      const paymentId     = await insertPayment(sellerId)
      const sourceEventId = crypto.randomUUID()
      const entry         = makeEntry(paymentId, { sourceEventId })

      await repo.save(entry)

      const exists = await repo.existsByOutboxEventId(sourceEventId)
      expect(exists).toBe(true)
    })

    it('retorna false quando nenhuma entrada tem esse outbox event id', async () => {
      const exists = await repo.existsByOutboxEventId(crypto.randomUUID())
      expect(exists).toBe(false)
    })

    it('garante idempotência — segundo processamento do mesmo evento é detectado', async () => {
      const sellerId      = await insertSeller()
      const paymentId     = await insertPayment(sellerId)
      const sourceEventId = crypto.randomUUID()

      // Primeiro processamento
      await repo.save(makeEntry(paymentId, { sourceEventId }))
      expect(await repo.existsByOutboxEventId(sourceEventId)).toBe(true)

      // Segundo processamento: LedgerWorker verifica antes de criar nova entrada
      const alreadyProcessed = await repo.existsByOutboxEventId(sourceEventId)
      expect(alreadyProcessed).toBe(true)
      // → worker não insere duplicata
    })
  })
})
