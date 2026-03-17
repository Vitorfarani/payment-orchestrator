import type { Knex } from 'knex'

/**
 * Adiciona source_event_id em journal_entries para idempotência do LedgerWorker.
 *
 * Contexto (ADR-009):
 * O Outbox Pattern garante entrega at-least-once — o mesmo evento pode ser
 * publicado mais de uma vez. O LedgerWorker precisa detectar e ignorar
 * reprocessamentos para não criar JournalEntries duplicadas.
 *
 * Mecanismo:
 * Antes de criar uma JournalEntry, o LedgerWorker chama
 * IJournalEntryRepository.existsByOutboxEventId(outboxEventId).
 * Se já existe, retorna sucesso sem reprocessar.
 *
 * Design:
 * - Nullable para compatibilidade retroativa (entradas antigas não têm source_event_id)
 * - Sem FK para outbox_events: eventos processados são deletados após 30 dias,
 *   mas JournalEntries são imutáveis por 7 anos (ADR-018). FK criaria conflito.
 * - Índice parcial único (WHERE IS NOT NULL): garante que cada outbox event
 *   gera no máximo 1 JournalEntry sem afetar entradas antigas (source_event_id = NULL).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('journal_entries', (t) => {
    t.uuid('source_event_id').nullable()
  })

  // Índice parcial — sem CONCURRENTLY (não funciona dentro de transação de migration)
  await knex.raw(`
    CREATE UNIQUE INDEX idx_journal_entries_source_event_id
      ON journal_entries (source_event_id)
      WHERE source_event_id IS NOT NULL
  `)
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS idx_journal_entries_source_event_id')
  await knex.schema.alterTable('journal_entries', (t) => {
    t.dropColumn('source_event_id')
  })
}
