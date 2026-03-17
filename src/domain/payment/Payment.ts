import type { PaymentId, SellerId, Cents, IdempotencyKey } from '../shared/types'
import type { Result } from '../shared/Result'
import { ok, err } from '../shared/Result'
import { BusinessRuleError, ValidationError } from '../shared/errors'
import type { PaymentStatus } from './value-objects/PaymentStatus'
import { VALID_TRANSITIONS } from './value-objects/PaymentStatus'
import type {
  PaymentDomainEvent,
  PaymentCreatedEvent,
  PaymentCapturedEvent,
  PaymentRefundedEvent,
  PaymentPartiallyRefundedEvent,
  PaymentFailedEvent,
  PaymentCancelledEvent,
  PaymentSettledEvent,
  PaymentProcessingEvent,
  PaymentAuthorizedEvent,
  PaymentRequiresActionEvent,
  PaymentDisputedEvent,
  ChargebackWonEvent,
  ChargebackLostEvent,
} from './events'

interface PaymentProps {
  readonly id:             PaymentId
  readonly sellerId:       SellerId
  readonly amount:         Cents
  readonly idempotencyKey: IdempotencyKey
  status:                  PaymentStatus
  readonly createdAt:      Date
  updatedAt:               Date

  // Gateway — preenchido após comunicação com o provider
  gateway?:          string
  gatewayPaymentId?: string
  gatewayResponse?:  Record<string, unknown>

  // Metadados externos do caller (order_id, customer_id, etc.)
  metadata?:         Record<string, unknown>

  // Erros — preenchidos quando status = FAILED
  errorCode?:        string
  errorMessage?:     string

  // Timestamps das transições relevantes — auditoria e reconciliação
  authorizedAt?:     Date
  capturedAt?:       Date
  refundedAt?:       Date
  failedAt?:         Date
}

interface CreatePaymentInput {
  id:              PaymentId
  sellerId:        SellerId
  amount:          Cents
  idempotencyKey:  IdempotencyKey
  metadata?:       Record<string, unknown>
}

/**
 * Input para rehidratar Payment a partir de uma linha do banco.
 * Usado exclusivamente pelo PostgresPaymentRepository.reconstitute().
 */
export interface ReconstitutePaymentInput {
  readonly id:             PaymentId
  readonly sellerId:       SellerId
  readonly amount:         Cents
  readonly idempotencyKey: IdempotencyKey
  readonly status:         PaymentStatus
  readonly createdAt:      Date
  readonly updatedAt:      Date
  readonly gateway?:          string
  readonly gatewayPaymentId?: string
  readonly gatewayResponse?:  Record<string, unknown>
  readonly metadata?:         Record<string, unknown>
  readonly errorCode?:        string
  readonly errorMessage?:     string
  readonly authorizedAt?:     Date
  readonly capturedAt?:       Date
  readonly refundedAt?:       Date
  readonly failedAt?:         Date
}

export class Payment {
  private props: PaymentProps
  private events: PaymentDomainEvent[] = []

  private constructor(props: PaymentProps) {
    this.props = props
  }

  // — Getters —
  get id():               PaymentId                          { return this.props.id }
  get sellerId():         SellerId                           { return this.props.sellerId }
  get amount():           Cents                              { return this.props.amount }
  get status():           PaymentStatus                      { return this.props.status }
  get idempotencyKey():   IdempotencyKey                     { return this.props.idempotencyKey }
  get createdAt():        Date                               { return this.props.createdAt }
  get updatedAt():        Date                               { return this.props.updatedAt }
  get domainEvents():     readonly PaymentDomainEvent[]      { return this.events }
  get gateway():          string | undefined                 { return this.props.gateway }
  get gatewayPaymentId(): string | undefined                 { return this.props.gatewayPaymentId }
  get gatewayResponse():  Record<string, unknown> | undefined { return this.props.gatewayResponse }
  get metadata():         Record<string, unknown> | undefined { return this.props.metadata }
  get errorCode():        string | undefined                 { return this.props.errorCode }
  get errorMessage():     string | undefined                 { return this.props.errorMessage }
  get authorizedAt():     Date | undefined                   { return this.props.authorizedAt }
  get capturedAt():       Date | undefined                   { return this.props.capturedAt }
  get refundedAt():       Date | undefined                   { return this.props.refundedAt }
  get failedAt():         Date | undefined                   { return this.props.failedAt }

  // — Factory —
  static create(input: CreatePaymentInput): Result<Payment, ValidationError> {
    if (input.amount <= 0) {
      return err(new ValidationError('O valor do pagamento deve ser maior que zero'))
    }

    const now = new Date()
    const payment = new Payment({
      ...input,
      status:    'PENDING',
      createdAt: now,
      updatedAt: now,
    })

    payment.events.push({
      type:       'PaymentCreated',
      paymentId:  input.id,
      sellerId:   input.sellerId,
      amount:     input.amount,
      occurredAt: now,
    } satisfies PaymentCreatedEvent)

    return ok(payment)
  }

