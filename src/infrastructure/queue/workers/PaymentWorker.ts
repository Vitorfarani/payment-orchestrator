import type { Job } from 'bullmq'
import type { Logger } from 'pino'
import type { IUnitOfWork } from '../../../application/shared/IUnitOfWork'
import type { IPaymentGateway } from '../../../domain/payment/IPaymentGateway'
import { PaymentId } from '../../../domain/shared/types'
import { OutboxEvent } from '../../../domain/outbox/OutboxEvent'

export interface PaymentWorkerOptions {
  readonly uow:         IUnitOfWork
  readonly gateway:     IPaymentGateway
  /** Nome do gateway injetado em `setGatewayInfo` — ex: 'stripe', 'asaas'. */
  readonly gatewayName: string
  readonly logger:      Logger
}

/**
 * Worker que processa jobs do tipo PAYMENT_CREATED (ADR-003, ADR-009).
 *
 * Fluxo por job:
 *   1. SELECT FOR UPDATE no pagamento — evita race condition com outros workers
 *   2. Idempotência — se já está em estado final, retorna silencioso
 *   3. Chama gateway.authorize() → gateway.capture() de forma síncrona
 *   4. Salva Payment atualizado + OutboxEvent em uma única transação (Outbox Pattern)
 *
 * Tratamento de erros:
 *   - CIRCUIT_OPEN → lança erro para BullMQ fazer retry automático (sem persistência)
 *   - Erro terminal (cartão recusado, etc.) → transiciona para FAILED e salva atomicamente
 *   - Exceção de infraestrutura → propaga; BullMQ retenta via backoff exponencial
 *
 * Estados atômicos: AUTHORIZED nunca é persistido isolado.
 * Se capture falha, o pagamento vai PROCESSING → FAILED (AUTHORIZED → FAILED é inválido
 * na state machine — ADR-004).
 *
 * Registrado com `defaultBackoffStrategy` (5 tentativas, cap 60s — ADR-012).
 */
export class PaymentWorker {
  constructor(private readonly opts: PaymentWorkerOptions) {}

  async process(job: Job<Record<string, unknown>>): Promise<void> {
    const paymentIdRaw = job.data['paymentId']

    if (typeof paymentIdRaw !== 'string') {
      this.opts.logger.error(
        { service: 'PaymentWorker', jobId: job.id },
        'Invalid job data: paymentId must be a string',
      )
      return
    }

    const paymentId = PaymentId.of(paymentIdRaw)

    await this.opts.uow.run(async (repos) => {
      const payment = await repos.payments.findByIdForUpdate(paymentId)

      if (payment === null) {
        this.opts.logger.warn(
          { service: 'PaymentWorker', paymentId },
          'Payment not found — skipping job',
        )
        return
      }

      // Idempotência: qualquer estado além de PENDING/PROCESSING significa que
      // este worker já concluiu (ou outro processo tomou conta do pagamento).
      if (payment.status !== 'PENDING' && payment.status !== 'PROCESSING') {
        this.opts.logger.info(
          { service: 'PaymentWorker', paymentId, status: payment.status },
          'Payment already in terminal state — skipping',
        )
        return
      }

      // Primeiro passo da state machine: PENDING → PROCESSING
      if (payment.status === 'PENDING') {
        const r = payment.transition('PROCESSING')
        if (!r.ok) throw r.error
      }

      // ─── Authorize ─────────────────────────────────────────────────────────

      const authResult = await this.opts.gateway.authorize({
        paymentId:      payment.id,
        idempotencyKey: payment.idempotencyKey,
        amount:         payment.amount,
        currency:       'BRL',
      })

      if (!authResult.ok) {
        // Circuit aberto → sem persistência; BullMQ retenta após backoff
        if (authResult.error.code === 'CIRCUIT_OPEN') throw authResult.error

        // Falha terminal de negócio → PROCESSING → FAILED
        const failResult = payment.transition('FAILED', {
          errorCode:    authResult.error.code,
          errorMessage: authResult.error.message,
        })
        if (!failResult.ok) throw failResult.error

        await repos.payments.update(payment)
        await repos.outbox.save(OutboxEvent.create({
          eventType:     'PAYMENT_FAILED',
          aggregateId:   payment.id,
          aggregateType: 'Payment',
          payload:       { paymentId: payment.id, reason: authResult.error.message },
        }))
        return
      }

      const { gatewayPaymentId, status: authStatus, gatewayResponse } = authResult.value
      payment.setGatewayInfo(this.opts.gatewayName, gatewayPaymentId, gatewayResponse)

      // 3DS / autenticação adicional → delega para webhook handler (ADR-003)
      if (authStatus === 'requires_action') {
        const r = payment.transition('REQUIRES_ACTION')
        if (!r.ok) throw r.error

        await repos.payments.update(payment)
        await repos.outbox.save(OutboxEvent.create({
          eventType:     'PAYMENT_REQUIRES_ACTION',
          aggregateId:   payment.id,
          aggregateType: 'Payment',
          payload:       { paymentId: payment.id, gatewayPaymentId },
        }))
        return
      }

      // ─── Capture ───────────────────────────────────────────────────────────

      const captureResult = await this.opts.gateway.capture({ gatewayPaymentId })

      if (!captureResult.ok) {
        // Circuit aberto → sem persistência; BullMQ retenta
        if (captureResult.error.code === 'CIRCUIT_OPEN') throw captureResult.error

        // Captura falhou terminalmente — pagamento vai de PROCESSING para FAILED
        // (AUTHORIZED nunca foi persistido, então AUTHORIZED → FAILED não ocorre — ADR-004)
        const failResult = payment.transition('FAILED', {
          errorCode:    captureResult.error.code,
          errorMessage: captureResult.error.message,
        })
        if (!failResult.ok) throw failResult.error

        await repos.payments.update(payment)
        await repos.outbox.save(OutboxEvent.create({
          eventType:     'PAYMENT_FAILED',
          aggregateId:   payment.id,
          aggregateType: 'Payment',
          payload:       { paymentId: payment.id, reason: captureResult.error.message },
        }))
        return
      }

      // ─── Sucesso — transição atômica PROCESSING → AUTHORIZED → CAPTURED ────
      // Ambas as transições em memória; uma única escrita no banco.

      const authTransResult = payment.transition('AUTHORIZED')
      if (!authTransResult.ok) throw authTransResult.error

      const captureTransResult = payment.transition('CAPTURED')
      if (!captureTransResult.ok) throw captureTransResult.error

      await repos.payments.update(payment)
      await repos.outbox.save(OutboxEvent.create({
        eventType:     'PAYMENT_CAPTURED',
        aggregateId:   payment.id,
        aggregateType: 'Payment',
        payload: {
          paymentId: payment.id,
          sellerId:  payment.sellerId,
          amount:    payment.amount,
        },
      }))

      this.opts.logger.info(
        { service: 'PaymentWorker', paymentId, gatewayPaymentId },
        'Payment captured successfully',
      )
    })
  }
}
