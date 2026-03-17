import type { JournalEntryId, PaymentId } from '../shared/types'
import type { JournalEntry } from './JournalEntry'

/**
 * Contrato do repositório de entradas contábeis.
 *
 * JournalEntry é imutável por design (ADR-010):
 * apenas save() é exposto — nunca update() ou delete().
 * Erros contábeis são corrigidos com reversing entries.
 */
export interface IJournalEntryRepository {
  /**
   * Persiste uma nova entrada contábil (INSERT apenas).
   * Deve ser chamado dentro de uma transação que também persiste o OutboxEvent.
   */
  save(entry: JournalEntry): Promise<void>

  findById(id: JournalEntryId): Promise<JournalEntry | null>

  findByPaymentId(paymentId: PaymentId): Promise<JournalEntry[]>

  /**
   * Verifica se este outbox event já gerou uma JournalEntry.
   * Garante idempotência no consumo at-least-once pelo LedgerWorker (ADR-009).
   * Requer coluna source_event_id em journal_entries — migration 013.
   */
  existsByOutboxEventId(outboxEventId: string): Promise<boolean>
}
