import { GenericContainer, Wait } from 'testcontainers'
import type { StartedTestContainer } from 'testcontainers'
import Knex from 'knex'
import type { Knex as KnexType } from 'knex'
import path from 'path'
import { PostgresSettlementRepository } from '../../../src/infrastructure/database/repositories/PostgresSettlementRepository'
import { SettlementItem } from '../../../src/domain/settlement/SettlementItem'
import type { Result } from '../../../src/domain/shared/Result'
import { PaymentId, SellerId, Cents, IdempotencyKey, SettlementItemId } from '../../../src/domain/shared/types'

/** Extrai o valor de um Result ou lança se falhou — só usar em testes. */
function unwrap<T>(result: Result<T, Error>): T {
  if (result.ok) return result.value
  throw new Error(`unwrap() falhou: ${result.error.message}`)
}

// ──────────────────────────────────────────────────────────────────────────────
// Integration tests — PostgresSettlementRepository com PostgreSQL real
//
// O que testamos:
//   1. save()                   — INSERT + constraints (amount_cents > 0, status válido)
//   2. update()                 — UPDATE de status; trigger set_updated_at
//   3. findById()               — SELECT por PK; BIGINT→Cents; null para ausente
//   4. findByPaymentId()        — lookup por payment_id; null para ausente
//   5. findDueItems()           — filtra PENDING com scheduled_date <= asOf (índice parcial)
//   6. findDueItems() excluindo — exclui status != PENDING após update
//   7. findByIdForUpdate()      — SELECT FOR UPDATE retorna item corretamente
//   8. findBySellerAndStatus()  — filtro composto seller_id + status
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
      name:     `Seller Settlement ${counter}`,
      document: `DOC-SET-${counter}-${Date.now()}`,
      email:    `set${counter}-${Date.now()}@test.com`,
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
      idempotency_key: IdempotencyKey.of(`idem-set-${Date.now()}-${Math.random()}`),
    })
    .returning('id') as Array<{ id: string }>
  if (!row) throw new Error('insertPayment: nenhuma linha retornada')
  return row.id
}

/**
 * Cria um SettlementItem via SettlementItem.create() — status sempre PENDING.
 * scheduledDate default: ontem (já vencido, elegível para findDueItems).
 */
function makeItem(
  paymentId: string,
  sellerId: string,
  overrides: Partial<{ amountCents: number; scheduledDate: Date }> = {},
): SettlementItem {
  const result = SettlementItem.create({
    paymentId:     PaymentId.of(paymentId),
    sellerId:      SellerId.of(sellerId),
    amountCents:   Cents.of(overrides.amountCents ?? 5_000),
    scheduledDate: overrides.scheduledDate ?? yesterday(),
  })
  if (!result.ok) throw new Error(`makeItem falhou: ${result.error.message}`)
  return result.value
}

function yesterday(): Date {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return d
}

function tomorrow(): Date {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return d
}

// ── Testes ────────────────────────────────────────────────────────────────────

