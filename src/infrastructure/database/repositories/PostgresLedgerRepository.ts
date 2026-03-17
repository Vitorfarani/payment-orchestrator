import type { Knex } from 'knex'
import type { IJournalEntryRepository } from '../../../domain/ledger/IJournalEntryRepository'
import { JournalEntry, type ReconstituteJournalEntryInput, type JournalLine } from '../../../domain/ledger/JournalEntry'
import type { AccountCode } from '../../../domain/ledger/value-objects/AccountCode'
import { Cents, JournalEntryId, PaymentId } from '../../../domain/shared/types'

interface JournalEntryRow {
  id:              string
  payment_id:      string
  description:     string
  occurred_at:     Date
  created_at:      Date
  source_event_id: string | null
}

interface LedgerEntryRow {
  id:               string
  journal_entry_id: string
  account_code:     AccountCode
  entry_type:       'DEBIT' | 'CREDIT'
  amount_cents:     string   // BIGINT → node-postgres retorna string
  created_at:       Date
}

function ledgerRowToLine(row: LedgerEntryRow): JournalLine {
  return {
    accountCode: row.account_code,
    type:        row.entry_type,
    amount:      Cents.of(Number(row.amount_cents)),
  }
}

function rowsToEntry(
  entryRow: JournalEntryRow,
  lineRows: readonly LedgerEntryRow[],
): JournalEntry {
  const input: ReconstituteJournalEntryInput = {
    id:          JournalEntryId.of(entryRow.id),
    paymentId:   PaymentId.of(entryRow.payment_id),
    lines:       lineRows.map(ledgerRowToLine),
    description: entryRow.description,
    occurredAt:  entryRow.occurred_at,
    createdAt:   entryRow.created_at,
    ...(entryRow.source_event_id !== null && { sourceEventId: entryRow.source_event_id }),
  }
  return JournalEntry.reconstitute(input)
}

/**
 * Implementação PostgreSQL do IJournalEntryRepository.
 *
 * JournalEntry é imutável por design (ADR-010) — apenas save() e leituras.
 * O save() insere na journal_entries E na ledger_entries na mesma transação
 * (garantida pelo KnexUnitOfWork que injeta o db já escopado à trx).
 *
 * O DEFERRABLE INITIALLY DEFERRED trigger valida o invariante debit=credit
 * no COMMIT — permite inserir todas as linhas antes da validação.
 */
export class PostgresLedgerRepository implements IJournalEntryRepository {
  constructor(private readonly db: Knex) {}

  async save(entry: JournalEntry): Promise<void> {
    await this.db('journal_entries').insert({
      id:          entry.id,
      payment_id:  entry.paymentId,
      description: entry.description,
      occurred_at: entry.occurredAt,
      created_at:  entry.createdAt,
      ...(entry.sourceEventId !== undefined && { source_event_id: entry.sourceEventId }),
    })

    const lineRows = entry.lines.map(line => ({
      journal_entry_id: entry.id,
      account_code:     line.accountCode,
      entry_type:       line.type,
      amount_cents:     line.amount,
    }))
    await this.db('ledger_entries').insert(lineRows)
  }

  async findById(id: JournalEntryId): Promise<JournalEntry | null> {
    const entryRow = await this.db<JournalEntryRow>('journal_entries').where({ id }).first()
    if (!entryRow) return null
    const lineRows = await this.db<LedgerEntryRow>('ledger_entries').where({ journal_entry_id: id })
    return rowsToEntry(entryRow, lineRows)
  }

  async findByPaymentId(paymentId: PaymentId): Promise<JournalEntry[]> {
    const entryRows = await this.db<JournalEntryRow>('journal_entries').where({ payment_id: paymentId })
    if (entryRows.length === 0) return []

    const entryIds = entryRows.map(r => r.id)
    const lineRows = await this.db<LedgerEntryRow>('ledger_entries').whereIn('journal_entry_id', entryIds)

    return entryRows.map(entryRow => {
      const lines = lineRows.filter(l => l.journal_entry_id === entryRow.id)
      return rowsToEntry(entryRow, lines)
    })
  }

  async existsByOutboxEventId(outboxEventId: string): Promise<boolean> {
    const row = await this.db<JournalEntryRow>('journal_entries')
      .where({ source_event_id: outboxEventId })
      .select('id')
      .first()
    return row !== undefined
  }
}
