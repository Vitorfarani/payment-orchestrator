import type { ISplitRuleRepository } from '../../../src/domain/split/ISplitRuleRepository'
import type { SellerId, SplitRuleId } from '../../../src/domain/shared/types'
import type { SplitRule } from '../../../src/domain/split/SplitRule'

export class InMemorySplitRuleRepository implements ISplitRuleRepository {
  private readonly store = new Map<string, SplitRule>()

  save(rule: SplitRule): Promise<void> {
    this.store.set(rule.id, rule)
    return Promise.resolve()
  }

  findById(id: SplitRuleId): Promise<SplitRule | null> {
    return Promise.resolve(this.store.get(id) ?? null)
  }

  findActiveBySellerId(sellerId: SellerId): Promise<SplitRule | null> {
    for (const rule of this.store.values()) {
      if (rule.sellerId === sellerId && rule.active) return Promise.resolve(rule)
    }
    return Promise.resolve(null)
  }

  /** Helper de teste */
  all(): SplitRule[] { return [...this.store.values()] }
}
