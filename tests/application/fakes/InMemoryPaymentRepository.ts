import type { IPaymentRepository } from '../../../src/domain/payment/IPaymentRepository'
import type { PaymentId, SellerId, IdempotencyKey } from '../../../src/domain/shared/types'
import type { Payment } from '../../../src/domain/payment/Payment'
import type { PaymentStatus } from '../../../src/domain/payment/value-objects/PaymentStatus'

export class InMemoryPaymentRepository implements IPaymentRepository {
  private readonly store = new Map<string, Payment>()

  save(payment: Payment): Promise<void> {
    this.store.set(payment.id, payment)
    return Promise.resolve()
  }

  update(payment: Payment): Promise<void> {
    this.store.set(payment.id, payment)
    return Promise.resolve()
  }

  findById(id: PaymentId): Promise<Payment | null> {
    return Promise.resolve(this.store.get(id) ?? null)
  }

  /** Em memória não há lock real — semântica equivalente ao findById para testes de unidade. */
  findByIdForUpdate(id: PaymentId): Promise<Payment | null> {
    return this.findById(id)
  }

  findByIdempotencyKey(key: IdempotencyKey): Promise<Payment | null> {
    for (const payment of this.store.values()) {
      if (payment.idempotencyKey === key) return Promise.resolve(payment)
    }
    return Promise.resolve(null)
  }

  findBySellerAndStatus(sellerId: SellerId, status: PaymentStatus): Promise<Payment[]> {
    const result = [...this.store.values()].filter(
      (p) => p.sellerId === sellerId && p.status === status,
    )
    return Promise.resolve(result)
  }

  /** Helpers de teste */
  all(): Payment[] { return [...this.store.values()] }
  count(): number  { return this.store.size }
}
