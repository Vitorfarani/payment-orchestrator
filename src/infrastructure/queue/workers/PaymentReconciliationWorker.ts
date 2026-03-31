import { UnrecoverableError } from 'bullmq'
import type { Logger } from 'pino'

import type { IUnitOfWork } from '../../../application/shared/IUnitOfWork'
import type { IPaymentRepository } from '../../../domain/payment/IPaymentRepository'
import type { IPaymentGateway } from '../../../domain/payment/IPaymentGateway'
import type { ISplitRuleRepository } from '../../../domain/split/ISplitRuleRepository'
import type { Payment } from '../../../domain/payment/Payment'
import { SplitCalculator } from '../../../domain/split/SplitCalculator'
import { OutboxEvent } from '../../../domain/outbox/OutboxEvent'
import { PaymentId } from '../../../domain/shared/types'

/** Pagamentos em PROCESSING por mais de este tempo são considerados presos. */
const DEFAULT_STUCK_THRESHOLD_MS = 10 * 60 * 1000   // 10 minutos

export interface ReconciliationWorkerOptions {
  /** Repositório sem transação — usado apenas para a query inicial de discovery. */
  readonly paymentRepo:      IPaymentRepository
  readonly uow:              IUnitOfWork
  readonly gateway:          IPaymentGateway
  readonly splitRuleRepo:    ISplitRuleRepository
  readonly logger:           Logger
  readonly stuckThresholdMs?: number
}

/**
 * Worker de reconciliação que detecta e corrige pagamentos presos em PROCESSING.
 * Roda a cada 15 minutos via BullMQ repeatable job (ADR-003).
 *
 * Para cada pagamento PROCESSING há mais de `stuckThresholdMs` (padrão 10 min):
 *   - Sem `gatewayPaymentId` → o worker crashou antes de chamar o gateway
 *     → transiciona para FAILED com errorCode RECONCILIATION_NO_GATEWAY_ID
 *   - Com `gatewayPaymentId` → consulta `gateway.getStatus()` e reconcilia:
 *     - 'captured' / 'succeeded' / 'paid' → CAPTURED + split + PAYMENT_CAPTURED
 *     - 'failed' / 'declined'             → FAILED + PAYMENT_FAILED
 *     - 'cancelled' / 'canceled'          → CANCELLED + PAYMENT_CANCELLED
 *     - 'authorized' / 'requires_capture' → AUTHORIZED + PAYMENT_AUTHORIZED
 *     - 'requires_action'                 → REQUIRES_ACTION + PAYMENT_REQUIRES_ACTION
 *     - CIRCUIT_OPEN                      → pula (log warn), tenta no próximo ciclo
 *     - status desconhecido               → pula (log warn), tenta no próximo ciclo
 *
 * Cada pagamento é processado em UoW isolada — falha de um não
 * afeta os demais (ADR-012).
 */
export class PaymentReconciliationWorker {
  private readonly threshold: number

  constructor(private readonly opts: ReconciliationWorkerOptions) {
    this.threshold = opts.stuckThresholdMs ?? DEFAULT_STUCK_THRESHOLD_MS
  }

