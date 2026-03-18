import type { Cents, PaymentId, IdempotencyKey } from '../shared/types'
import type { Result } from '../shared/Result'
import type { GatewayError } from '../shared/errors'

// ─── Authorize ────────────────────────────────────────────────────────────────

export interface AuthorizeInput {
  readonly paymentId:      PaymentId
  readonly idempotencyKey: IdempotencyKey
  readonly amount:         Cents
  readonly currency:       string
  readonly metadata?:      Record<string, unknown>
}

export interface AuthorizeResult {
  readonly gatewayPaymentId: string
  readonly status:           'authorized' | 'requires_action'
  readonly gatewayResponse:  Record<string, unknown>
}

// ─── Capture ──────────────────────────────────────────────────────────────────

export interface CaptureInput {
  readonly gatewayPaymentId: string
}

export interface CaptureResult {
  readonly gatewayPaymentId: string
  readonly gatewayResponse:  Record<string, unknown>
}

// ─── Refund ───────────────────────────────────────────────────────────────────

export interface RefundInput {
  readonly gatewayPaymentId: string
  readonly amount:           Cents
  readonly idempotencyKey:   IdempotencyKey
}

export interface RefundResult {
  readonly refundId:        string
  readonly gatewayResponse: Record<string, unknown>
}

// ─── GetStatus ────────────────────────────────────────────────────────────────

export interface GetStatusInput {
  readonly gatewayPaymentId: string
}

export interface GetStatusResult {
  readonly gatewayPaymentId: string
  readonly status:           string
  readonly gatewayResponse:  Record<string, unknown>
}

// ─── Interface ────────────────────────────────────────────────────────────────

/**
 * Contrato de domínio para o gateway de pagamentos.
 *
 * - Implementado por StripeAdapter, AsaasAdapter, etc. (infra layer)
 * - Nenhuma lib de infra neste arquivo — zero acoplamento com provider
 * - Erros retornam Result<T, GatewayError> — nunca throw (ADR-014)
 * - Cada chamada é idempotente via idempotencyKey (ADR-002)
 */
export interface IPaymentGateway {
  authorize(input: AuthorizeInput):  Promise<Result<AuthorizeResult, GatewayError>>
  capture(input: CaptureInput):      Promise<Result<CaptureResult,   GatewayError>>
  refund(input: RefundInput):        Promise<Result<RefundResult,     GatewayError>>
  getStatus(input: GetStatusInput):  Promise<Result<GetStatusResult,  GatewayError>>
}
