import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('settlement_items', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
    t.uuid('payment_id').notNullable().references('id').inTable('payments')
    t.uuid('seller_id').notNullable().references('id').inTable('sellers')
    t.bigInteger('amount_cents').notNullable()
    t.date('scheduled_date').notNullable()        // data programada para o repasse
    t.text('status').notNullable().defaultTo('PENDING')
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })

  await knex.raw(`
    ALTER TABLE settlement_items
      ADD CONSTRAINT settlement_items_amount_cents_check
        CHECK (amount_cents > 0),
      ADD CONSTRAINT settlement_items_status_check
        CHECK (status IN ('PENDING','PROCESSING','COMPLETED','FAILED'))
  `)

  // FK indexes — PostgreSQL não auto-indexa (crítico para queries de settlement por seller/payment)
  await knex.raw('CREATE INDEX idx_settlement_items_payment_id ON settlement_items (payment_id)')
  await knex.raw('CREATE INDEX idx_settlement_items_seller_id ON settlement_items (seller_id)')

  // Índice parcial para o SettlementWorker — só itens pendentes ordenados por data
  await knex.raw(`
    CREATE INDEX idx_settlement_pending
      ON settlement_items (scheduled_date)
      WHERE status = 'PENDING'
  `)

  await knex.raw(`
    CREATE TRIGGER trg_settlement_items_updated_at
      BEFORE UPDATE ON settlement_items
      FOR EACH ROW EXECUTE FUNCTION set_updated_at()
  `)
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TRIGGER IF EXISTS trg_settlement_items_updated_at ON settlement_items')
  await knex.schema.dropTableIfExists('settlement_items')
}