  async run(asOf: Date = new Date()): Promise<void> {
    const olderThan = new Date(asOf.getTime() - this.threshold)
    const stuck     = await this.opts.paymentRepo.findStuckInProcessing(olderThan)

    this.opts.logger.info(
      {
        service:    'PaymentReconciliationWorker',
        count:      stuck.length,
        olderThan:  olderThan.toISOString(),
      },
      'Starting reconciliation run',
    )

    for (const payment of stuck) {
      await this.reconcilePayment(payment)
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private async reconcilePayment(payment: Payment): Promise<void> {
    try {
      if (!payment.gatewayPaymentId) {
        await this.reconcileWithoutGatewayId(payment)
        return
      }

      const statusResult = await this.opts.gateway.getStatus({
        gatewayPaymentId: payment.gatewayPaymentId,
      })

      if (!statusResult.ok) {
        if (statusResult.error.code === 'CIRCUIT_OPEN') {
          this.opts.logger.warn(
            { service: 'PaymentReconciliationWorker', paymentId: payment.id },
            'Circuit open — skipping reconciliation, will retry on next run',
          )
          return
        }
        this.opts.logger.error(
          { service: 'PaymentReconciliationWorker', paymentId: payment.id, error: statusResult.error },
          'Gateway error during reconciliation — will retry on next run',
        )
        return
      }

      await this.applyGatewayStatus(payment, statusResult.value.status)
    } catch (error) {
      // UnrecoverableError indica situação que requer intervenção manual (ex: split rule ausente).
      // Deve propagar para o BullMQ mover para DLQ — não engolir.
      if (error instanceof UnrecoverableError) throw error

      this.opts.logger.error(
        { service: 'PaymentReconciliationWorker', paymentId: payment.id, error },
        'Unexpected error reconciling payment — will retry on next run',
      )
    }
  }

  private async reconcileWithoutGatewayId(payment: Payment): Promise<void> {
    this.opts.logger.warn(
      { service: 'PaymentReconciliationWorker', paymentId: payment.id },
      'Payment stuck in PROCESSING with no gatewayPaymentId — marking FAILED',
    )

    await this.opts.uow.run(async (repos) => {
      const locked = await repos.payments.findByIdForUpdate(PaymentId.of(payment.id))
      if (locked === null || locked.status !== 'PROCESSING') return

      const r = locked.transition('FAILED', {
        errorCode:    'RECONCILIATION_NO_GATEWAY_ID',
        errorMessage: 'Payment stuck in PROCESSING with no gateway ID — reconciliation forced FAILED',
      })
      if (!r.ok) throw r.error

      await repos.payments.update(locked)
      await repos.outbox.save(OutboxEvent.create({
        eventType:     'PAYMENT_FAILED',
        aggregateId:   locked.id,
        aggregateType: 'Payment',
        payload:       { paymentId: locked.id, reason: 'RECONCILIATION_NO_GATEWAY_ID' },
      }))
    })
  }

  private async applyGatewayStatus(payment: Payment, gwStatus: string): Promise<void> {
    const s = gwStatus.toLowerCase()

    if (s === 'captured' || s === 'succeeded' || s === 'paid') {
      await this.reconcileCaptured(payment)
      return
    }
    if (s === 'failed' || s === 'declined') {
      await this.reconcileTerminal(payment, 'FAILED', {
        errorCode:    'GATEWAY_PAYMENT_FAILED',
        errorMessage: `Gateway status: ${gwStatus}`,
      })
      return
    }
    if (s === 'cancelled' || s === 'canceled') {
      await this.reconcileTerminal(payment, 'CANCELLED')
      return
    }
    if (s === 'authorized' || s === 'requires_capture') {
      await this.reconcileSingleTransition(payment, 'AUTHORIZED', 'PAYMENT_AUTHORIZED', {
        paymentId: payment.id,
      })
      return
    }
    if (s === 'requires_action' || s === 'pending_authentication') {
      await this.reconcileSingleTransition(payment, 'REQUIRES_ACTION', 'PAYMENT_REQUIRES_ACTION', {
        paymentId:        payment.id,
        gatewayPaymentId: payment.gatewayPaymentId,
      })
      return
    }

    this.opts.logger.warn(
      { service: 'PaymentReconciliationWorker', paymentId: payment.id, gwStatus },
      'Unknown gateway status — leaving payment in PROCESSING for next run',
    )
  }

  private async reconcileCaptured(payment: Payment): Promise<void> {
    const splitRule = await this.opts.splitRuleRepo.findActiveBySellerId(payment.sellerId)

    if (splitRule === null) {
      throw new UnrecoverableError(
        `No active split rule for seller ${payment.sellerId}. ` +
        `Payment ${payment.id} appears captured on gateway — manual intervention required.`,
      )
    }

    const splitResult = SplitCalculator.calculate(payment.amount, splitRule.commissionRate)
    if (!splitResult.ok) throw splitResult.error

    const { platform: platformAmountCents, seller: sellerAmountCents } = splitResult.value

    await this.opts.uow.run(async (repos) => {
      const locked = await repos.payments.findByIdForUpdate(PaymentId.of(payment.id))
      if (locked === null || locked.status !== 'PROCESSING') return

      // PROCESSING → AUTHORIZED → CAPTURED em memória; uma única escrita no banco
      const authR = locked.transition('AUTHORIZED')
      if (!authR.ok) throw authR.error

      const capR = locked.transition('CAPTURED')
      if (!capR.ok) throw capR.error

      await repos.payments.update(locked)
      await repos.outbox.save(OutboxEvent.create({
        eventType:     'PAYMENT_CAPTURED',
        aggregateId:   locked.id,
        aggregateType: 'Payment',
        payload: {
          paymentId:           locked.id,
          sellerId:            locked.sellerId,
          amount:              locked.amount,
          platformAmountCents,
          sellerAmountCents,
        },
      }))
    })

    this.opts.logger.info(
      {
        service:             'PaymentReconciliationWorker',
        paymentId:           payment.id,
        platformAmountCents,
        sellerAmountCents,
      },
      'Payment reconciled as CAPTURED',
    )
  }

  private async reconcileTerminal(
    payment:   Payment,
    target:    'FAILED' | 'CANCELLED',
    errorInfo?: { errorCode: string; errorMessage: string },
  ): Promise<void> {
    await this.opts.uow.run(async (repos) => {
      const locked = await repos.payments.findByIdForUpdate(PaymentId.of(payment.id))
      if (locked === null || locked.status !== 'PROCESSING') return

      const r = locked.transition(target, errorInfo)
      if (!r.ok) throw r.error

      await repos.payments.update(locked)
      await repos.outbox.save(OutboxEvent.create({
        eventType:     target === 'FAILED' ? 'PAYMENT_FAILED' : 'PAYMENT_CANCELLED',
        aggregateId:   locked.id,
        aggregateType: 'Payment',
        payload:       { paymentId: locked.id },
      }))
    })

    this.opts.logger.info(
      { service: 'PaymentReconciliationWorker', paymentId: payment.id, target },
      'Payment reconciled to terminal state',
    )
  }

  private async reconcileSingleTransition(
    payment:   Payment,
    target:    'AUTHORIZED' | 'REQUIRES_ACTION',
    eventType: string,
    payload:   Record<string, unknown>,
  ): Promise<void> {
    await this.opts.uow.run(async (repos) => {
      const locked = await repos.payments.findByIdForUpdate(PaymentId.of(payment.id))
      if (locked === null || locked.status !== 'PROCESSING') return

      const r = locked.transition(target)
      if (!r.ok) throw r.error

      await repos.payments.update(locked)
      await repos.outbox.save(OutboxEvent.create({
        eventType,
        aggregateId:   locked.id,
        aggregateType: 'Payment',
        payload,
      }))
    })
  }
}
