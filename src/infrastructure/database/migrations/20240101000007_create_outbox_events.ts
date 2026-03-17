import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('outbox_events', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
    t.text('event_type').notNullable()           // ex: 'PaymentCaptured', 'SettlementScheduled'
    t.text('aggregate_type').notNullable()        // 'Payment' | 'Settlement' — para o relay saber qual handler chamar
    t.uuid('aggregate_id').notNullable()          // id da entidade origem — permite replay por entidade
    t.jsonb('payload').notNullable()
    t.boolean('processed').notNullable().defaultTo(false)
    t.integer('retry_count').notNullable().defaultTo(0)
    t.text('error')                               // último erro de processamento — nullable
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    t.timestamp('processed_at', { useTz: true })  // nullable — preenchido ao marcar processed=true
  })

  // Índice parcial para o OutboxRelay (SELECT FOR UPDATE SKIP LOCKED)
  // Sem CONCURRENTLY — não funciona dentro de transação de migration
  await knex.raw(`
    CREATE INDEX idx_outbox_unprocessed
      ON outbox_events (created_at)
      WHERE processed = false
  `)

  // Índice para lookup por entidade — debug, replay manual, reconciliação
  await knex.raw(`
    CREATE INDEX idx_outbox_aggregate
      ON outbox_events (aggregate_type, aggregate_id)
  `)
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('outbox_events')
}
