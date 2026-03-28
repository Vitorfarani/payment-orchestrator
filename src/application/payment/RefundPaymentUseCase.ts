import type { IUnitOfWork } from '../shared/IUnitOfWork'
import type { ISplitRuleRepository } from '../../domain/split/ISplitRuleRepository'
import type { Result } from '../../domain/shared/Result'
import type { DomainError } from '../../domain/shared/errors'
import type { PaymentId, Cents } from '../../domain/shared/types'
import { err, ok } from '../../domain/shared/Result'
import { BusinessRuleError, NotFoundError } from '../../domain/shared/errors'
import { SplitCalculator } from '../../domain/split/SplitCalculator'
import { OutboxEvent } from '../../domain/outbox/OutboxEvent'

export interface RefundPaymentInput {
  readonly paymentId:          PaymentId
  /**
   * Valor a estornar em centavos. `undefined` = estorno total.
   * Deve ser > 0 e ≤ payment.amount (ADR-006, business-rules §6.3).
   */
  readonly refundAmountCents?: Cents
}

export interface RefundPaymentOutput {
  readonly paymentId:         PaymentId
  readonly refundAmountCents: Cents
  readonly platformRefund:    Cents
  readonly sellerRefund:      Cents
}

/**
 * Inicia o processo de estorno de um pagamento (ADR-006).
 *
 * NÃO chama o gateway — isso é responsabilidade do PaymentWorker,
 * que escuta o evento PAYMENT_REFUNDED no Outbox.
 *
 * Fluxo:
 *   1. SELECT FOR UPDATE no payment — evita duplo estorno paralelo
 *   2. Valida valor máximo estornável (≤ payment.amount)
 *   3. Busca split rule ativa do seller para cálculo proporcional
 *   4. Calcula split do estorno via SplitCalculator (ADR-005)
 *   5. Transiciona o estado via payment.transition()
 *   6. Persiste payment atualizado + OutboxEvent(PAYMENT_REFUNDED) atomicamente
 */
export class RefundPaymentUseCase {
  constructor(
    private readonly uow:           IUnitOfWork,
    private readonly splitRuleRepo: ISplitRuleRepository,
  ) {}

  async execute(
    input: RefundPaymentInput,
  ): Promise<Result<RefundPaymentOutput, DomainError>> {
    return this.uow.run(async (repos) => {
      // 1. SELECT FOR UPDATE — evita race condition de duplo estorno paralelo
      const payment = await repos.payments.findByIdForUpdate(input.paymentId)
      if (payment === null) {
        return err(new NotFoundError('Payment', input.paymentId))
      }

      // 2. Valor do estorno: undefined = estorno total
      const refundAmount: Cents = input.refundAmountCents ?? payment.amount

      // 3. Validação do valor máximo (business-rules §6.3)
      if (refundAmount > payment.amount) {
        return err(new BusinessRuleError(
          `Valor de estorno (${refundAmount}) excede o valor do pagamento (${payment.amount})`
        ))
      }

      // 4. Busca a split rule ativa — necessária para cálculo proporcional do estorno
      const splitRule = await this.splitRuleRepo.findActiveBySellerId(payment.sellerId)
      if (splitRule === null) {
        return err(new BusinessRuleError(
          `Nenhuma split rule ativa para o seller ${payment.sellerId}`
        ))
      }

      // 5. Calcula split proporcional do estorno (business-rules §5.3)
      const splitResult = SplitCalculator.calculate(refundAmount, splitRule.commissionRate)
      if (!splitResult.ok) return splitResult

      const { platform: platformRefund, seller: sellerRefund } = splitResult.value

      // 6. Determina o status alvo:
      //    - De PARTIALLY_REFUNDED → sempre REFUNDED (v1 não suporta múltiplos parciais)
      //    - Estorno total (refund === amount) → REFUNDED
      //    - Estorno parcial → PARTIALLY_REFUNDED
      const isFullRefund = payment.status === 'PARTIALLY_REFUNDED' || refundAmount === payment.amount
      const newStatus    = isFullRefund ? 'REFUNDED' : 'PARTIALLY_REFUNDED'

      // 7. Transição de estado — state machine valida se a transição é permitida
      const transitionResult = payment.transition(newStatus, { refundAmount })
      if (!transitionResult.ok) return transitionResult

      // 8. OutboxEvent com split no payload — PaymentWorker chamará gateway.refund()
      await repos.payments.update(payment)
      await repos.outbox.save(OutboxEvent.create({
        eventType:     'PAYMENT_REFUNDED',
        aggregateId:   payment.id,
        aggregateType: 'Payment',
        payload: {
          paymentId:           payment.id,
          amount:              refundAmount,
          platformAmountCents: platformRefund,
          sellerAmountCents:   sellerRefund,
        },
      }))

      return ok({
        paymentId:         payment.id,
        refundAmountCents: refundAmount,
        platformRefund,
        sellerRefund,
      })
    })
  }
}
