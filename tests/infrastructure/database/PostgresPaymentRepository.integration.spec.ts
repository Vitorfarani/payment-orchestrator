import { GenericContainer, Wait } from 'testcontainers'
import type { StartedTestContainer } from 'testcontainers'
import Knex from 'knex'
import type { Knex as KnexType } from 'knex'
import path from 'path'
import { PostgresPaymentRepository } from '../../../src/infrastructure/database/repositories/PostgresPaymentRepository'
import { Payment } from '../../../src/domain/payment/Payment'
import type { ReconstitutePaymentInput } from '../../../src/domain/payment/Payment'
import { PaymentId, SellerId, Cents, IdempotencyKey } from '../../../src/domain/shared/types'

// ──────────────────────────────────────────────────────────────────────────────
// Integration tests — PostgresPaymentRepository com PostgreSQL real
//
// O que testamos:
//   1. save()               — INSERT + CHECK constraints do banco
//   2. update()             — UPDATE de status e campos opcionais
//   3. findById()           — SELECT por PK; BIGINT→Cents; null para ausente
//   4. findByIdForUpdate()  — SELECT FOR UPDATE bloqueia linha para concorrência
//   5. findByIdempotencyKey() — lookup por chave única
//   6. findBySellerAndStatus() — filtro composto
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

let counter = 0

async function insertSeller(): Promise<string> {
  counter++
  const [row] = await db('sellers')
    .insert({
      name:     `Seller Pay ${counter}`,
      document: `DOC-PAY-${counter}-${Date.now()}`,
      email:    `pay${counter}-${Date.now()}@test.com`,
    })
    .returning('id') as Array<{ id: string }>
  if (!row) throw new Error('insertSeller: nenhuma linha retornada')
  return row.id
}

function makePayment(sellerId: string, overrides: Partial<{
  amount:         number
  idempotencyKey: string
  status:         ReconstitutePaymentInput['status']
}> = {}): Payment {
  return Payment.reconstitute({
    id:             PaymentId.create(),
    sellerId:       SellerId.of(sellerId),
    amount:         Cents.of(overrides.amount ?? 10_000),
    idempotencyKey: IdempotencyKey.of(overrides.idempotencyKey ?? `idem-${Date.now()}-${Math.random()}`),
    status:         overrides.status ?? 'PENDING',
    createdAt:      new Date(),
    updatedAt:      new Date(),
  })
}

/** Extrai os campos de um Payment via getters e retorna ReconstitutePaymentInput. */
function toInput(p: Payment, extra: Partial<ReconstitutePaymentInput> = {}): ReconstitutePaymentInput {
  return {
    id:             p.id,
    sellerId:       p.sellerId,
    amount:         p.amount,
    idempotencyKey: p.idempotencyKey,
    status:         p.status,
    createdAt:      p.createdAt,
    updatedAt:      p.updatedAt,
    ...(p.gateway            !== undefined && { gateway:          p.gateway }),
    ...(p.gatewayPaymentId   !== undefined && { gatewayPaymentId: p.gatewayPaymentId }),
    ...(p.gatewayResponse    !== undefined && { gatewayResponse:  p.gatewayResponse }),
    ...(p.errorCode          !== undefined && { errorCode:        p.errorCode }),
    ...(p.errorMessage       !== undefined && { errorMessage:     p.errorMessage }),
    ...(p.authorizedAt       !== undefined && { authorizedAt:     p.authorizedAt }),
    ...(p.capturedAt         !== undefined && { capturedAt:       p.capturedAt }),
    ...(p.refundedAt         !== undefined && { refundedAt:       p.refundedAt }),
    ...(p.failedAt           !== undefined && { failedAt:         p.failedAt }),
    ...extra,
  }
}

// ── Testes ────────────────────────────────────────────────────────────────────

