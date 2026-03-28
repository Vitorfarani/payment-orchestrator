import type { IUnitOfWork } from '../shared/IUnitOfWork'
import type { Result } from '../../domain/shared/Result'
import type { ValidationError } from '../../domain/shared/errors'
import type { SellerId, Cents, IdempotencyKey, PaymentId } from '../../domain/shared/types'
import { ok } from '../../domain/shared/Result'
import { Payment } from '../../domain/payment/Payment'
import { PaymentId as PaymentIdConstructor } from '../../domain/shared/types'
import { OutboxEvent } from '../../domain/outbox/OutboxEvent'

export interface CreatePaymentInput {
  readonly sellerId:       SellerId
  readonly amountCents:    Cents
  readonly idempotencyKey: IdempotencyKey
  readonly metadata?:      Record<string, unknown>
}

export interface CreatePaymentOutput {
  readonly paymentId: PaymentId
}

/**
 * Cria um pagamento e enfileira o processamento via Outbox Pattern (ADR-003, ADR-009).
 *
 * Não chama o gateway — isso é responsabilidade do PaymentWorker.
 * Retorna imediatamente após persistir Payment + OutboxEvent na mesma transação.
 *
 * Fluxo:
 *   1. Valida os dados de entrada via Payment.create()
 *   2. Cria o OutboxEvent PAYMENT_CREATED
 *   3. Persiste Payment + OutboxEvent atomicamente via IUnitOfWork
 *   4. Retorna { paymentId }
 */
export class CreatePaymentUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  async execute(
    input: CreatePaymentInput,
  ): Promise<Result<CreatePaymentOutput, ValidationError>> {
    const paymentResult = Payment.create({
      id:             PaymentIdConstructor.create(),
      sellerId:       input.sellerId,
      amount:         input.amountCents,
      idempotencyKey: input.idempotencyKey,
      ...(input.metadata !== undefined && { metadata: input.metadata }),
    })

    if (!paymentResult.ok) return paymentResult

    const payment = paymentResult.value

    const outboxEvent = OutboxEvent.create({
      eventType:     'PAYMENT_CREATED',
      aggregateId:   payment.id,
      aggregateType: 'Payment',
      payload: {
        paymentId: payment.id,
      },
    })

    await this.uow.run(async (repos) => {
      await repos.payments.save(payment)
      await repos.outbox.save(outboxEvent)
    })

    return ok({ paymentId: payment.id })
  }
}
