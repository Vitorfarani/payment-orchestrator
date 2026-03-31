import { z } from 'zod'
import type { PaymentStatus } from '../../domain/payment/value-objects/PaymentStatus'

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

export const StripeWebhookBodySchema = z.object({
  id:   z.string(),
  type: z.string(),
  data: z.object({
    object: z.record(z.unknown()),
  }),
})

export type StripeWebhookBody = z.infer<typeof StripeWebhookBodySchema>

/**
 * Mapeia um Stripe event.type para PaymentStatus interno.
 *
 * Para `charge.dispute.closed`, consulta `eventObject.status` para distinguir
 * won de lost.
 *
 * Retorna `null` para eventos desconhecidos — o controller aceita silenciosamente.
 */
export function stripeEventTypeToPaymentStatus(
  eventType: string,
  eventObject?: Record<string, unknown>,
): PaymentStatus | null {
  switch (eventType) {
    case 'payment_intent.succeeded':
      return 'CAPTURED'
    case 'payment_intent.payment_failed':
      return 'FAILED'
    case 'payment_intent.canceled':
      return 'CANCELLED'
    case 'payment_intent.requires_action':
      return 'REQUIRES_ACTION'
    case 'payment_intent.amount_capturable_updated':
      return 'AUTHORIZED'
    case 'charge.refunded':
      return 'REFUNDED'
    case 'charge.dispute.created':
      return 'DISPUTED'
    case 'charge.dispute.closed':
      return eventObject?.['status'] === 'won' ? 'CHARGEBACK_WON' : 'CHARGEBACK_LOST'
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Asaas
// ---------------------------------------------------------------------------

export const AsaasWebhookBodySchema = z.object({
  event: z.string(),
  payment: z.object({
    id:     z.string(),
    status: z.string().optional(),
    value:  z.number().optional(),
  }),
})

export type AsaasWebhookBody = z.infer<typeof AsaasWebhookBodySchema>

/**
 * Mapeia um Asaas event para PaymentStatus interno.
 * Retorna `null` para eventos desconhecidos.
 */
export function asaasEventToPaymentStatus(event: string): PaymentStatus | null {
  switch (event) {
    case 'PAYMENT_AUTHORIZED':
      return 'AUTHORIZED'
    case 'PAYMENT_CONFIRMED':
    case 'PAYMENT_RECEIVED':
      return 'CAPTURED'
    case 'PAYMENT_OVERDUE':
      return 'FAILED'
    case 'PAYMENT_DELETED':
      return 'CANCELLED'
    case 'PAYMENT_REFUNDED':
      return 'REFUNDED'
    case 'PAYMENT_CHARGEBACK_REQUESTED':
      return 'DISPUTED'
    default:
      return null
  }
}