  // — State machine —
  transition(
    newStatus: PaymentStatus,
    metadata?: Record<string, unknown>
  ): Result<void, BusinessRuleError> {
    const validNext = VALID_TRANSITIONS[this.props.status]

    if (!validNext.includes(newStatus)) {
      return err(new BusinessRuleError(
        `Transição inválida: ${this.props.status} → ${newStatus}. ` +
        `Permitidas: ${validNext.join(', ') || 'nenhuma (estado terminal)'}`
      ))
    }

    const now = new Date()
    this.props.status    = newStatus
    this.props.updatedAt = now

    // Timestamps de transição — auditoria e reconciliação financeira
    if (newStatus === 'AUTHORIZED')                              { this.props.authorizedAt = now }
    if (newStatus === 'CAPTURED')                               { this.props.capturedAt   = now }
    if (newStatus === 'REFUNDED' || newStatus === 'PARTIALLY_REFUNDED') { this.props.refundedAt = now }
    if (newStatus === 'FAILED') {
      this.props.failedAt = now
      if (typeof metadata?.['errorCode']    === 'string') { this.props.errorCode    = metadata['errorCode']    }
      if (typeof metadata?.['errorMessage'] === 'string') { this.props.errorMessage = metadata['errorMessage'] }
    }

    this.events.push(this.buildEvent(newStatus, metadata))

    return ok(undefined)
  }

  // Chamado pela application layer quando o gateway responde com o ID externo
  setGatewayInfo(
    gateway: string,
    gatewayPaymentId: string,
    gatewayResponse: Record<string, unknown>,
  ): void {
    this.props.gateway          = gateway
    this.props.gatewayPaymentId = gatewayPaymentId
    this.props.gatewayResponse  = gatewayResponse
    this.props.updatedAt        = new Date()
  }

  clearEvents(): void {
    this.events = []
  }

  /** Rehidrata a entidade a partir de uma linha do banco. Não gera domain events. */
  static reconstitute(input: ReconstitutePaymentInput): Payment {
    return new Payment({ ...input })
  }

  // — Constrói o evento certo pra cada transição —
  private buildEvent(
    status: PaymentStatus,
    metadata?: Record<string, unknown>
  ): PaymentDomainEvent {
    const base = { paymentId: this.props.id, occurredAt: new Date() }

    switch (status) {
      case 'PROCESSING':
        return { ...base, type: 'PaymentProcessing' } satisfies PaymentProcessingEvent
      case 'AUTHORIZED':
        return { ...base, type: 'PaymentAuthorized' } satisfies PaymentAuthorizedEvent
      case 'REQUIRES_ACTION':
        return { ...base, type: 'PaymentRequiresAction' } satisfies PaymentRequiresActionEvent
      case 'CAPTURED':
        return { ...base, type: 'PaymentCaptured', amount: this.props.amount, sellerId: this.props.sellerId } satisfies PaymentCapturedEvent
      case 'SETTLED':
        return { ...base, type: 'PaymentSettled' } satisfies PaymentSettledEvent
      case 'REFUNDED':
        return { ...base, type: 'PaymentRefunded', amount: this.props.amount } satisfies PaymentRefundedEvent
      case 'PARTIALLY_REFUNDED': {
        const refundAmount = typeof metadata?.['refundAmount'] === 'number' ? metadata['refundAmount'] : 0
        return { ...base, type: 'PaymentPartiallyRefunded', refundAmount } satisfies PaymentPartiallyRefundedEvent
      }
      case 'FAILED':
        return {
          ...base,
          type: 'PaymentFailed',
          ...(typeof metadata?.['reason'] === 'string' && { reason: metadata['reason'] }),
        } satisfies PaymentFailedEvent
      case 'CANCELLED':
        return { ...base, type: 'PaymentCancelled' } satisfies PaymentCancelledEvent
      case 'DISPUTED':
        return { ...base, type: 'PaymentDisputed' } satisfies PaymentDisputedEvent
      case 'CHARGEBACK_WON':
        return { ...base, type: 'ChargebackWon' } satisfies ChargebackWonEvent
      case 'CHARGEBACK_LOST':
        return { ...base, type: 'ChargebackLost', amount: this.props.amount } satisfies ChargebackLostEvent
      /* istanbul ignore next -- PENDING é estado inicial, nunca aparece em VALID_TRANSITIONS */
      case 'PENDING':
        throw new Error('Não é possível transicionar para PENDING')
    }
  }
}