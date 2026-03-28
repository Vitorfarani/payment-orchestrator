import type { IUnitOfWork } from '../shared/IUnitOfWork'
import type { Result } from '../../domain/shared/Result'
import type { DomainError } from '../../domain/shared/errors'
import type { SettlementItemId } from '../../domain/shared/types'
import { ok, err } from '../../domain/shared/Result'
import { NotFoundError } from '../../domain/shared/errors'
import { OutboxEvent } from '../../domain/outbox/OutboxEvent'

export interface ProcessSettlementInput {
  readonly settlementItemId: SettlementItemId
}

export interface ProcessSettlementOutput {
  readonly settlementItemId: SettlementItemId
}

/**
 * Processa um item de liquidação pendente (ADR-011).
 *
 * Chamado pelo SettlementWorker para cada item com scheduledDate <= hoje.
 *
 * Fluxo:
 *   1. SELECT FOR UPDATE — garante que apenas um worker processa este item
 *   2. Verifica que o item está PENDING (idempotência)
 *   3. PENDING → PROCESSING → COMPLETED
 *   4. Persiste item atualizado + OutboxEvent(SETTLEMENT_COMPLETED) atomicamente
 *
 * Retry em caso de falha: o item permanece PENDING e o cron do dia seguinte
 * encontra e reprocessa (business-rules §9.5).
 */
export class ProcessSettlementUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  async execute(
    input: ProcessSettlementInput,
  ): Promise<Result<ProcessSettlementOutput, DomainError>> {
    return this.uow.run(async (repos) => {
      // 1. SELECT FOR UPDATE — evita processamento duplicado sob múltiplas instâncias
      const item = await repos.settlements.findByIdForUpdate(input.settlementItemId)
      if (item === null) {
        return err(new NotFoundError('SettlementItem', input.settlementItemId))
      }

      // 2. Idempotência: se não está PENDING, já foi processado — retorna ok
      if (item.status !== 'PENDING') {
        return ok({ settlementItemId: item.id })
      }

      // 3. PENDING → PROCESSING
      const processingResult = item.startProcessing()
      if (!processingResult.ok) return processingResult

      // 4. PROCESSING → COMPLETED
      const completedResult = processingResult.value.complete()
      if (!completedResult.ok) return completedResult

      const completed = completedResult.value

      await repos.settlements.update(completed)

      // 5. Outbox Pattern — evento emitido atomicamente com o UPDATE
      await repos.outbox.save(OutboxEvent.create({
        eventType:     'SETTLEMENT_COMPLETED',
        aggregateId:   completed.id,
        aggregateType: 'SettlementItem',
        payload: {
          settlementItemId: completed.id,
          paymentId:        completed.paymentId,
          sellerId:         completed.sellerId,
          amountCents:      completed.amountCents,
        },
      }))

      return ok({ settlementItemId: completed.id })
    })
  }
}
