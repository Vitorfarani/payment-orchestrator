import { GenericContainer, Wait } from 'testcontainers'
import type { StartedTestContainer } from 'testcontainers'
import Knex from 'knex'
import type { Knex as KnexType } from 'knex'
import path from 'path'
import { KnexUnitOfWork } from '../../../src/infrastructure/database/KnexUnitOfWork'
import { PostgresPaymentRepository } from '../../../src/infrastructure/database/repositories/PostgresPaymentRepository'
import { Payment } from '../../../src/domain/payment/Payment'
import { OutboxEvent } from '../../../src/domain/outbox/OutboxEvent'
import { PaymentId, SellerId, Cents, IdempotencyKey } from '../../../src/domain/shared/types'

// ──────────────────────────────────────────────────────────────────────────────
// Integration tests — KnexUnitOfWork com PostgreSQL real via Testcontainers
//
// O que testamos:
//   1. commit — escritas dentro de run() são persistidas quando callback resolve
//   2. rollback — escritas são revertidas quando callback rejeita
//   3. atomicidade — payment + outbox_event são revertidos juntos em caso de erro
//   4. isolamento — leitura fora da trx não enxerga dados não-commitados (read-committed)
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
    // Pool mínimo de 2 conexões: uma para a trx, outra para leitura de isolamento
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

let counter = 0

async function insertSeller(): Promise<string> {
  counter++
  const [row] = await db('sellers')
    .insert({
      name:     `Seller UoW ${counter}`,
      document: `DOC-UOW-${counter}-${Date.now()}`,
      email:    `uow${counter}-${Date.now()}@test.com`,
    })
    .returning('id') as Array<{ id: string }>
  if (!row) throw new Error('insertSeller: nenhuma linha retornada')
  return row.id
}

function makePayment(sellerId: string): Payment {
  return Payment.reconstitute({
    id:             PaymentId.create(),
    sellerId:       SellerId.of(sellerId),
    amount:         Cents.of(10_000),
    idempotencyKey: IdempotencyKey.of(`idem-uow-${Date.now()}-${Math.random()}`),
    status:         'PENDING',
    createdAt:      new Date(),
    updatedAt:      new Date(),
  })
}

function makeOutboxEvent(aggregateId: string): OutboxEvent {
  return OutboxEvent.create({
    eventType:     'PAYMENT_CREATED',
    aggregateId,
    aggregateType: 'Payment',
    payload:       { paymentId: aggregateId },
  })
}

// ── Testes ────────────────────────────────────────────────────────────────────

describe('KnexUnitOfWork (integration)', () => {
  let uow: KnexUnitOfWork

  beforeEach(() => {
    uow = new KnexUnitOfWork(db)
  })

  // ── commit ──────────────────────────────────────────────────────────────────

  describe('commit', () => {
    it('persiste as escritas quando o callback resolve', async () => {
      const sellerId = await insertSeller()
      const payment  = makePayment(sellerId)

      await uow.run(async (repos) => {
        await repos.payments.save(payment)
      })

      const found = await new PostgresPaymentRepository(db).findById(payment.id)
      expect(found).not.toBeNull()
      expect(found?.id).toBe(payment.id)
    })

    it('retorna o valor resolvido pelo callback', async () => {
      const sellerId = await insertSeller()
      const payment  = makePayment(sellerId)

      const result = await uow.run(async (repos) => {
        await repos.payments.save(payment)
        return 'valor-de-retorno'
      })

      expect(result).toBe('valor-de-retorno')
    })
  })

  // ── rollback ─────────────────────────────────────────────────────────────────

  describe('rollback', () => {
    it('reverte as escritas quando o callback rejeita', async () => {
      const sellerId = await insertSeller()
      const payment  = makePayment(sellerId)

      await expect(
        uow.run(async (repos) => {
          await repos.payments.save(payment)
          throw new Error('falha simulada')
        }),
      ).rejects.toThrow('falha simulada')

      const found = await new PostgresPaymentRepository(db).findById(payment.id)
      expect(found).toBeNull()
    })

    it('propaga o erro original ao caller', async () => {
      const sellerId = await insertSeller()

      await expect(
        uow.run(async (repos) => {
          await repos.payments.save(makePayment(sellerId))
          throw new Error('erro específico do use case')
        }),
      ).rejects.toThrow('erro específico do use case')
    })
  })

  // ── atomicidade ──────────────────────────────────────────────────────────────

  describe('atomicidade', () => {
    it('reverte payment e outbox_event juntos quando erro ocorre após os dois saves', async () => {
      const sellerId = await insertSeller()
      const payment  = makePayment(sellerId)
      const event    = makeOutboxEvent(payment.id)

      await expect(
        uow.run(async (repos) => {
          await repos.payments.save(payment)
          await repos.outbox.save(event)
          throw new Error('erro após os dois saves')
        }),
      ).rejects.toThrow()

      // Ambos devem estar ausentes — o rollback é atômico
      const foundPayment = await new PostgresPaymentRepository(db).findById(payment.id)
      const foundEvents  = await db('outbox_events').where({ id: event.id }) as unknown[]

      expect(foundPayment).toBeNull()
      expect(foundEvents).toHaveLength(0)
    })
  })

  // ── isolamento ───────────────────────────────────────────────────────────────

  describe('isolamento (read-committed)', () => {
    it('leitura fora da transação não enxerga dados não-commitados', async () => {
      const sellerId = await insertSeller()
      const payment  = makePayment(sellerId)

      // Repositório que usa a conexão pool global (fora da trx)
      const repoOutside = new PostgresPaymentRepository(db)
      let readDuringTx: Payment | null = null

      await uow.run(async (repos) => {
        await repos.payments.save(payment)

        // Leitura com OUTRA conexão do pool — não deve enxergar o dado ainda
        readDuringTx = await repoOutside.findById(payment.id)
      })

      const readAfterCommit = await repoOutside.findById(payment.id)

      expect(readDuringTx).toBeNull()      // read-committed: dado invisível antes do commit
      expect(readAfterCommit).not.toBeNull() // visível após commit
    })
  })
})
