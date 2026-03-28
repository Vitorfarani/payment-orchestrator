import type { IUnitOfWork } from '../shared/IUnitOfWork'
import type { ISettlementRepository } from '../../domain/settlement/ISettlementRepository'
import type { Result } from '../../domain/shared/Result'
import type { DomainError } from '../../domain/shared/errors'
import type { PaymentId, SellerId, Cents, SettlementItemId } from '../../domain/shared/types'
import { ok, err } from '../../domain/shared/Result'
import { ConflictError } from '../../domain/shared/errors'
import { SettlementItem } from '../../domain/settlement/SettlementItem'
import { SettlementScheduler } from '../../domain/settlement/SettlementSchedule'

export interface ScheduleSettlementInput {
  readonly paymentId:        PaymentId
  readonly sellerId:         SellerId
  /** Valor a ser repassado ao vendedor (sellerAmountCents do split). */
  readonly sellerAmountCents: Cents
  /** Momento da captura — base para calcular a data de liquidação. */
  readonly capturedAt:       Date
}

export interface ScheduleSettlementOutput {
  readonly settlementItemId: SettlementItemId
  readonly scheduledDate:    Date
}

/**
 * Agenda um item de liquidação para um pagamento capturado (ADR-011).
 *
 * Um pagamento gera exatamente um settlement item — UNIQUE(payment_id).
 * Tentativa de agendar duas vezes retorna ConflictError (business-rules §9.6).
 *
 * Idempotência verificada ANTES de abrir a UoW — evita overhead de transação
 * para caso que não vai escrever nada.
 *
 * A data de liquidação é calculada por SettlementScheduler (D+14 padrão).
 */
export class ScheduleSettlementUseCase {
  constructor(
    private readonly uow:            IUnitOfWork,
    /**
     * Repositório sem transação — usado apenas para a verificação de unicidade.
     */
    private readonly settlementRepo: ISettlementRepository,
  ) {}

  async execute(
    input: ScheduleSettlementInput,
  ): Promise<Result<ScheduleSettlementOutput, DomainError>> {
    // Verificação de unicidade ANTES de abrir UoW (business-rules §9.6)
    const existing = await this.settlementRepo.findByPaymentId(input.paymentId)
    if (existing !== null) {
      return err(new ConflictError(
        `Settlement já agendado para o pagamento ${input.paymentId}`
      ))
    }

    return this.uow.run(async (repos) => {
      const scheduledDate = SettlementScheduler.calculatePayoutDate(input.capturedAt)

      const itemResult = SettlementItem.create({
        paymentId:     input.paymentId,
        sellerId:      input.sellerId,
        amountCents:   input.sellerAmountCents,
        scheduledDate,
      })

      if (!itemResult.ok) return itemResult

      await repos.settlements.save(itemResult.value)

      return ok({
        settlementItemId: itemResult.value.id,
        scheduledDate,
      })
    })
  }
}
