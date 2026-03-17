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
}

interface CreatePaymentInput {
  id:             PaymentId
  sellerId:       SellerId
  amount:         Cents
  idempotencyKey: IdempotencyKey
}

export class Payment {
  private props: PaymentProps
  private events: PaymentDomainEvent[] = []

  private constructor(props: PaymentProps) {
    this.props = props
  }

  // — Getters —
  get id():             PaymentId    { return this.props.id }
  get sellerId():       SellerId     { return this.props.sellerId }
  get amount():         Cents        { return this.props.amount }
  get status():         PaymentStatus { return this.props.status }
  get idempotencyKey(): IdempotencyKey { return this.props.idempotencyKey }
  get createdAt():      Date         { return this.props.createdAt }
  get updatedAt():      Date         { return this.props.updatedAt }
  get domainEvents():   readonly PaymentDomainEvent[] { return this.events }

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

    this.props.status    = newStatus
    this.props.updatedAt = new Date()

    this.events.push(this.buildEvent(newStatus, metadata))

    return ok(undefined)
  }

  clearEvents(): void {
    this.events = []
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