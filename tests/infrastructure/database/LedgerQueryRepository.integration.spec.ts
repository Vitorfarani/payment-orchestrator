import { GenericContainer, Wait } from 'testcontainers'
import type { StartedTestContainer } from 'testcontainers'
import Knex from 'knex'
import type { Knex as KnexType } from 'knex'
import path from 'path'
import { LedgerQueryRepository } from '../../../src/infrastructure/database/repositories/LedgerQueryRepository'
import { AccountCode } from '../../../src/domain/ledger/value-objects/AccountCode'
import { SellerId, IdempotencyKey, PaymentId, JournalEntryId } from '../../../src/domain/shared/types'

// ──────────────────────────────────────────────────────────────────────────────
// Integration tests — LedgerQueryRepository (MATERIALIZED VIEW) com PostgreSQL real
//
// O que testamos:
//   1. refreshView()    — REFRESH MATERIALIZED VIEW CONCURRENTLY não falha
//   2. findBySeller()   — agrega corretamente após refresh; filtros from/to; BIGINT→Cents
//   3. findByAccount()  — filtra por account_code com isolamento via data
//
// Estratégia de isolamento:
//   - findBySeller: cada teste usa um seller único → resultados naturalmente isolados
//   - findByAccount: cada teste usa um intervalo de datas exclusivo (past dates)
//     para que acúmulo de dados de outros testes não contamine as assertions
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
      name:     `Seller MV ${counter}`,
      document: `DOC-MV-${counter}-${Date.now()}`,
      email:    `mv${counter}-${Date.now()}@test.com`,
    })
    .returning('id') as Array<{ id: string }>
  if (!row) throw new Error('insertSeller: nenhuma linha retornada')
  return row.id
}

/**
 * Insere a cadeia completa: payment → journal_entry → ledger_entries.
 *
 * ledgerCreatedAt controla a data que aparece na MATERIALIZED VIEW
 * (a view usa date_trunc('day', le.created_at)::DATE).
 *
 * Lançamento padrão simula captura de R$100,00:
 *   DEBIT  1001 (Receivable Gateway)  10.000
 *   CREDIT 3001 (Revenue Platform)     1.500
 *   CREDIT 2001 (Payable Seller)       8.500
 */
async function insertLedgerEntry(
  sellerId: string,
  ledgerCreatedAt: Date = new Date(),
): Promise<void> {
  const [payRow] = await db('payments')
    .insert({
      id:              PaymentId.create(),
      seller_id:       sellerId,
      amount_cents:    10_000,
      idempotency_key: IdempotencyKey.of(`idem-mv-${Date.now()}-${Math.random()}`),
    })
    .returning('id') as Array<{ id: string }>
  if (!payRow) throw new Error('insertPayment: nenhuma linha retornada')
  const paymentId = payRow.id

  await db.transaction(async (trx) => {
    const [jeRow] = await trx('journal_entries')
      .insert({
        id:          JournalEntryId.create(),
        payment_id:  paymentId,
        description: 'PaymentCaptured',
      })
      .returning('id') as Array<{ id: string }>
    if (!jeRow) throw new Error('insertJournalEntry: nenhuma linha retornada')
    const journalEntryId = jeRow.id

    // Trigger DEFERRABLE valida no COMMIT — as 3 linhas são inseridas juntas
    await trx('ledger_entries').insert([
      {
        journal_entry_id: journalEntryId,
        account_code:     AccountCode.RECEIVABLE_GATEWAY,
        entry_type:       'DEBIT',
        amount_cents:     10_000,
        created_at:       ledgerCreatedAt,
      },
      {
        journal_entry_id: journalEntryId,
        account_code:     AccountCode.REVENUE_PLATFORM,
        entry_type:       'CREDIT',
        amount_cents:     1_500,
        created_at:       ledgerCreatedAt,
      },
      {
        journal_entry_id: journalEntryId,
        account_code:     AccountCode.PAYABLE_SELLER,
        entry_type:       'CREDIT',
        amount_cents:     8_500,
        created_at:       ledgerCreatedAt,
      },
    ])
  })
}

// ── Testes ────────────────────────────────────────────────────────────────────

