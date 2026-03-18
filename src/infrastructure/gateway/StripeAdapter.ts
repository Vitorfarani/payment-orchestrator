/**
 * Adaptador Stripe para IPaymentGateway (ADR-008).
 *
 * Cada operação (authorize/capture/refund/getStatus) tem seu próprio
 * Circuit Breaker com nome distinto no Prometheus, permitindo observar
 * degradação por tipo de operação de forma independente.
 *
 * Classificação de erros:
 *   - Erros de infraestrutura (conexão, 5xx) → throw → CB conta como falha
 *   - Erros de negócio (cartão recusado, etc.) → err(Result) → CB conta como sucesso
 *
 * O StripeClient é uma interface mínima — injeta o cliente real em produção
 * e um mock nos testes, sem depender do SDK stripe diretamente.
 */

import type CircuitBreaker from 'opossum'
import type { Logger } from 'pino'
import type {
  IPaymentGateway,
  AuthorizeInput,
  AuthorizeResult,
  CaptureInput,
  CaptureResult,
  RefundInput,
  RefundResult,
  GetStatusInput,
  GetStatusResult,
} from '../../domain/payment/IPaymentGateway'
import type { Result } from '../../domain/shared/Result'
import { ok, err } from '../../domain/shared/Result'
import { GatewayError } from '../../domain/shared/errors'
import { createCircuitBreaker } from './CircuitBreakerFactory'

// ─── Interfaces mínimas do Stripe ─────────────────────────────────────────────
// Tipam apenas o que o adapter usa — compatíveis com o SDK real mas sem depender dele.

export interface StripePaymentIntentObject {
  readonly id:     string
  readonly status: string
}

export interface StripeRefundObject {
  readonly id:     string
  readonly status: string
}

export interface StripeClient {
  paymentIntents: {
    create(
      params: {
        amount:          number
        currency:        string
        capture_method:  'manual' | 'automatic'
        metadata?:       Record<string, string>
      },
      options?: { idempotencyKey?: string },
    ): Promise<StripePaymentIntentObject>

    capture(id: string): Promise<StripePaymentIntentObject>
    retrieve(id: string): Promise<StripePaymentIntentObject>
  }

  refunds: {
    create(
      params: {
        payment_intent: string
        amount:         number
      },
      options?: { idempotencyKey?: string },
    ): Promise<StripeRefundObject>
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Tipo predicate que adiciona statusCode ao tipo Error sem cast. */
function hasStatusCode(e: Error): e is Error & { statusCode: unknown } {
  return 'statusCode' in e
}

/**
 * Erros de infraestrutura devem ser re-lançados para o circuit breaker
 * contabilizar como falha e eventualmente abrir o circuito (ADR-008).
 * Erros de negócio (cartão recusado, etc.) retornam err() sem throw.
 */
function isInfrastructureError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'StripeConnectionError') return true
  if (!hasStatusCode(error)) return false
  return typeof error.statusCode === 'number' && error.statusCode >= 500
}

// ─── Implementação ────────────────────────────────────────────────────────────

type AuthorizeBreaker = CircuitBreaker<[AuthorizeInput], Result<AuthorizeResult, GatewayError>>
type CaptureBreaker   = CircuitBreaker<[CaptureInput],   Result<CaptureResult,   GatewayError>>
type RefundBreaker    = CircuitBreaker<[RefundInput],     Result<RefundResult,    GatewayError>>
type StatusBreaker    = CircuitBreaker<[GetStatusInput],  Result<GetStatusResult, GatewayError>>

const CIRCUIT_OPEN_ERROR = 'Payment gateway temporarily unavailable. Will retry automatically.'

export class StripeAdapter implements IPaymentGateway {
  private readonly authorizeBreaker: AuthorizeBreaker
  private readonly captureBreaker:   CaptureBreaker
  private readonly refundBreaker:    RefundBreaker
  private readonly statusBreaker:    StatusBreaker

  constructor(
    private readonly stripe: StripeClient,
    private readonly logger: Logger,
  ) {
    const circuitOpts = { timeout: 5000, resetTimeout: 30000 }

    this.authorizeBreaker = createCircuitBreaker<[AuthorizeInput], Result<AuthorizeResult, GatewayError>>(
      this.callAuthorize.bind(this),
      { name: 'stripe-authorize', ...circuitOpts },
      logger,
    )
    this.captureBreaker = createCircuitBreaker<[CaptureInput], Result<CaptureResult, GatewayError>>(
      this.callCapture.bind(this),
      { name: 'stripe-capture', ...circuitOpts },
      logger,
    )
    this.refundBreaker = createCircuitBreaker<[RefundInput], Result<RefundResult, GatewayError>>(
      this.callRefund.bind(this),
      { name: 'stripe-refund', ...circuitOpts },
      logger,
    )
    this.statusBreaker = createCircuitBreaker<[GetStatusInput], Result<GetStatusResult, GatewayError>>(
      this.callGetStatus.bind(this),
      { name: 'stripe-status', ...circuitOpts },
      logger,
    )

    // Fallback quando o circuito está aberto — retorna err() imediatamente sem esperar timeout
    this.authorizeBreaker.fallback(() => err(new GatewayError(CIRCUIT_OPEN_ERROR, 'CIRCUIT_OPEN')))
    this.captureBreaker.fallback(  () => err(new GatewayError(CIRCUIT_OPEN_ERROR, 'CIRCUIT_OPEN')))
    this.refundBreaker.fallback(   () => err(new GatewayError(CIRCUIT_OPEN_ERROR, 'CIRCUIT_OPEN')))
    this.statusBreaker.fallback(   () => err(new GatewayError(CIRCUIT_OPEN_ERROR, 'CIRCUIT_OPEN')))
  }

