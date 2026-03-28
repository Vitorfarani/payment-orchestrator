import type { ISettlementRepository } from '../../../src/domain/settlement/ISettlementRepository'
import type { PaymentId, SellerId, SettlementItemId } from '../../../src/domain/shared/types'
import type { SettlementItem, SettlementStatus } from '../../../src/domain/settlement/SettlementItem'

export class InMemorySettlementRepository implements ISettlementRepository {
  private readonly store = new Map<string, SettlementItem>()

  save(item: SettlementItem): Promise<void> {
    this.store.set(item.id, item)
    return Promise.resolve()
  }

  update(item: SettlementItem): Promise<void> {
    this.store.set(item.id, item)
    return Promise.resolve()
  }

  findById(id: SettlementItemId): Promise<SettlementItem | null> {
    return Promise.resolve(this.store.get(id) ?? null)
  }

  findByPaymentId(paymentId: PaymentId): Promise<SettlementItem | null> {
    for (const item of this.store.values()) {
      if (item.paymentId === paymentId) return Promise.resolve(item)
    }
    return Promise.resolve(null)
  }

  findDueItems(asOf: Date): Promise<SettlementItem[]> {
    const result = [...this.store.values()].filter(
      (item) => item.status === 'PENDING' && item.scheduledDate <= asOf,
    )
    return Promise.resolve(result)
  }

  /** Em memória não há lock real — semântica equivalente ao findById para testes de unidade. */
  findByIdForUpdate(id: SettlementItemId): Promise<SettlementItem | null> {
    return this.findById(id)
  }

  findBySellerAndStatus(sellerId: SellerId, status: SettlementStatus): Promise<SettlementItem[]> {
    const result = [...this.store.values()].filter(
      (item) => item.sellerId === sellerId && item.status === status,
    )
    return Promise.resolve(result)
  }

  /** Helpers de teste */
  all(): SettlementItem[] { return [...this.store.values()] }
  count(): number         { return this.store.size }
}