describe('LedgerQueryRepository (integration)', () => {
  let queryRepo: LedgerQueryRepository

  beforeEach(() => {
    queryRepo = new LedgerQueryRepository(db)
  })

  // ── refreshView() ────────────────────────────────────────────────────────────

  describe('refreshView()', () => {
    it('não lança exceção ao atualizar a view', async () => {
      await expect(queryRepo.refreshView()).resolves.not.toThrow()
    })

    it('pode ser chamado múltiplas vezes sem erro', async () => {
      await expect(queryRepo.refreshView()).resolves.not.toThrow()
      await expect(queryRepo.refreshView()).resolves.not.toThrow()
    })
  })

  // ── findBySeller() ───────────────────────────────────────────────────────────

  describe('findBySeller()', () => {
    it('retorna array vazio antes de qualquer entrada para o seller', async () => {
      const sellerId = await insertSeller()
      await queryRepo.refreshView()

      const rows = await queryRepo.findBySeller(SellerId.of(sellerId))
      expect(rows).toHaveLength(0)
    })

    it('retorna as linhas agregadas do seller após refresh', async () => {
      const sellerId = await insertSeller()
      await insertLedgerEntry(sellerId)
      await queryRepo.refreshView()

      const rows = await queryRepo.findBySeller(SellerId.of(sellerId))

      // 1 journal entry × 3 contas = 3 linhas na view
      expect(rows).toHaveLength(3)
      expect(rows.every((r) => r.sellerId === sellerId)).toBe(true)
    })

    it('não retorna linhas de outro seller', async () => {
      const sellerA = await insertSeller()
      const sellerB = await insertSeller()
      await insertLedgerEntry(sellerA)
      await queryRepo.refreshView()

      const rowsB = await queryRepo.findBySeller(SellerId.of(sellerB))
      expect(rowsB).toHaveLength(0)
    })

    it('converte BIGINT SUM corretamente — total_debits e total_credits como Cents', async () => {
      const sellerId = await insertSeller()
      await insertLedgerEntry(sellerId)
      await queryRepo.refreshView()

      const rows = await queryRepo.findBySeller(SellerId.of(sellerId))
      const debitRow = rows.find((r) => r.accountCode === AccountCode.RECEIVABLE_GATEWAY)

      expect(debitRow).toBeDefined()
      expect(debitRow?.totalDebits).toBe(10_000)
      expect(debitRow?.totalCredits).toBe(0)
    })

    it('acumula duas entradas do mesmo seller no mesmo dia', async () => {
      const sellerId  = await insertSeller()
      const today     = new Date()
      await insertLedgerEntry(sellerId, today)
      await insertLedgerEntry(sellerId, today)
      await queryRepo.refreshView()

      const rows    = await queryRepo.findBySeller(SellerId.of(sellerId))
      const debitRow = rows.find((r) => r.accountCode === AccountCode.RECEIVABLE_GATEWAY)

      // Dois lançamentos de 10.000 → total_debits = 20.000
      expect(debitRow?.totalDebits).toBe(20_000)
      expect(debitRow?.entryCount).toBe(2)
    })

    it('filtro from exclui entradas anteriores', async () => {
      const sellerId = await insertSeller()
      await insertLedgerEntry(sellerId, new Date('2019-06-01'))
      await insertLedgerEntry(sellerId, new Date('2023-06-01'))
      await queryRepo.refreshView()

      const rows = await queryRepo.findBySeller(
        SellerId.of(sellerId),
        new Date('2022-01-01'),
      )
      // Apenas a entrada de 2023 deve aparecer
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((r) => r.date >= new Date('2022-01-01'))).toBe(true)
    })

    it('filtro to exclui entradas posteriores', async () => {
      const sellerId = await insertSeller()
      await insertLedgerEntry(sellerId, new Date('2018-03-01'))
      await insertLedgerEntry(sellerId, new Date('2025-03-01'))
      await queryRepo.refreshView()

      const rows = await queryRepo.findBySeller(
        SellerId.of(sellerId),
        undefined,
        new Date('2020-12-31'),
      )
      // Apenas a entrada de 2018 deve aparecer
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((r) => r.date <= new Date('2020-12-31'))).toBe(true)
    })
  })

  // ── findByAccount() ──────────────────────────────────────────────────────────

  describe('findByAccount()', () => {
    it('retorna linhas para o account_code correto — isolado por data', async () => {
      const sellerId  = await insertSeller()
      const entryDate = new Date('2015-07-20')
      await insertLedgerEntry(sellerId, entryDate)
      await queryRepo.refreshView()

      const rows = await queryRepo.findByAccount(
        AccountCode.RECEIVABLE_GATEWAY,
        new Date('2015-07-01'),
        new Date('2015-07-31'),
      )

      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((r) => r.accountCode === AccountCode.RECEIVABLE_GATEWAY)).toBe(true)
    })

    it('retorna array vazio quando não há entradas no intervalo de datas', async () => {
      const rows = await queryRepo.findByAccount(
        AccountCode.EXPENSE_CHARGEBACK_LOSS,
        new Date('2000-01-01'),
        new Date('2000-12-31'),
      )
      // Ano 2000 — sem dados nesse range isolado
      expect(rows).toHaveLength(0)
    })

    it('inclui sellerId e accountType na linha retornada', async () => {
      const sellerId  = await insertSeller()
      const entryDate = new Date('2014-11-10')
      await insertLedgerEntry(sellerId, entryDate)
      await queryRepo.refreshView()

      const rows = await queryRepo.findByAccount(
        AccountCode.REVENUE_PLATFORM,
        new Date('2014-11-01'),
        new Date('2014-11-30'),
      )

      const row = rows.find((r) => r.sellerId === sellerId)
      expect(row).toBeDefined()
      expect(row?.accountType).toBe('REVENUE')
      expect(row?.totalCredits).toBe(1_500)
    })
  })
})
