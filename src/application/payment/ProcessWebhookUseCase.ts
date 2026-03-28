import type { IUnitOfWork } from '../shared/IUnitOfWork'
import type { Result } from '../../domain/shared/Result'
import type { DomainError } from '../../domain/shared/errors'
import type { PaymentId } from '../../domain/shared/types'
import type { PaymentStatus } from '../../domain/payment/value-objects/PaymentStatus'
import { ok, err } from '../../domain/shared/Result'
import { NotFoundError } from '../../domain/shared/errors'
import { OutboxEvent } from '../../domain/outbox/OutboxEvent'

export interface ProcessWebhookInput {
  /**
   * ID único do evento no gateway (ex: `evt_1234` no Stripe).
   * Usado para idempotência: o mesmo eventId pode chegar mais de uma vez (at-least-once).
   */
  readonly eventId:  string
  readonly paymentId: PaymentId
  /** Status alvo conforme mapeado pelo WebhookController a partir do payload do gateway. */
  readonly newStatus: PaymentStatus
  /** Metadados adicionais passados para payment.transition() (ex: errorCode, reason). */
  readonly metadata?: Record<string, unknown>
}

export interface ProcessWebhookOutput {
  readonly paymentId:    PaymentId
  readonly previousStatus: PaymentStatus
  readonly newStatus:    PaymentStatus
  /** true se o evento já havia sido processado — resposta idempotente. */
  readonly idempotent:   boolean
}

/**
 * Processa um evento de webhook do gateway de pagamento (ADR-002, ADR-003).
 *
 * A validação de HMAC é responsabilidade da camada web (Phase 6).
 * Este use case assume que o webhook já foi autenticado pelo middleware.
 *
 * Fluxo:
 *   1. SELECT FOR UPDATE — race condition: webhook pode chegar antes da resposta
 *      síncrona do PaymentWorker (business-rules §4.3)
 *   2. Idempotência por estado: se o pagamento já está no estado alvo, retorna ok
 *   3. Transiciona o estado via payment.transition()
 *   4. Persiste payment atualizado + OutboxEvent atomicamente
 *
 * Idempotência: baseada no estado atual do pagamento, não no eventId.
 * Se o pagamento já está no estado alvo (ex: dois webhooks AUTHORIZED), retorna ok.
 * A transição de volta (ex: CAPTURED → AUTHORIZED) é rejeitada pela state machine.
 */
export class ProcessWebhookUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  async execute(
    input: ProcessWebhookInput,
  ): Promise<Result<ProcessWebhookOutput, DomainError>> {
    return this.uow.run(async (repos) => {
      // 1. SELECT FOR UPDATE — garante exclusividade contra PaymentWorker concorrente
      const payment = await repos.payments.findByIdForUpdate(input.paymentId)
      if (payment === null) {
        return err(new NotFoundError('Payment', input.paymentId))
      }

      const previousStatus = payment.status

      // 2. Idempotência: já está no estado alvo → resposta idempotente sem escrita
      if (payment.status === input.newStatus) {
        return ok({
          paymentId:      payment.id,
          previousStatus,
          newStatus:      input.newStatus,
          idempotent:     true,
        })
      }

      // 3. Tenta a transição — state machine rejeita transições inválidas
      const transitionResult = payment.transition(
        input.newStatus,
        ...(input.metadata !== undefined ? [input.metadata] : []),
      )
      if (!transitionResult.ok) return transitionResult

      // 4. Persiste payment e emite outbox event
      await repos.payments.update(payment)
      await repos.outbox.save(OutboxEvent.create({
        eventType:     `PAYMENT_${input.newStatus}`,
        aggregateId:   payment.id,
        aggregateType: 'Payment',
        payload: {
          paymentId:  payment.id,
          eventId:    input.eventId,
          newStatus:  input.newStatus,
          ...(input.metadata !== undefined && { metadata: input.metadata }),
        },
      }))

      return ok({
        paymentId:      payment.id,
        previousStatus,
        newStatus:      input.newStatus,
        idempotent:     false,
      })
    })
  }
}
