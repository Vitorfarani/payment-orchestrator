import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('payments', (t) => {
    t.uuid('id').primary()                      // gerado pelo domínio (PaymentId)
    t.uuid('seller_id').notNullable().references('id').inTable('sellers')
    t.bigInteger('amount_cents').notNullable()
    t.text('currency').notNullable().defaultTo('BRL')
    t.text('status').notNullable().defaultTo('PENDING')
    t.text('idempotency_key').notNullable().unique()

    // Gateway
    t.text('gateway')                           // 'STRIPE' | 'ASAAS' — nullable até processamento
    t.text('gateway_payment_id')                // ID externo retornado pelo gateway
    t.jsonb('gateway_response')                 // resposta bruta — para auditoria e debugging
    t.jsonb('metadata')                         // dados extras do caller (order_id, etc.)

    // Erros
    t.text('error_code')
    t.text('error_message')

    // Timestamps de transição de estado
    t.timestamp('authorized_at', { useTz: true })
    t.timestamp('captured_at', { useTz: true })
    t.timestamp('refunded_at', { useTz: true })
    t.timestamp('failed_at', { useTz: true })

    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })

  // Constraints via raw para usar TEXT + CHECK (ADR-016)
  await knex.raw(`
    ALTER TABLE payments
      ADD CONSTRAINT payments_amount_cents_check
        CHECK (amount_cents > 0),
      ADD CONSTRAINT payments_currency_check
        CHECK (currency = 'BRL'),
      ADD CONSTRAINT payments_status_check
        CHECK (status IN (
          'PENDING','PROCESSING','REQUIRES_ACTION','AUTHORIZED','CAPTURED',
          'SETTLED','REFUNDED','PARTIALLY_REFUNDED','FAILED','CANCELLED',
          'DISPUTED','CHARGEBACK_WON','CHARGEBACK_LOST'
        )),
      ADD CONSTRAINT payments_gateway_check
        CHECK (gateway IN ('STRIPE','ASAAS'))
  `)

  // Índice na FK — PostgreSQL NÃO cria automaticamente (crítico para performance)
  await knex.raw('CREATE INDEX idx_payments_seller_id ON payments (seller_id)')

  // Índices de suporte para queries operacionais frequentes
  await knex.raw('CREATE INDEX idx_payments_seller_status ON payments (seller_id, status)')
  await knex.raw('CREATE INDEX idx_payments_gateway_payment_id ON payments (gateway_payment_id) WHERE gateway_payment_id IS NOT NULL')

  await knex.raw(`
    CREATE TRIGGER trg_payments_updated_at
      BEFORE UPDATE ON payments
      FOR EACH ROW EXECUTE FUNCTION set_updated_at()
  `)
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TRIGGER IF EXISTS trg_payments_updated_at ON payments')
  await knex.schema.dropTableIfExists('payments')
}
