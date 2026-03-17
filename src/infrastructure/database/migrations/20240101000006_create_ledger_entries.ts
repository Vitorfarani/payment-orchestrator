import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('ledger_entries', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
    t.uuid('journal_entry_id').notNullable().references('id').inTable('journal_entries')
    t.text('account_code').notNullable().references('code').inTable('accounts')
    t.text('entry_type').notNullable()
    t.bigInteger('amount_cents').notNullable()
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })

  await knex.raw(`
    ALTER TABLE ledger_entries
      ADD CONSTRAINT ledger_entries_entry_type_check
        CHECK (entry_type IN ('DEBIT','CREDIT')),
      ADD CONSTRAINT ledger_entries_amount_cents_check
        CHECK (amount_cents > 0)
  `)

  // Índice na FK — crítico para queries de ledger por journal_entry
  await knex.raw('CREATE INDEX idx_ledger_entries_journal_id ON ledger_entries (journal_entry_id)')

  // Índice para queries por conta contábil (relatórios por account_code)
  await knex.raw('CREATE INDEX idx_ledger_entries_account_code ON ledger_entries (account_code)')

  // ── Trigger DEFERRABLE INITIALLY DEFERRED (ADR-016) ──────────────────────────
  // Valida o invariante de double-entry no COMMIT, não linha a linha.
  // Isso permite inserir DEBIT e CREDIT na mesma transação sem falhar no meio.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION verify_journal_entry_balance()
    RETURNS TRIGGER AS $$
    DECLARE
      v_debit_sum  BIGINT;
      v_credit_sum BIGINT;
    BEGIN
      SELECT
        COALESCE(SUM(CASE WHEN entry_type = 'DEBIT'  THEN amount_cents ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN entry_type = 'CREDIT' THEN amount_cents ELSE 0 END), 0)
      INTO v_debit_sum, v_credit_sum
      FROM ledger_entries
      WHERE journal_entry_id = NEW.journal_entry_id;

      IF v_debit_sum != v_credit_sum THEN
        RAISE EXCEPTION
          'Journal entry % is unbalanced: debits=% credits=% net=%',
          NEW.journal_entry_id,
          v_debit_sum,
          v_credit_sum,
          (v_debit_sum - v_credit_sum);
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `)

  await knex.raw(`
    CREATE CONSTRAINT TRIGGER trg_verify_journal_balance
      AFTER INSERT ON ledger_entries
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION verify_journal_entry_balance()
  `)
}

export async function down(knex: Knex): Promise<void> {
  // Ordem obrigatória: trigger → função → tabela
  await knex.raw('DROP TRIGGER IF EXISTS trg_verify_journal_balance ON ledger_entries')
  await knex.raw('DROP FUNCTION IF EXISTS verify_journal_entry_balance()')
  await knex.schema.dropTableIfExists('ledger_entries')
}
