import {
  stripeEventTypeToPaymentStatus,
  asaasEventToPaymentStatus,
  StripeWebhookBodySchema,
  AsaasWebhookBodySchema,
} from '../../../src/web/dtos/webhook.dto'

// ---------------------------------------------------------------------------
// stripeEventTypeToPaymentStatus
// ---------------------------------------------------------------------------

describe('stripeEventTypeToPaymentStatus', () => {
  it('maps payment_intent.succeeded → CAPTURED', () => {
    expect(stripeEventTypeToPaymentStatus('payment_intent.succeeded')).toBe('CAPTURED')
  })

  it('maps payment_intent.payment_failed → FAILED', () => {
    expect(stripeEventTypeToPaymentStatus('payment_intent.payment_failed')).toBe('FAILED')
  })

  it('maps payment_intent.canceled → CANCELLED', () => {
    expect(stripeEventTypeToPaymentStatus('payment_intent.canceled')).toBe('CANCELLED')
  })

  it('maps payment_intent.requires_action → REQUIRES_ACTION', () => {
    expect(stripeEventTypeToPaymentStatus('payment_intent.requires_action')).toBe('REQUIRES_ACTION')
  })

  it('maps payment_intent.amount_capturable_updated → AUTHORIZED', () => {
    expect(stripeEventTypeToPaymentStatus('payment_intent.amount_capturable_updated')).toBe('AUTHORIZED')
  })

  it('maps charge.refunded → REFUNDED', () => {
    expect(stripeEventTypeToPaymentStatus('charge.refunded')).toBe('REFUNDED')
  })

  it('maps charge.dispute.created → DISPUTED', () => {
    expect(stripeEventTypeToPaymentStatus('charge.dispute.created')).toBe('DISPUTED')
  })

  it('maps charge.dispute.closed with status=won → CHARGEBACK_WON', () => {
    expect(stripeEventTypeToPaymentStatus('charge.dispute.closed', { status: 'won' })).toBe('CHARGEBACK_WON')
  })

  it('maps charge.dispute.closed with status=lost → CHARGEBACK_LOST', () => {
    expect(stripeEventTypeToPaymentStatus('charge.dispute.closed', { status: 'lost' })).toBe('CHARGEBACK_LOST')
  })

  it('maps charge.dispute.closed with unknown status → CHARGEBACK_LOST (falsy default)', () => {
    expect(stripeEventTypeToPaymentStatus('charge.dispute.closed', { status: 'needs_response' })).toBe('CHARGEBACK_LOST')
  })

  it('maps charge.dispute.closed without eventObject → CHARGEBACK_LOST', () => {
    expect(stripeEventTypeToPaymentStatus('charge.dispute.closed')).toBe('CHARGEBACK_LOST')
  })

  it('returns null for unknown event type', () => {
    expect(stripeEventTypeToPaymentStatus('invoice.paid')).toBeNull()
    expect(stripeEventTypeToPaymentStatus('')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// asaasEventToPaymentStatus
// ---------------------------------------------------------------------------

describe('asaasEventToPaymentStatus', () => {
  it('maps PAYMENT_AUTHORIZED → AUTHORIZED', () => {
    expect(asaasEventToPaymentStatus('PAYMENT_AUTHORIZED')).toBe('AUTHORIZED')
  })

  it('maps PAYMENT_CONFIRMED → CAPTURED', () => {
    expect(asaasEventToPaymentStatus('PAYMENT_CONFIRMED')).toBe('CAPTURED')
  })

  it('maps PAYMENT_RECEIVED → CAPTURED', () => {
    expect(asaasEventToPaymentStatus('PAYMENT_RECEIVED')).toBe('CAPTURED')
  })

  it('maps PAYMENT_OVERDUE → FAILED', () => {
    expect(asaasEventToPaymentStatus('PAYMENT_OVERDUE')).toBe('FAILED')
  })

  it('maps PAYMENT_DELETED → CANCELLED', () => {
    expect(asaasEventToPaymentStatus('PAYMENT_DELETED')).toBe('CANCELLED')
  })

  it('maps PAYMENT_REFUNDED → REFUNDED', () => {
    expect(asaasEventToPaymentStatus('PAYMENT_REFUNDED')).toBe('REFUNDED')
  })

  it('maps PAYMENT_CHARGEBACK_REQUESTED → DISPUTED', () => {
    expect(asaasEventToPaymentStatus('PAYMENT_CHARGEBACK_REQUESTED')).toBe('DISPUTED')
  })

  it('returns null for unknown event', () => {
    expect(asaasEventToPaymentStatus('PAYMENT_UNKNOWN')).toBeNull()
    expect(asaasEventToPaymentStatus('')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// StripeWebhookBodySchema
// ---------------------------------------------------------------------------

describe('StripeWebhookBodySchema', () => {
  it('accepts a valid stripe body', () => {
    const result = StripeWebhookBodySchema.safeParse({
      id:   'evt_123',
      type: 'payment_intent.succeeded',
      data: { object: { metadata: { payment_id: 'abc' } } },
    })
    expect(result.success).toBe(true)
  })

  it('rejects body missing id', () => {
    const result = StripeWebhookBodySchema.safeParse({
      type: 'payment_intent.succeeded',
      data: { object: {} },
    })
    expect(result.success).toBe(false)
  })

  it('rejects body missing data.object', () => {
    const result = StripeWebhookBodySchema.safeParse({
      id:   'evt_123',
      type: 'payment_intent.succeeded',
      data: {},
    })
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AsaasWebhookBodySchema
// ---------------------------------------------------------------------------

describe('AsaasWebhookBodySchema', () => {
  it('accepts a valid asaas body', () => {
    const result = AsaasWebhookBodySchema.safeParse({
      event:   'PAYMENT_AUTHORIZED',
      payment: { id: 'pay_abc123' },
    })
    expect(result.success).toBe(true)
  })

  it('accepts body with optional status and value', () => {
    const result = AsaasWebhookBodySchema.safeParse({
      event:   'PAYMENT_CONFIRMED',
      payment: { id: 'pay_xyz', status: 'CONFIRMED', value: 100.0 },
    })
    expect(result.success).toBe(true)
  })

  it('rejects body missing event', () => {
    const result = AsaasWebhookBodySchema.safeParse({
      payment: { id: 'pay_abc' },
    })
    expect(result.success).toBe(false)
  })

  it('rejects body missing payment.id', () => {
    const result = AsaasWebhookBodySchema.safeParse({
      event:   'PAYMENT_AUTHORIZED',
      payment: { status: 'AUTHORIZED' },
    })
    expect(result.success).toBe(false)
  })
})
