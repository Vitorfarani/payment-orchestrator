import { GenericContainer, Wait } from 'testcontainers'
import type { StartedTestContainer } from 'testcontainers'
import Knex from 'knex'
import type { Knex as KnexType } from 'knex'
import path from 'path'

// ──────────────────────────────────────────────────────────────────────────────
// Integration tests — PostgreSQL real via Testcontainers (GenericContainer)
//
// O que testamos:
//   1. Trigger DEFERRABLE rejeita double-entry desbalanceada no COMMIT
//   2. Trigger aceita JournalEntry balanceada (DEBIT = CREDIT)
//   3. Migration 004 seed: as 7 contas do Chart of Accounts existem com tipos certos
//   4. audit_logs: INSERT ok, registro persistido
//
// Para rodar: npm run test:int  (--runInBand é obrigatório — um container por suite)
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
      directory: path.resolve(__dirname, 'migrations'),
      loadExtensions: ['.ts'],
    },
  })

  await db.migrate.latest()
}, 120_000) // 2 min — pull da imagem Docker pode demorar na primeira execução

afterAll(async () => {
  await db.destroy()
  await container.stop()
})

// ── Helpers para inserção de fixtures ─────────────────────────────────────────

async function insertSeller(): Promise<string> {
  const rows = await db('sellers')
    .insert({ name: 'Seller Teste', document: `doc-${Date.now()}`, email: `s${Date.now()}@test.com` })
    .returning('id') as Array<{ id: string }>
  return rows[0].id
}

async function insertPayment(sellerId: string): Promise<string> {
  const rows = await db('payments')
    .insert({
      id:               db.raw('gen_random_uuid()'),
      seller_id:        sellerId,
      amount_cents:     10000,
      idempotency_key:  `idem-${Date.now()}-${Math.random()}`,
    })
    .returning('id') as Array<{ id: string }>
  return rows[0].id
}

async function insertJournalEntry(paymentId: string): Promise<string> {
  const rows = await db('journal_entries')
    .insert({
      id:          db.raw('gen_random_uuid()'),
      payment_id:  paymentId,
      description: 'PaymentCaptured',
    })
    .returning('id') as Array<{ id: string }>
  return rows[0].id
}

// ── Testes ────────────────────────────────────────────────────────────────────

describe('migrations', () => {
  describe('trigger: double-entry balance (ADR-016)', () => {
    it('rejeita JournalEntry desbalanceada no COMMIT', async () => {
      const sellerId  = await insertSeller()
      const paymentId = await insertPayment(sellerId)
      const journalId = await insertJournalEntry(paymentId)

      // Apenas DEBIT sem CREDIT — trigger DEFERRABLE dispara no COMMIT, não na inserção
      await expect(
        db.transaction(async (trx) => {
          await trx('ledger_entries').insert({
            journal_entry_id: journalId,
            account_code:     '1001',
            entry_type:       'DEBIT',
            amount_cents:     1000,
          })
        }),
      ).rejects.toThrow(/unbalanced/)
    })

    it('aceita JournalEntry balanceada (soma débitos = soma créditos)', async () => {
      const sellerId  = await insertSeller()
      const paymentId = await insertPayment(sellerId)
      const journalId = await insertJournalEntry(paymentId)

      // R$100,00 capturado: gateway recebe, plataforma fica com R$15, vendedor com R$85
      await expect(
        db.transaction(async (trx) => {
          await trx('ledger_entries').insert([
            { journal_entry_id: journalId, account_code: '1001', entry_type: 'DEBIT',  amount_cents: 10000 },
            { journal_entry_id: journalId, account_code: '3001', entry_type: 'CREDIT', amount_cents: 1500  },
            { journal_entry_id: journalId, account_code: '2001', entry_type: 'CREDIT', amount_cents: 8500  },
          ])
        }),
      ).resolves.not.toThrow()
    })
  })

  describe('migration 004: chart of accounts seed (ADR-010)', () => {
    it('todas as 7 contas existem com os códigos corretos', async () => {
      const rows = await db('accounts').select('code').orderBy('code') as Array<{ code: string }>
      const codes = rows.map((r) => r.code)

      expect(codes).toEqual(['1001', '2001', '2002', '3001', '3002', '4001', '4002'])
    })

    it('tipos contábeis das contas estão corretos', async () => {
      const rows = await db('accounts').select('code', 'type').orderBy('code') as Array<{ code: string; type: string }>
      const byCode = Object.fromEntries(rows.map((r) => [r.code, r.type]))

      expect(byCode['1001']).toBe('ASSET')
      expect(byCode['2001']).toBe('LIABILITY')
      expect(byCode['2002']).toBe('LIABILITY')
      expect(byCode['3001']).toBe('REVENUE')
      expect(byCode['3002']).toBe('REVENUE')
      expect(byCode['4001']).toBe('EXPENSE')
      expect(byCode['4002']).toBe('EXPENSE')
    })
  })

  describe('audit_logs: imutabilidade via RBAC (ADR-018)', () => {
    it('INSERT em audit_logs funciona', async () => {
      await expect(
        db('audit_logs').insert({
          actor_id:      'system',
          actor_type:    'system',
          action:        'payment.created',
          resource_type: 'Payment',
          resource_id:   'test-payment-id',
        }),
      ).resolves.not.toThrow()
    })

    it('registro inserido é recuperável', async () => {
      const resourceId = `audit-test-${Date.now()}`

      await db('audit_logs').insert({
        actor_id:      'worker-01',
        actor_type:    'worker',
        action:        'settlement.processed',
        resource_type: 'Settlement',
        resource_id:   resourceId,
      })

      const rows = await db('audit_logs')
        .where({ resource_id: resourceId })
        .select('action') as Array<{ action: string }>

      expect(rows).toHaveLength(1)
      expect(rows[0].action).toBe('settlement.processed')
    })
  })
})
