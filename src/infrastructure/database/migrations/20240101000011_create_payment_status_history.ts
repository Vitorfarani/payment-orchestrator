import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('payment_status_history', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
    t.uuid('payment_id').notNullable().references('id').inTable('payments')
    t.text('from_status')                         // NULL = transição inicial (PENDING não tem estado anterior)
    t.text('to_status').notNullable()
    t.timestamp('occurred_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    t.jsonb('metadata')                           // contexto extra: gateway_event_id, reason, etc.
  })

  // Índice composto cobre: "todo o histórico de um pagamento ordenado por tempo"
  // Essa é a query dominante nessa tabela
  await knex.raw(`
    CREATE INDEX idx_status_history_payment_id
      ON payment_status_history (payment_id, occurred_at)
  `)
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('payment_status_history')
}
