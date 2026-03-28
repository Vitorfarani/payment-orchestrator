import type { IJournalEntryRepository } from '../../../src/domain/ledger/IJournalEntryRepository'
import type { JournalEntryId, PaymentId } from '../../../src/domain/shared/types'
import type { JournalEntry } from '../../../src/domain/ledger/JournalEntry'

export class InMemoryJournalEntryRepository implements IJournalEntryRepository {
  private readonly store = new Map<string, JournalEntry>()

  save(entry: JournalEntry): Promise<void> {
    this.store.set(entry.id, entry)
    return Promise.resolve()
  }

  findById(id: JournalEntryId): Promise<JournalEntry | null> {
    return Promise.resolve(this.store.get(id) ?? null)
  }

  findByPaymentId(paymentId: PaymentId): Promise<JournalEntry[]> {
    return Promise.resolve([...this.store.values()].filter((e) => e.paymentId === paymentId))
  }

  existsByOutboxEventId(outboxEventId: string): Promise<boolean> {
    for (const entry of this.store.values()) {
      if (entry.sourceEventId === outboxEventId) return Promise.resolve(true)
    }
    return Promise.resolve(false)
  }

  /** Helpers de teste */
  all(): JournalEntry[] { return [...this.store.values()] }
  count(): number       { return this.store.size }
}
