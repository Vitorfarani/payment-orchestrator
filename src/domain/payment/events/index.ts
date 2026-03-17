export interface DomainEvent {
  readonly type: string
  readonly paymentId: string
  readonly occurredAt: Date
}

export interface PaymentCreatedEvent extends DomainEvent {
  readonly type: 'PaymentCreated'
  readonly amount: number
  readonly sellerId: string
}

export interface PaymentProcessingEvent extends DomainEvent {
  readonly type: 'PaymentProcessing'
}

export interface PaymentAuthorizedEvent extends DomainEvent {
  readonly type: 'PaymentAuthorized'
}

export interface PaymentCapturedEvent extends DomainEvent {
  readonly type: 'PaymentCaptured'
  readonly amount: number
  readonly sellerId: string
}

export interface PaymentSettledEvent extends DomainEvent {
  readonly type: 'PaymentSettled'
}

export interface PaymentFailedEvent extends DomainEvent {
  readonly type: 'PaymentFailed'
  readonly reason?: string
}

export interface PaymentCancelledEvent extends DomainEvent {
  readonly type: 'PaymentCancelled'
}

export interface PaymentRefundedEvent extends DomainEvent {
  readonly type: 'PaymentRefunded'
  readonly amount: number
}

export interface PaymentPartiallyRefundedEvent extends DomainEvent {
  readonly type: 'PaymentPartiallyRefunded'
  readonly refundAmount: number
}

export interface PaymentRequiresActionEvent extends DomainEvent {
  readonly type: 'PaymentRequiresAction'
}

export interface PaymentDisputedEvent extends DomainEvent {
  readonly type: 'PaymentDisputed'
}

export interface ChargebackWonEvent extends DomainEvent {
  readonly type: 'ChargebackWon'
}

export interface ChargebackLostEvent extends DomainEvent {
  readonly type: 'ChargebackLost'
  readonly amount: number
}

export type PaymentDomainEvent =
  | PaymentCreatedEvent
  | PaymentProcessingEvent
  | PaymentAuthorizedEvent
  | PaymentCapturedEvent
  | PaymentSettledEvent
  | PaymentFailedEvent
  | PaymentCancelledEvent
  | PaymentRefundedEvent
  | PaymentPartiallyRefundedEvent
  | PaymentRequiresActionEvent
  | PaymentDisputedEvent
  | ChargebackWonEvent
  | ChargebackLostEvent