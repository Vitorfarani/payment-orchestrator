import type { IOutboxRepository } from '../../../src/domain/outbox/IOutboxRepository'
import type { OutboxEvent } from '../../../src/domain/outbox/OutboxEvent'

export class InMemoryOutboxRepository implements IOutboxRepository {
  private readonly store: OutboxEvent[] = []

  save(event: OutboxEvent): Promise<void> {
    this.store.push(event)
    return Promise.resolve()
  }

  findUnprocessedBatch(limit: number): Promise<OutboxEvent[]> {
    return Promise.resolve(this.store.filter((e) => !e.processed).slice(0, limit))
  }

  markProcessed(_id: string, _processedAt: Date): Promise<void> {
    return Promise.resolve()
  }

  recordFailure(_id: string, _error: string): Promise<void> {
    return Promise.resolve()
  }

  /** Helpers de teste */
  all(): OutboxEvent[]                      { return [...this.store] }
  ofType(eventType: string): OutboxEvent[]  { return this.store.filter((e) => e.eventType === eventType) }
  count(): number                           { return this.store.length }
}