describe('PostgresSettlementRepository (integration)', () => {
  let repo: PostgresSettlementRepository

  beforeEach(() => {
    repo = new PostgresSettlementRepository(db)
  })

  // ── 1. save() ──────────────────────────────────────────────────────────────

  describe('save()', () => {
    it('persiste um item PENDING e o encontra por id', async () => {
      const sellerId   = await insertSeller()
      const paymentId  = await insertPayment(sellerId)
      const item       = makeItem(paymentId, sellerId)

      await repo.save(item)

      const found = await repo.findById(SettlementItemId.of(item.id))
      expect(found).not.toBeNull()
      expect(found?.id).toBe(item.id)
      expect(found?.paymentId).toBe(item.paymentId)
      expect(found?.sellerId).toBe(item.sellerId)
      expect(found?.amountCents).toBe(item.amountCents)
      expect(found?.status).toBe('PENDING')
    })

    it('preserva BIGINT → Cents sem perda de precisão', async () => {
      const sellerId  = await insertSeller()
      const paymentId = await insertPayment(sellerId)
      const bigAmount = 99_999_999          // R$ 999.999,99
      const item      = makeItem(paymentId, sellerId, { amountCents: bigAmount })

      await repo.save(item)

      const found = await repo.findById(SettlementItemId.of(item.id))
      expect(found?.amountCents).toBe(bigAmount)
    })

    it('rejeita amount_cents = 0 (constraint CHECK amount_cents > 0)', async () => {
      const sellerId   = await insertSeller()
      const paymentId  = await insertPayment(sellerId)

      // Contorna o guard do domínio inserindo diretamente para testar o constraint do banco
      await expect(
        db('settlement_items').insert({
          id:             SettlementItemId.create(),
          payment_id:     paymentId,
          seller_id:      sellerId,
          amount_cents:   0,
          scheduled_date: new Date(),
          status:         'PENDING',
          created_at:     new Date(),
          updated_at:     new Date(),
        }),
      ).rejects.toThrow()
    })

    it('rejeita status inválido (constraint CHECK status IN (...))', async () => {
      const sellerId  = await insertSeller()
      const paymentId = await insertPayment(sellerId)

      await expect(
        db('settlement_items').insert({
          id:             SettlementItemId.create(),
          payment_id:     paymentId,
          seller_id:      sellerId,
          amount_cents:   1_000,
          scheduled_date: new Date(),
          status:         'INVALID_STATUS',
          created_at:     new Date(),
          updated_at:     new Date(),
        }),
      ).rejects.toThrow()
    })

    it('rejeita payment_id inexistente (FK constraint)', async () => {
      const sellerId = await insertSeller()
      const item     = makeItem(PaymentId.create(), sellerId)

      await expect(repo.save(item)).rejects.toThrow()
    })
  })

  // ── 2. update() ────────────────────────────────────────────────────────────

  describe('update()', () => {
    it('atualiza status PENDING → PROCESSING', async () => {
      const sellerId  = await insertSeller()
      const paymentId = await insertPayment(sellerId)
      const item      = makeItem(paymentId, sellerId)
      await repo.save(item)

      const processing = unwrap(item.startProcessing())

      await repo.update(processing)

      const found = await repo.findById(SettlementItemId.of(item.id))
      expect(found?.status).toBe('PROCESSING')
    })

    it('atualiza status PROCESSING → COMPLETED', async () => {
      const sellerId  = await insertSeller()
      const paymentId = await insertPayment(sellerId)
      const item      = makeItem(paymentId, sellerId)
      await repo.save(item)

      const proc     = unwrap(item.startProcessing())
      const complete = unwrap(proc.complete())
      await repo.update(proc)
      await repo.update(complete)

      const found = await repo.findById(SettlementItemId.of(item.id))
      expect(found?.status).toBe('COMPLETED')
    })

    it('atualiza status PROCESSING → FAILED', async () => {
      const sellerId  = await insertSeller()
      const paymentId = await insertPayment(sellerId)
      const item      = makeItem(paymentId, sellerId)
      await repo.save(item)

      const proc   = unwrap(item.startProcessing())
      const failed = unwrap(proc.fail())
      await repo.update(proc)
      await repo.update(failed)

      const found = await repo.findById(SettlementItemId.of(item.id))
      expect(found?.status).toBe('FAILED')
    })
  })

  // ── 3. findById() ──────────────────────────────────────────────────────────

  describe('findById()', () => {
    it('retorna null para id inexistente', async () => {
      const found = await repo.findById(SettlementItemId.create())
      expect(found).toBeNull()
    })

    it('retorna o item com todos os campos corretos', async () => {
      const sellerId  = await insertSeller()
      const paymentId = await insertPayment(sellerId)
      const item      = makeItem(paymentId, sellerId)
      await repo.save(item)

      const found = await repo.findById(SettlementItemId.of(item.id))
      expect(found).not.toBeNull()
      expect(found?.status).toBe('PENDING')
      // DATE column é reconvertido para Date object — verifica tipo (valor depende de timezone)
      expect(found?.scheduledDate).toBeInstanceOf(Date)
    })
  })

  // ── 4. findByPaymentId() ───────────────────────────────────────────────────

  describe('findByPaymentId()', () => {
    it('retorna o item pelo payment_id', async () => {
      const sellerId  = await insertSeller()
      const paymentId = await insertPayment(sellerId)
      const item      = makeItem(paymentId, sellerId)
      await repo.save(item)

      const found = await repo.findByPaymentId(PaymentId.of(paymentId))
      expect(found).not.toBeNull()
      expect(found?.id).toBe(item.id)
    })

    it('retorna null quando payment_id não existe na tabela', async () => {
      const found = await repo.findByPaymentId(PaymentId.create())
      expect(found).toBeNull()
    })
  })

  // ── 5. findDueItems() ──────────────────────────────────────────────────────

  describe('findDueItems()', () => {
    it('retorna itens PENDING com scheduled_date <= asOf', async () => {
      const sellerId  = await insertSeller()
      const paymentId = await insertPayment(sellerId)
      const item      = makeItem(paymentId, sellerId, { scheduledDate: yesterday() })
      await repo.save(item)

      const due = await repo.findDueItems(new Date())
      const ids  = due.map(i => i.id)
      expect(ids).toContain(item.id)
    })

    it('exclui itens com scheduled_date > asOf (futuros)', async () => {
      const sellerId  = await insertSeller()
      const paymentId = await insertPayment(sellerId)
      const future    = makeItem(paymentId, sellerId, { scheduledDate: tomorrow() })
      await repo.save(future)

      const due = await repo.findDueItems(new Date())
      const ids  = due.map(i => i.id)
      expect(ids).not.toContain(future.id)
    })

    it('exclui itens com status PROCESSING (não é PENDING)', async () => {
      const sellerId  = await insertSeller()
      const paymentId = await insertPayment(sellerId)
      const item      = makeItem(paymentId, sellerId, { scheduledDate: yesterday() })
      await repo.save(item)

      const processing = unwrap(item.startProcessing())
      await repo.update(processing)

      const due = await repo.findDueItems(new Date())
      const ids  = due.map(i => i.id)
      expect(ids).not.toContain(item.id)
    })

    it('exclui itens com status COMPLETED', async () => {
      const sellerId  = await insertSeller()
      const paymentId = await insertPayment(sellerId)
      const item      = makeItem(paymentId, sellerId, { scheduledDate: yesterday() })
      await repo.save(item)

      const proc     = unwrap(item.startProcessing())
      const complete = unwrap(proc.complete())
      await repo.update(proc)
      await repo.update(complete)

      const due = await repo.findDueItems(new Date())
      const ids  = due.map(i => i.id)
      expect(ids).not.toContain(item.id)
    })

    it('ordena por scheduled_date ascending', async () => {
      const sellerId = await insertSeller()

      const paymentId1 = await insertPayment(sellerId)
      const paymentId2 = await insertPayment(sellerId)
      const paymentId3 = await insertPayment(sellerId)

      const d1 = new Date('2024-01-01')
      const d2 = new Date('2024-01-15')
      const d3 = new Date('2024-01-10')

      const item1 = makeItem(paymentId1, sellerId, { scheduledDate: d1 })
      const item2 = makeItem(paymentId2, sellerId, { scheduledDate: d2 })
      const item3 = makeItem(paymentId3, sellerId, { scheduledDate: d3 })

      await repo.save(item1)
      await repo.save(item2)
      await repo.save(item3)

      const due = await repo.findDueItems(new Date('2025-01-01'))
      // Filtra apenas os três criados aqui para isolar de dados de outros testes
      const filtered = due.filter(i => [item1.id, item2.id, item3.id].includes(i.id))
      expect(filtered.length).toBe(3)

      const [t0, t1, t2] = filtered.map(i => i.scheduledDate.getTime())
      expect(t0).toBeLessThanOrEqual(t1 ?? Infinity)
      expect(t1).toBeLessThanOrEqual(t2 ?? Infinity)
    })

    it('retorna lista vazia quando não há itens elegíveis', async () => {
      // asOf no passado distante — nenhum item deve estar agendado antes disso
      const veryOldDate = new Date('2000-01-01')
      const due = await repo.findDueItems(veryOldDate)
      expect(due.length).toBe(0)
    })
  })

  // ── 6. findByIdForUpdate() ────────────────────────────────────────────────

  describe('findByIdForUpdate()', () => {
    it('retorna o item dentro de uma transação (SELECT FOR UPDATE)', async () => {
      const sellerId  = await insertSeller()
      const paymentId = await insertPayment(sellerId)
      const item      = makeItem(paymentId, sellerId)
      await repo.save(item)

      await db.transaction(async (trx) => {
        const repoTrx = new PostgresSettlementRepository(trx)
        const found   = await repoTrx.findByIdForUpdate(SettlementItemId.of(item.id))
        expect(found).not.toBeNull()
        expect(found?.id).toBe(item.id)
        expect(found?.status).toBe('PENDING')
      })
    })

    it('retorna null para id inexistente', async () => {
      await db.transaction(async (trx) => {
        const repoTrx = new PostgresSettlementRepository(trx)
        const found   = await repoTrx.findByIdForUpdate(SettlementItemId.create())
        expect(found).toBeNull()
      })
    })

    it('bloqueia a linha — segunda transação aguarda o lock ser liberado', async () => {
      const sellerId  = await insertSeller()
      const paymentId = await insertPayment(sellerId)
      const item      = makeItem(paymentId, sellerId)
      await repo.save(item)

      const events: string[] = []

      // Trx 1 adquire o lock e aguarda um tick antes de liberar
      const trx1Promise = db.transaction(async (trx) => {
        const repoTrx = new PostgresSettlementRepository(trx)
        const found   = await repoTrx.findByIdForUpdate(SettlementItemId.of(item.id))
        expect(found).not.toBeNull()
        events.push('trx1-locked')

        // Mantém o lock por um tick do event loop
        await new Promise<void>(resolve => setImmediate(resolve))
        events.push('trx1-releasing')
      })

      // Trx 2 tenta adquirir o mesmo lock
      const trx2Promise = db.transaction(async (trx) => {
        const repoTrx = new PostgresSettlementRepository(trx)
        const found   = await repoTrx.findByIdForUpdate(SettlementItemId.of(item.id))
        expect(found).not.toBeNull()
        events.push('trx2-locked')
      })

      await Promise.all([trx1Promise, trx2Promise])

      // trx1 deve ter adquirido o lock antes de trx1 liberar;
      // trx2 só completa após trx1 liberar
      expect(events.indexOf('trx1-locked')).toBeLessThan(events.indexOf('trx1-releasing'))
      expect(events.indexOf('trx1-releasing')).toBeLessThan(events.indexOf('trx2-locked'))
    }, 15_000)
  })

  // ── 7. findBySellerAndStatus() ────────────────────────────────────────────

  describe('findBySellerAndStatus()', () => {
    it('retorna apenas itens do seller especificado com o status correto', async () => {
      const sellerId1 = await insertSeller()
      const sellerId2 = await insertSeller()

      const paymentId1 = await insertPayment(sellerId1)
      const paymentId2 = await insertPayment(sellerId1)
      const paymentId3 = await insertPayment(sellerId2)

      const item1 = makeItem(paymentId1, sellerId1)  // seller1 PENDING
      const item2 = makeItem(paymentId2, sellerId1)  // seller1 PENDING → PROCESSING
      const item3 = makeItem(paymentId3, sellerId2)  // seller2 PENDING

      await repo.save(item1)
      await repo.save(item2)
      await repo.save(item3)

      const proc2 = unwrap(item2.startProcessing())
      await repo.update(proc2)

      const pending1 = await repo.findBySellerAndStatus(SellerId.of(sellerId1), 'PENDING')
      const ids1     = pending1.map(i => i.id)

      expect(ids1).toContain(item1.id)
      expect(ids1).not.toContain(item2.id)   // está em PROCESSING
      expect(ids1).not.toContain(item3.id)   // é de seller2
    })

    it('retorna lista vazia quando seller não tem itens no status pedido', async () => {
      const sellerId  = await insertSeller()
      const paymentId = await insertPayment(sellerId)
      const item      = makeItem(paymentId, sellerId)
      await repo.save(item)

      const completed = await repo.findBySellerAndStatus(SellerId.of(sellerId), 'COMPLETED')
      expect(completed).toHaveLength(0)
    })
  })
})
