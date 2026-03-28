import type { IIdempotencyStore, IdempotencyRecord } from '../../../src/application/shared/IIdempotencyStore'
import type { IdempotencyKey } from '../../../src/domain/shared/types'

export class InMemoryIdempotencyStore implements IIdempotencyStore {
  private readonly store = new Map<string, IdempotencyRecord>()

  tryAcquire(key: IdempotencyKey): Promise<
    | { isNew: true }
    | { isNew: false; record: IdempotencyRecord }
  > {
    const existing = this.store.get(key)
    if (existing !== undefined) {
      return Promise.resolve({ isNew: false, record: existing })
    }

    const record: IdempotencyRecord = {
      key,
      status:       'PROCESSING',
      statusCode:   null,
      responseBody: null,
      createdAt:    new Date(),
      expiresAt:    new Date(Date.now() + 86_400_000),
    }
    this.store.set(key, record)
    return Promise.resolve({ isNew: true })
  }

  complete(key: IdempotencyKey, statusCode: number, responseBody: unknown): Promise<void> {
    const existing = this.store.get(key)
    if (existing !== undefined) {
      this.store.set(key, { ...existing, status: 'COMPLETED', statusCode, responseBody })
    }
    return Promise.resolve()
  }

  fail(key: IdempotencyKey): Promise<void> {
    this.store.delete(key)
    return Promise.resolve()
  }

  /** Helpers de teste */
  get(key: IdempotencyKey): IdempotencyRecord | undefined { return this.store.get(key) }
  size(): number { return this.store.size }
}
