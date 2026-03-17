import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('journal_entries', (t) => {
    t.uuid('id').primary()                     // gerado pelo domínio (JournalEntryId)
    t.uuid('payment_id').notNullable().references('id').inTable('payments')
    t.text('description').notNullable()        // ex: 'PaymentCaptured', 'Refund'
    t.timestamp('occurred_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    // occurred_at ≠ created_at: occurred_at = quando o evento de negócio aconteceu
    // Permite registros retroativos (ex: estorno de data anterior)
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })

  // Índice na FK — obrigatório (ADR-016, PostgreSQL não auto-indexa FKs)
  await knex.raw('CREATE INDEX idx_journal_entries_payment_id ON journal_entries (payment_id)')
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('journal_entries')
}
