import type { IPaymentRepository } from '../../domain/payment/IPaymentRepository'
import type { Result } from '../../domain/shared/Result'
import type { PaymentId, SellerId, Cents } from '../../domain/shared/types'
import type { PaymentStatus } from '../../domain/payment/value-objects/PaymentStatus'
import { err, ok } from '../../domain/shared/Result'
import { NotFoundError } from '../../domain/shared/errors'

export interface GetPaymentInput {
  readonly paymentId: PaymentId
}

export interface GetPaymentOutput {
  readonly id:          PaymentId
  readonly sellerId:    SellerId
  readonly amountCents: Cents
  readonly status:      PaymentStatus
  readonly createdAt:   Date
  readonly updatedAt:   Date
  readonly errorCode?:  string
  readonly capturedAt?: Date
  readonly refundedAt?: Date
}

/**
 * Query pura — lê um pagamento pelo ID sem UoW.
 *
 * Injetado: IPaymentRepository diretamente (sem IUnitOfWork — leitura).
 * Retorna Result<GetPaymentOutput, NotFoundError>.
 */
export class GetPaymentUseCase {
  constructor(private readonly payments: IPaymentRepository) {}

  async execute(input: GetPaymentInput): Promise<Result<GetPaymentOutput, NotFoundError>> {
    const payment = await this.payments.findById(input.paymentId)

    if (payment === null) {
      return err(new NotFoundError('Payment', input.paymentId))
    }

    const output: GetPaymentOutput = {
      id:          payment.id,
      sellerId:    payment.sellerId,
      amountCents: payment.amount,
      status:      payment.status,
      createdAt:   payment.createdAt,
      updatedAt:   payment.updatedAt,
      ...(payment.errorCode  !== undefined && { errorCode:  payment.errorCode }),
      ...(payment.capturedAt !== undefined && { capturedAt: payment.capturedAt }),
      ...(payment.refundedAt !== undefined && { refundedAt: payment.refundedAt }),
    }

    return ok(output)
  }
}
