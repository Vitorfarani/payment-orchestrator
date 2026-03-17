import type { Knex } from 'knex'

interface AccountRow {
  readonly code: string
  readonly name: string
  readonly type: string
}

// Plano de contas fixo (ADR-010) — 7 contas, não altere sem um ADR aprovado
const CHART_OF_ACCOUNTS: readonly AccountRow[] = [
  { code: '1001', name: 'Receivable Gateway',     type: 'ASSET'     },
  { code: '2001', name: 'Payable Seller',          type: 'LIABILITY' },
  { code: '2002', name: 'Payable Refund',          type: 'LIABILITY' },
  { code: '3001', name: 'Revenue Platform',        type: 'REVENUE'   },
  { code: '3002', name: 'Revenue Chargeback Fee',  type: 'REVENUE'   },
  { code: '4001', name: 'Expense Chargeback Loss', type: 'EXPENSE'   },
  { code: '4002', name: 'Expense Gateway Fee',     type: 'EXPENSE'   },
]

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('accounts', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
    t.text('code').notNullable().unique()
    t.text('name').notNullable()
    t.text('type').notNullable()
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })

  await knex.raw(`
    ALTER TABLE accounts
      ADD CONSTRAINT accounts_type_check
        CHECK (type IN ('ASSET','LIABILITY','REVENUE','EXPENSE'))
  `)

  // Seed das 7 contas é parte do schema — não é dado de teste (ADR-010)
  await knex('accounts').insert([...CHART_OF_ACCOUNTS])
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('accounts')
}
