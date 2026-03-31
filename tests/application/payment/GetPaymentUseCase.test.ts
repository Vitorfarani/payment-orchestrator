import { GetPaymentUseCase } from '../../../src/application/payment/GetPaymentUseCase'
import { InMemoryPaymentRepository } from '../fakes/InMemoryPaymentRepository'
import { Payment } from '../../../src/domain/payment/Payment'
import { PaymentId, SellerId, Cents, IdempotencyKey } from '../../../src/domain/shared/types'
import { NotFoundError } from '../../../src/domain/shared/errors'

function makePayment(): Payment {
  const result = Payment.create({
    id:             PaymentId.create(),
    sellerId:       SellerId.create(),
    amount:         Cents.of(5000),
    idempotencyKey: IdempotencyKey.generate(),
  })
  if (!result.ok) throw new Error('Failed to create payment in test')
  return result.value
}

describe('GetPaymentUseCase', () => {
  let repo: InMemoryPaymentRepository
  let useCase: GetPaymentUseCase

  beforeEach(() => {
    repo    = new InMemoryPaymentRepository()
    useCase = new GetPaymentUseCase(repo)
  })

  it('returns payment output when payment exists', async () => {
    const payment = makePayment()
    await repo.save(payment)

    const result = await useCase.execute({ paymentId: payment.id })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.id).toBe(payment.id)
    expect(result.value.sellerId).toBe(payment.sellerId)
    expect(result.value.amountCents).toBe(payment.amount)
    expect(result.value.status).toBe('PENDING')
    expect(result.value.createdAt).toBeInstanceOf(Date)
    expect(result.value.updatedAt).toBeInstanceOf(Date)
  })

  it('returns NotFoundError when payment does not exist', async () => {
    const result = await useCase.execute({ paymentId: PaymentId.create() })

    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.error).toBeInstanceOf(NotFoundError)
    expect(result.error.code).toBe('NOT_FOUND')
  })

  it('maps optional fields when present', async () => {
    const payment = makePayment()
    payment.transition('PROCESSING')
    payment.transition('AUTHORIZED')
    payment.transition('CAPTURED')
    await repo.save(payment)

    const result = await useCase.execute({ paymentId: payment.id })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.capturedAt).toBeInstanceOf(Date)
    expect(result.value.errorCode).toBeUndefined()
    expect(result.value.refundedAt).toBeUndefined()
  })

  it('maps errorCode when payment is FAILED', async () => {
    const payment = makePayment()
    payment.transition('PROCESSING')
    payment.transition('FAILED', { errorCode: 'CARD_DECLINED', errorMessage: 'Card declined' })
    await repo.save(payment)

    const result = await useCase.execute({ paymentId: payment.id })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.status).toBe('FAILED')
    expect(result.value.errorCode).toBe('CARD_DECLINED')
  })
})
