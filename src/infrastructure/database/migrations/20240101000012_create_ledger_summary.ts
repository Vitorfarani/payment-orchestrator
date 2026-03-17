import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  // ── MATERIALIZED VIEW — read model do CQRS (ADR-007) ─────────────────────────
  // Separação write model (normalizado) vs read model (pré-agregado para o dashboard).
  // Atualizada via REFRESH MATERIALIZED VIEW CONCURRENTLY pelo LedgerWorker após
  // cada JournalEntry processada — nunca em tempo real para não bloquear writes.
  await knex.raw(`
    CREATE MATERIALIZED VIEW ledger_summary AS
    SELECT
      p.seller_id,
      date_trunc('day', le.created_at)::DATE            AS date,
      a.type                                             AS account_type,
      a.code                                             AS account_code,
      SUM(CASE WHEN le.entry_type = 'DEBIT'
               THEN le.amount_cents ELSE 0 END)          AS total_debits,
      SUM(CASE WHEN le.entry_type = 'CREDIT'
               THEN le.amount_cents ELSE 0 END)          AS total_credits,
      COUNT(*)                                           AS entry_count
    FROM ledger_entries le
    JOIN journal_entries je ON le.journal_entry_id = je.id
    JOIN payments        p  ON je.payment_id        = p.id
    JOIN accounts        a  ON le.account_code      = a.code
    GROUP BY
      p.seller_id,
      date_trunc('day', le.created_at)::DATE,
      a.type,
      a.code
  `)

  // UNIQUE INDEX obrigatório para REFRESH MATERIALIZED VIEW CONCURRENTLY
  // (o CONCURRENTLY permite refresh sem lock exclusivo — leitura continua durante o refresh)
  // Sem CONCURRENTLY aqui: CREATE INDEX CONCURRENTLY não funciona em transação
  await knex.raw(`
    CREATE UNIQUE INDEX idx_ledger_summary
      ON ledger_summary (seller_id, date, account_code)
  `)
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP MATERIALIZED VIEW IF EXISTS ledger_summary')
}
