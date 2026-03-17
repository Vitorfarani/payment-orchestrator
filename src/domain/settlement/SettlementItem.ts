import { SettlementItemId, type PaymentId, type SellerId, type Cents } from '../shared/types'
import { ok, err, type Result } from '../shared/Result'
import { ValidationError, BusinessRuleError } from '../shared/errors'

export type SettlementStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED'

interface SettlementItemProps {
  readonly id:            SettlementItemId
  readonly paymentId:     PaymentId
  readonly sellerId:      SellerId
  readonly amountCents:   Cents
  readonly scheduledDate: Date
  readonly status:        SettlementStatus
  readonly createdAt:     Date
  readonly updatedAt:     Date
}

interface CreateSettlementItemInput {
  readonly paymentId:     PaymentId
  readonly sellerId:      SellerId
  readonly amountCents:   Cents
  readonly scheduledDate: Date
}

/**
 * Representa um item de liquidação programado para repasse ao vendedor.
 *
 * Ciclo de vida: PENDING → PROCESSING → COMPLETED | FAILED
 *
 * Criado quando um pagamento transiciona para CAPTURED.
 * O SettlementWorker processa itens com scheduledDate <= hoje.
 *
 * Entidade imutável por transição — cada método retorna nova instância.
 * ADR-011 (Settlement Schedule).
 */
export class SettlementItem {
  private readonly props: SettlementItemProps

  private constructor(props: SettlementItemProps) {
    this.props = props
  }

  get id():            SettlementItemId { return this.props.id }
  get paymentId():     PaymentId        { return this.props.paymentId }
  get sellerId():      SellerId         { return this.props.sellerId }
  get amountCents():   Cents            { return this.props.amountCents }
  get scheduledDate(): Date             { return this.props.scheduledDate }
  get status():        SettlementStatus { return this.props.status }
  get createdAt():     Date             { return this.props.createdAt }
  get updatedAt():     Date             { return this.props.updatedAt }

  /**
   * Cria novo item de liquidação com status PENDING.
   * Chamado pelo ScheduleSettlementUseCase após captura do pagamento.
   */
  static create(input: CreateSettlementItemInput): Result<SettlementItem, ValidationError> {
    if (input.amountCents <= 0) {
      return err(new ValidationError('SettlementItem amount must be greater than zero'))
    }
    const now = new Date()
    return ok(new SettlementItem({
      id:            SettlementItemId.create(),
      paymentId:     input.paymentId,
      sellerId:      input.sellerId,
      amountCents:   input.amountCents,
      scheduledDate: input.scheduledDate,
      status:        'PENDING',
      createdAt:     now,
      updatedAt:     now,
    }))
  }

  /**
   * Transiciona PENDING → PROCESSING.
   * Chamado pelo SettlementWorker antes de executar o payout no gateway.
   * SELECT FOR UPDATE garante que apenas um worker processa este item.
   */
  startProcessing(): Result<SettlementItem, BusinessRuleError> {
    if (this.props.status !== 'PENDING') {
      return err(new BusinessRuleError(
        `Cannot start processing: current status is ${this.props.status}`,
      ))
    }
    return ok(new SettlementItem({ ...this.props, status: 'PROCESSING', updatedAt: new Date() }))
  }

  /**
   * Transiciona PROCESSING → COMPLETED.
   * Chamado após payout bem-sucedido no gateway.
   */
  complete(): Result<SettlementItem, BusinessRuleError> {
    if (this.props.status !== 'PROCESSING') {
      return err(new BusinessRuleError(
        `Cannot complete: current status is ${this.props.status}`,
      ))
    }
    return ok(new SettlementItem({ ...this.props, status: 'COMPLETED', updatedAt: new Date() }))
  }

  /**
   * Transiciona PROCESSING → FAILED.
   * Chamado quando o payout falha. O BullMQ gerencia os retries (ADR-012).
   */
  fail(): Result<SettlementItem, BusinessRuleError> {
    if (this.props.status !== 'PROCESSING') {
      return err(new BusinessRuleError(
        `Cannot fail: current status is ${this.props.status}`,
      ))
    }
    return ok(new SettlementItem({ ...this.props, status: 'FAILED', updatedAt: new Date() }))
  }

  /** Rehidrata a entidade a partir de uma linha do banco. Usado pelo repositório. */
  static reconstitute(props: SettlementItemProps): SettlementItem {
    return new SettlementItem(props)
  }
}
