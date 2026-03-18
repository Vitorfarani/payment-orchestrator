import { UnrecoverableError } from 'bullmq'
import type { Job } from 'bullmq'
import type { Logger } from 'pino'
import type { IUnitOfWork } from '../../../application/shared/IUnitOfWork'
import type { ISettlementRepository } from '../../../domain/settlement/ISettlementRepository'
import type { SettlementItemId } from '../../../domain/shared/types'
import { SettlementItem } from '../../../domain/settlement/SettlementItem'
import { SettlementScheduler } from '../../../domain/settlement/SettlementSchedule'
import { OutboxEvent } from '../../../domain/outbox/OutboxEvent'
import { PaymentId, SellerId, Cents } from '../../../domain/shared/types'

export interface SettlementWorkerOptions {
  /** Unit of Work para escritas atômicas. */
  readonly uow:            IUnitOfWork
  /**
   * Repositório de settlement para verificação de idempotência e `findDueItems`.
   * Injetado sem transação — operações de leitura antes do UoW.
   */
  readonly settlementRepo: ISettlementRepository
  readonly logger:         Logger
}

/**
 * Worker com dois papéis (ADR-011):
 *
 * 1. `process(job)` — consome eventos PAYMENT_CAPTURED do BullMQ.
 *    Cria um SettlementItem com status PENDING e scheduledDate calculada
 *    via SettlementScheduler (D+14 padrão). Idempotente — pula se já
 *    existe settlement para o paymentId.
 *
 * 2. `processDue(asOf)` — chamado pelo cron às 06:00 UTC.
 *    Busca todos os itens com scheduledDate <= asOf e status PENDING.
 *    Cada item é processado em sua própria UoW — falha de um não
 *    afeta os demais (ADR-012). Transiciona PENDING → PROCESSING → COMPLETED
 *    e emite OutboxEvent SETTLEMENT_COMPLETED para o LedgerWorker registrar
 *    a liquidação no ledger.
 *
 * Configurado com `settlementBackoffStrategy` (3 tentativas, 30-40s — ADR-012).
 */
export class SettlementWorker {
  constructor(private readonly opts: SettlementWorkerOptions) {}

  /**
   * Cria um SettlementItem para o pagamento capturado.
   * Chamado quando o OutboxRelay publica um evento PAYMENT_CAPTURED.
   */
  async process(job: Job<Record<string, unknown>>): Promise<void> {
    // ── Validação do payload ─────────────────────────────────────────────────

    const paymentIdRaw  = job.data['paymentId']
    const sellerIdRaw   = job.data['sellerId']
    const sellerRaw     = job.data['sellerAmountCents']
    const capturedAtRaw = job.data['capturedAt']

    if (typeof paymentIdRaw !== 'string') {
      this.opts.logger.error(
        { service: 'SettlementWorker', jobId: job.id },
        'Invalid job data: paymentId must be a string',
      )
      return
    }

    if (typeof sellerIdRaw !== 'string') {
      this.opts.logger.error(
        { service: 'SettlementWorker', jobId: job.id },
        'Invalid job data: sellerId must be a string',
      )
      return
    }

    if (typeof sellerRaw !== 'number') {
      this.opts.logger.error(
        { service: 'SettlementWorker', jobId: job.id },
        'Invalid job data: sellerAmountCents must be a number',
      )
      return
    }

    // ── Idempotência — ANTES de abrir UoW ───────────────────────────────────

    const paymentId = PaymentId.of(paymentIdRaw)
    const existing  = await this.opts.settlementRepo.findByPaymentId(paymentId)
    if (existing !== null) {
      this.opts.logger.info(
        { service: 'SettlementWorker', paymentId: paymentIdRaw },
        'Settlement already exists for payment — skipping (idempotent)',
      )
      return
    }

    // ── Calcular data de liquidação ──────────────────────────────────────────

    const capturedAt    = typeof capturedAtRaw === 'string' ? new Date(capturedAtRaw) : new Date()
    const scheduledDate = SettlementScheduler.calculatePayoutDate(capturedAt)

    // ── UoW: criar SettlementItem ────────────────────────────────────────────

    await this.opts.uow.run(async (repos) => {
      const itemResult = SettlementItem.create({
        paymentId,
        sellerId:      SellerId.of(sellerIdRaw),
        amountCents:   Cents.of(sellerRaw),
        scheduledDate,
      })

      if (!itemResult.ok) {
        // Dados inválidos (ex: amount ≤ 0) nunca se resolvem com retry
        throw new UnrecoverableError(itemResult.error.message)
      }

      await repos.settlements.save(itemResult.value)

      this.opts.logger.info(
        {
          service:       'SettlementWorker',
          paymentId:     paymentIdRaw,
          sellerId:      sellerIdRaw,
          amountCents:   sellerRaw,
          scheduledDate: scheduledDate.toISOString(),
        },
        'Settlement item created',
      )
    })
  }

  /**
   * Processa itens de liquidação vencidos.
   * Chamado pelo cron às 06:00 UTC via BullMQ repeatable job.
   *
   * Cada item é processado em UoW própria para que a falha de um
   * não comprometa o processamento dos demais (ADR-012).
   */
  async processDue(asOf: Date = new Date()): Promise<void> {
    const items = await this.opts.settlementRepo.findDueItems(asOf)

    this.opts.logger.info(
      { service: 'SettlementWorker', count: items.length, asOf: asOf.toISOString() },
      'Processing due settlement items',
    )

    for (const item of items) {
      await this.processSingleItem(item.id)
    }
  }

  private async processSingleItem(itemId: SettlementItemId): Promise<void> {
    try {
      await this.opts.uow.run(async (repos) => {
        // SELECT FOR UPDATE — garante que apenas um worker processa este item
        const locked = await repos.settlements.findByIdForUpdate(itemId)

        if (locked === null) {
          this.opts.logger.warn(
            { service: 'SettlementWorker', itemId },
            'Settlement item not found during lock — skipping',
          )
          return
        }

        // Outra instância pode ter chegado primeiro
        if (locked.status !== 'PENDING') {
          this.opts.logger.info(
            { service: 'SettlementWorker', itemId, status: locked.status },
            'Settlement item not in PENDING state — skipping',
          )
          return
        }

        // PENDING → PROCESSING
        const processingResult = locked.startProcessing()
        if (!processingResult.ok) throw processingResult.error

        // PROCESSING → COMPLETED
        // Fase 4: conclusão simulada. Fase 5 adicionará a chamada real ao gateway.
        const completedResult = processingResult.value.complete()
        if (!completedResult.ok) throw completedResult.error

        await repos.settlements.update(completedResult.value)

        // Outbox Pattern: evento emitido atomicamente com o UPDATE (ADR-009)
        await repos.outbox.save(OutboxEvent.create({
          eventType:     'SETTLEMENT_COMPLETED',
          aggregateId:   itemId,
          aggregateType: 'SettlementItem',
          payload: {
            settlementItemId: itemId,
            paymentId:        locked.paymentId,
            sellerId:         locked.sellerId,
            amountCents:      locked.amountCents,
          },
        }))

        this.opts.logger.info(
          {
            service:   'SettlementWorker',
            itemId,
            paymentId: locked.paymentId,
            sellerId:  locked.sellerId,
          },
          'Settlement item completed',
        )
      })
    } catch (error) {
      // Falha isolada — loga e segue para o próximo item
      // O item fica PENDING e será reprocessado no próximo ciclo do cron
      this.opts.logger.error(
        { service: 'SettlementWorker', itemId, error },
        'Failed to process settlement item — will retry on next cron run',
      )
    }
  }
}