describe('PostgresPaymentRepository (integration)', () => {
  let repo: PostgresPaymentRepository

  beforeEach(() => {
    repo = new PostgresPaymentRepository(db)
  })

  // ── save() ──────────────────────────────────────────────────────────────────

  describe('save()', () => {
    it('persiste o payment e o torna recuperável via findById', async () => {
      const sellerId = await insertSeller()
      const payment  = makePayment(sellerId)

      await repo.save(payment)

      const found = await repo.findById(payment.id)
      expect(found).not.toBeNull()
      expect(found?.id).toBe(payment.id)
    })

    it('converte amount_cents corretamente — BIGINT no banco, Cents no domínio', async () => {
      const sellerId = await insertSeller()
      const payment  = makePayment(sellerId, { amount: 99_999 })

      await repo.save(payment)

      const found = await repo.findById(payment.id)
      expect(found?.amount).toBe(99_999)
    })

    it('persiste status PENDING por padrão', async () => {
      const sellerId = await insertSeller()
      const payment  = makePayment(sellerId)

      await repo.save(payment)

      const found = await repo.findById(payment.id)
      expect(found?.status).toBe('PENDING')
    })

    it('CHECK constraint rejeita amount_cents <= 0', async () => {
      const sellerId = await insertSeller()
      // Injeta direto no banco para contornar validação do domínio
      await expect(
        db('payments').insert({
          id:              PaymentId.create(),
          seller_id:       sellerId,
          amount_cents:    0,
          idempotency_key: `idem-zero-${Date.now()}`,
        }),
      ).rejects.toThrow()
    })
  })

  // ── update() ────────────────────────────────────────────────────────────────

  describe('update()', () => {
    it('persiste novo status após update', async () => {
      const sellerId = await insertSeller()
      const payment  = makePayment(sellerId)
      await repo.save(payment)

      const processing = Payment.reconstitute(toInput(payment, { status: 'PROCESSING', updatedAt: new Date() }))
      await repo.update(processing)

      const found = await repo.findById(payment.id)
      expect(found?.status).toBe('PROCESSING')
    })

    it('persiste campos opcionais — gateway e gatewayPaymentId', async () => {
      const sellerId = await insertSeller()
      const payment  = makePayment(sellerId)
      await repo.save(payment)

      const authorized = Payment.reconstitute(toInput(payment, {
        status:           'AUTHORIZED',
        gateway:          'STRIPE',
        gatewayPaymentId: 'pi_test_abc123',
        authorizedAt:     new Date(),
        updatedAt:        new Date(),
      }))
      await repo.update(authorized)

      const found = await repo.findById(payment.id)
      expect(found?.status).toBe('AUTHORIZED')
      expect(found?.gateway).toBe('STRIPE')
      expect(found?.gatewayPaymentId).toBe('pi_test_abc123')
      expect(found?.authorizedAt).toBeInstanceOf(Date)
    })

    it('persiste errorCode e errorMessage ao falhar', async () => {
      const sellerId = await insertSeller()
      const payment  = makePayment(sellerId)
      await repo.save(payment)

      const failed = Payment.reconstitute(toInput(payment, {
        status:       'FAILED',
        errorCode:    'CARD_DECLINED',
        errorMessage: 'Cartão recusado pelo emissor',
        failedAt:     new Date(),
        updatedAt:    new Date(),
      }))
      await repo.update(failed)

      const found = await repo.findById(payment.id)
      expect(found?.status).toBe('FAILED')
      expect(found?.errorCode).toBe('CARD_DECLINED')
      expect(found?.errorMessage).toBe('Cartão recusado pelo emissor')
    })
  })

  // ── findById() ──────────────────────────────────────────────────────────────

  describe('findById()', () => {
    it('retorna null quando o id não existe', async () => {
      const result = await repo.findById(PaymentId.create())
      expect(result).toBeNull()
    })

    it('reconstitui sellerId e idempotencyKey corretamente', async () => {
      const sellerId      = await insertSeller()
      const idempotencyKey = `idem-findbyid-${Date.now()}`
      const payment       = makePayment(sellerId, { idempotencyKey })

      await repo.save(payment)

      const found = await repo.findById(payment.id)
      expect(found?.sellerId).toBe(sellerId)
      expect(found?.idempotencyKey).toBe(idempotencyKey)
    })

    it('campos opcionais ausentes retornam undefined', async () => {
      const sellerId = await insertSeller()
      const payment  = makePayment(sellerId)
      await repo.save(payment)

      const found = await repo.findById(payment.id)
      expect(found?.gateway).toBeUndefined()
      expect(found?.gatewayPaymentId).toBeUndefined()
      expect(found?.errorCode).toBeUndefined()
      expect(found?.authorizedAt).toBeUndefined()
    })
  })

  // ── findByIdForUpdate() ─────────────────────────────────────────────────────

  describe('findByIdForUpdate()', () => {
    it('retorna o payment correto dentro de uma transação', async () => {
      const sellerId = await insertSeller()
      const payment  = makePayment(sellerId)
      await repo.save(payment)

      let found: Payment | null = null
      await db.transaction(async (trx) => {
        found = await new PostgresPaymentRepository(trx).findByIdForUpdate(payment.id)
      })

      expect(found).not.toBeNull()
      expect((found as unknown as Payment).id).toBe(payment.id)
    })

    it('retorna null quando id não existe (sem lock)', async () => {
      let found: Payment | null = null
      await db.transaction(async (trx) => {
        found = await new PostgresPaymentRepository(trx).findByIdForUpdate(PaymentId.create())
      })
      expect(found).toBeNull()
    })

    it('bloqueia a linha — segunda trx falha com lock_timeout', async () => {
      const sellerId = await insertSeller()
      const payment  = makePayment(sellerId)
      await repo.save(payment)

      let releaseLock!: () => void
      const lockHeld = new Promise<void>((resolve) => { releaseLock = resolve })

      // Trx A: adquire o lock e aguarda sinal para liberar
      const txA = db.transaction(async (trxA) => {
        await new PostgresPaymentRepository(trxA).findByIdForUpdate(payment.id)
        await lockHeld
      })

      // Pequena espera para garantir que trxA já adquiriu o lock
      await new Promise((r) => setTimeout(r, 80))

      // Trx B: tenta o mesmo lock com timeout de 100ms — deve falhar
      const txB = db.transaction(async (trxB) => {
        await trxB.raw("SET LOCAL lock_timeout = '100ms'")
        await new PostgresPaymentRepository(trxB).findByIdForUpdate(payment.id)
      })

      await expect(txB).rejects.toThrow()

      releaseLock()
      await txA
    })
  })

  // ── findByIdempotencyKey() ──────────────────────────────────────────────────

  describe('findByIdempotencyKey()', () => {
    it('retorna o payment quando a chave existe', async () => {
      const sellerId       = await insertSeller()
      const idempotencyKey  = `idem-idem-${Date.now()}`
      const payment        = makePayment(sellerId, { idempotencyKey })
      await repo.save(payment)

      const found = await repo.findByIdempotencyKey(IdempotencyKey.of(idempotencyKey))
      expect(found).not.toBeNull()
      expect(found?.id).toBe(payment.id)
    })

    it('retorna null quando a chave não existe', async () => {
      const result = await repo.findByIdempotencyKey(IdempotencyKey.of('chave-inexistente-xyz'))
      expect(result).toBeNull()
    })
  })

  // ── findBySellerAndStatus() ─────────────────────────────────────────────────

  describe('findBySellerAndStatus()', () => {
    it('retorna payments do seller com o status correto', async () => {
      const sellerId = await insertSeller()
      const p1 = makePayment(sellerId, { status: 'PENDING' })
      const p2 = makePayment(sellerId, { status: 'PENDING' })
      await repo.save(p1)
      await repo.save(p2)

      const results = await repo.findBySellerAndStatus(SellerId.of(sellerId), 'PENDING')
      const ids = results.map((p) => p.id)

      expect(ids).toContain(p1.id)
      expect(ids).toContain(p2.id)
    })

    it('não retorna payments de outro seller', async () => {
      const sellerA = await insertSeller()
      const sellerB = await insertSeller()
      const payment = makePayment(sellerA, { status: 'PENDING' })
      await repo.save(payment)

      const results = await repo.findBySellerAndStatus(SellerId.of(sellerB), 'PENDING')
      const ids = results.map((p) => p.id)

      expect(ids).not.toContain(payment.id)
    })

    it('não retorna payments com status diferente', async () => {
      const sellerId = await insertSeller()
      const pending    = makePayment(sellerId, { status: 'PENDING' })
      const processing = makePayment(sellerId, { status: 'PROCESSING' })
      await repo.save(pending)
      await repo.save(processing)

      const results = await repo.findBySellerAndStatus(SellerId.of(sellerId), 'PENDING')
      const ids = results.map((p) => p.id)

      expect(ids).toContain(pending.id)
      expect(ids).not.toContain(processing.id)
    })

    it('retorna array vazio quando não há match', async () => {
      const sellerId = await insertSeller()
      const results  = await repo.findBySellerAndStatus(SellerId.of(sellerId), 'CAPTURED')
      expect(results).toHaveLength(0)
    })
  })
})
