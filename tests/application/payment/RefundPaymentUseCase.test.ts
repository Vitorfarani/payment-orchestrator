import { RefundPaymentUseCase }           from '../../../src/application/payment/RefundPaymentUseCase'
import { InMemoryUnitOfWork }             from '../fakes/InMemoryUnitOfWork'
import { InMemorySplitRuleRepository }    from '../fakes/InMemorySplitRuleRepository'
import { Payment }                        from '../../../src/domain/payment/Payment'
import { SplitRule }                      from '../../../src/domain/split/SplitRule'
import { PaymentId, SellerId, Cents, IdempotencyKey, SplitRuleId, CommissionRate } from '../../../src/domain/shared/types'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PAYMENT_ID = '11111111-1111-4111-8111-111111111111'
const SELLER_ID  = '22222222-2222-4222-8222-222222222222'
const RULE_ID    = '33333333-3333-4333-8333-333333333333'

function makePayment(status = 'CAPTURED' as Parameters<typeof Payment.reconstitute>[0]['status']) {
  return Payment.reconstitute({
    id:             PaymentId.of(PAYMENT_ID),
    sellerId:       SellerId.of(SELLER_ID),
    amount:         Cents.of(10_000),
    idempotencyKey: IdempotencyKey.of('idem-key-abc-1234'),
    status,
    createdAt:      new Date(),
    updatedAt:      new Date(),
  })
}

function makeSplitRule(rate = 0.10) {
  return SplitRule.create({
    id:             SplitRuleId.of(RULE_ID),
    sellerId:       SellerId.of(SELLER_ID),
    commissionRate: CommissionRate.of(rate),
  })
}

function makeSetup(paymentStatus = 'CAPTURED' as Parameters<typeof makePayment>[0]) {
  const uow           = new InMemoryUnitOfWork()
  const splitRuleRepo = new InMemorySplitRuleRepository()
  const payment       = makePayment(paymentStatus)
  const rule          = makeSplitRule()

  // Pré-carrega o payment no repo in-memory (simula que já está no banco)
  void uow.payments.save(payment)
  void splitRuleRepo.save(rule)

  const useCase = new RefundPaymentUseCase(uow, splitRuleRepo)
  return { uow, splitRuleRepo, useCase }
}

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('RefundPaymentUseCase', () => {
  describe('estorno total (refundAmountCents omitido)', () => {
    it('transiciona para REFUNDED e emite PAYMENT_REFUNDED', async () => {
      const { uow, useCase } = makeSetup('CAPTURED')

      const result = await useCase.execute({
        paymentId: PaymentId.of(PAYMENT_ID),
      })

      expect(result.ok).toBe(true)
      if (!result.ok) return

      expect(result.value.refundAmountCents).toBe(Cents.of(10_000))

      // Payment atualizado no repositório
      const updated = await uow.payments.findById(PaymentId.of(PAYMENT_ID))
      expect(updated?.status).toBe('REFUNDED')

      // OutboxEvent emitido
      const events = uow.outbox.ofType('PAYMENT_REFUNDED')
      expect(events).toHaveLength(1)
      expect(events[0]?.payload['paymentId']).toBe(PAYMENT_ID)
    })

    it('funciona a partir de SETTLED', async () => {
      const { useCase } = makeSetup('SETTLED')
      const result = await useCase.execute({ paymentId: PaymentId.of(PAYMENT_ID) })
      expect(result.ok).toBe(true)
    })
  })

  describe('estorno parcial', () => {
    it('transiciona para PARTIALLY_REFUNDED quando refund < total', async () => {
      const { uow, useCase } = makeSetup('CAPTURED')

      const result = await useCase.execute({
        paymentId:         PaymentId.of(PAYMENT_ID),
        refundAmountCents: Cents.of(4_000),
      })

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.refundAmountCents).toBe(Cents.of(4_000))

      const updated = await uow.payments.findById(PaymentId.of(PAYMENT_ID))
      expect(updated?.status).toBe('PARTIALLY_REFUNDED')
    })

    it('de PARTIALLY_REFUNDED sempre vai para REFUNDED', async () => {
      const { uow, useCase } = makeSetup('PARTIALLY_REFUNDED')

      const result = await useCase.execute({
        paymentId:         PaymentId.of(PAYMENT_ID),
        refundAmountCents: Cents.of(4_000),
      })

      expect(result.ok).toBe(true)
      const updated = await uow.payments.findById(PaymentId.of(PAYMENT_ID))
      expect(updated?.status).toBe('REFUNDED')
    })
  })

  describe('split proporcional do estorno', () => {
    it('calcula platform = floor(refund × rate) e seller = remainder (invariante §5.3)', async () => {
      const { useCase } = makeSetup('CAPTURED')  // rate = 10%

      const result = await useCase.execute({
        paymentId:         PaymentId.of(PAYMENT_ID),
        refundAmountCents: Cents.of(3_333),  // 333.3 platform → floor = 333, seller = 3000
      })

      expect(result.ok).toBe(true)
      if (!result.ok) return

      expect(result.value.platformRefund).toBe(Cents.of(333))
      expect(result.value.sellerRefund).toBe(Cents.of(3_000))
      // Invariante: platform + seller === total
      expect(result.value.platformRefund + result.value.sellerRefund).toBe(result.value.refundAmountCents)
    })
  })

  describe('erros', () => {
    it('retorna NotFoundError se o payment não existe', async () => {
      const uow           = new InMemoryUnitOfWork()  // repo vazio
      const splitRuleRepo = new InMemorySplitRuleRepository()
      const useCase       = new RefundPaymentUseCase(uow, splitRuleRepo)

      const result = await useCase.execute({ paymentId: PaymentId.of(PAYMENT_ID) })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.code).toBe('NOT_FOUND')
    })

    it('retorna BusinessRuleError se refund > payment.amount', async () => {
      const { useCase } = makeSetup('CAPTURED')

      const result = await useCase.execute({
        paymentId:         PaymentId.of(PAYMENT_ID),
        refundAmountCents: Cents.of(10_001),  // maior que 10_000
      })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.code).toBe('BUSINESS_RULE_ERROR')
    })

    it('retorna BusinessRuleError se não há split rule ativa', async () => {
      const uow     = new InMemoryUnitOfWork()
      const useCase = new RefundPaymentUseCase(uow, new InMemorySplitRuleRepository())
      await uow.payments.save(makePayment('CAPTURED'))

      const result = await useCase.execute({ paymentId: PaymentId.of(PAYMENT_ID) })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.code).toBe('BUSINESS_RULE_ERROR')
    })

    it('retorna BusinessRuleError em transição inválida (ex: PENDING → REFUNDED)', async () => {
      const { useCase } = makeSetup('PENDING')

      const result = await useCase.execute({ paymentId: PaymentId.of(PAYMENT_ID) })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.code).toBe('BUSINESS_RULE_ERROR')
    })

    it('não emite outbox event quando retorna erro', async () => {
      const { uow, useCase } = makeSetup('CAPTURED')

      await useCase.execute({
        paymentId:         PaymentId.of(PAYMENT_ID),
        refundAmountCents: Cents.of(99_999),
      })

      expect(uow.outbox.count()).toBe(0)
    })
  })
})