  // ─── IPaymentGateway ────────────────────────────────────────────────────────

  authorize(input: AuthorizeInput): Promise<Result<AuthorizeResult, GatewayError>> {
    return this.authorizeBreaker.fire(input)
  }

  capture(input: CaptureInput): Promise<Result<CaptureResult, GatewayError>> {
    return this.captureBreaker.fire(input)
  }

  refund(input: RefundInput): Promise<Result<RefundResult, GatewayError>> {
    return this.refundBreaker.fire(input)
  }

  getStatus(input: GetStatusInput): Promise<Result<GetStatusResult, GatewayError>> {
    return this.statusBreaker.fire(input)
  }

  // ─── Chamadas privadas (envoltas pelo circuit breaker) ───────────────────────

  private async callAuthorize(input: AuthorizeInput): Promise<Result<AuthorizeResult, GatewayError>> {
    try {
      const intent = await this.stripe.paymentIntents.create(
        {
          amount:         input.amount,
          currency:       input.currency.toLowerCase(),
          capture_method: 'manual',
          ...(input.metadata !== undefined && { metadata: this.toStripeMetadata(input.metadata) }),
        },
        { idempotencyKey: input.idempotencyKey },
      )

      const status = this.mapAuthorizeStatus(intent.status)
      if (status === null) {
        return err(new GatewayError(
          `Stripe returned unexpected authorize status: ${intent.status}`,
          'UNEXPECTED_STATUS',
        ))
      }

      return ok({
        gatewayPaymentId: intent.id,
        status,
        gatewayResponse:  { id: intent.id, status: intent.status },
      })
    } catch (error: unknown) {
      if (isInfrastructureError(error)) throw error
      return err(new GatewayError(
        error instanceof Error ? error.message : 'Unknown Stripe error',
        'STRIPE_ERROR',
      ))
    }
  }

  private async callCapture(input: CaptureInput): Promise<Result<CaptureResult, GatewayError>> {
    try {
      const intent = await this.stripe.paymentIntents.capture(input.gatewayPaymentId)

      return ok({
        gatewayPaymentId: intent.id,
        gatewayResponse:  { id: intent.id, status: intent.status },
      })
    } catch (error: unknown) {
      if (isInfrastructureError(error)) throw error
      return err(new GatewayError(
        error instanceof Error ? error.message : 'Unknown Stripe error',
        'STRIPE_ERROR',
      ))
    }
  }

  private async callRefund(input: RefundInput): Promise<Result<RefundResult, GatewayError>> {
    try {
      const refund = await this.stripe.refunds.create(
        {
          payment_intent: input.gatewayPaymentId,
          amount:         input.amount,
        },
        { idempotencyKey: input.idempotencyKey },
      )

      return ok({
        refundId:        refund.id,
        gatewayResponse: { id: refund.id, status: refund.status },
      })
    } catch (error: unknown) {
      if (isInfrastructureError(error)) throw error
      return err(new GatewayError(
        error instanceof Error ? error.message : 'Unknown Stripe error',
        'STRIPE_ERROR',
      ))
    }
  }

  private async callGetStatus(input: GetStatusInput): Promise<Result<GetStatusResult, GatewayError>> {
    try {
      const intent = await this.stripe.paymentIntents.retrieve(input.gatewayPaymentId)

      return ok({
        gatewayPaymentId: intent.id,
        status:           intent.status,
        gatewayResponse:  { id: intent.id, status: intent.status },
      })
    } catch (error: unknown) {
      if (isInfrastructureError(error)) throw error
      return err(new GatewayError(
        error instanceof Error ? error.message : 'Unknown Stripe error',
        'STRIPE_ERROR',
      ))
    }
  }

  // ─── Helpers privados ────────────────────────────────────────────────────────

  /** Converte metadados de domínio (unknown values) para o formato do Stripe (string values). */
  private toStripeMetadata(metadata: Record<string, unknown>): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(metadata)) {
      result[key] = String(value)
    }
    return result
  }

  /**
   * Mapeia o status do Stripe após a criação de um PaymentIntent com capture_method=manual.
   * - requires_capture → authorized (fundos bloqueados, aguardando captura)
   * - requires_action  → requires_action (3D Secure necessário)
   * - outros           → null (status inesperado)
   */
  private mapAuthorizeStatus(status: string): 'authorized' | 'requires_action' | null {
    if (status === 'requires_capture') return 'authorized'
    if (status === 'requires_action')  return 'requires_action'
    return null
  }
}
