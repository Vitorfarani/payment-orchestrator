/**
 * Adaptador Asaas para IPaymentGateway (ADR-008).
 *
 * Implementação alternativa ao StripeAdapter — prova que IPaymentGateway
 * é agnóstica ao provider. Diferenças estruturais em relação ao Stripe:
 *
 *   - Valores em decimal BRL (÷100 de Cents): 5000 Cents → 50.00
 *   - Status do Asaas em SCREAMING_SNAKE_CASE: PENDING, AWAITING_RISK_ANALYSIS, RECEIVED
 *   - Reembolso é uma operação no próprio payment (payments.refund), não em recurso separado
 *   - paymentId passado como externalReference para rastreabilidade no dashboard Asaas
 *
 * Classificação de erros (mesma lógica do Stripe):
 *   - AsaasConnectionError ou statusCode >= 500 → throw → CB conta como falha
 *   - statusCode 4xx → err(Result) → CB conta como sucesso (erro de negócio)
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

// ─── Interfaces mínimas do Asaas ──────────────────────────────────────────────
// Tipam apenas o que o adapter usa — compatíveis com o SDK real mas sem depender dele.

export interface AsaasPaymentObject {
  readonly id:     string
  readonly status: string
}

export interface AsaasRefundObject {
  readonly id:     string
  readonly status: string
}

export interface AsaasClient {
  payments: {
    create(
      params: {
        billingType:        string
        value:              number
        dueDate:            string
        externalReference?: string
      },
      options?: { idempotencyKey?: string },
    ): Promise<AsaasPaymentObject>

    capture(id: string): Promise<AsaasPaymentObject>
    retrieve(id: string): Promise<AsaasPaymentObject>

    refund(
      id: string,
      params: { value: number },
      options?: { idempotencyKey?: string },
    ): Promise<AsaasRefundObject>
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
 * Erros de negócio (4xx) retornam err() sem throw.
 */
function isInfrastructureError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'AsaasConnectionError') return true
  if (!hasStatusCode(error)) return false
  return typeof error.statusCode === 'number' && error.statusCode >= 500
}

// ─── Implementação ────────────────────────────────────────────────────────────

type AuthorizeBreaker = CircuitBreaker<[AuthorizeInput], Result<AuthorizeResult, GatewayError>>
type CaptureBreaker   = CircuitBreaker<[CaptureInput],   Result<CaptureResult,   GatewayError>>
type RefundBreaker    = CircuitBreaker<[RefundInput],     Result<RefundResult,    GatewayError>>
type StatusBreaker    = CircuitBreaker<[GetStatusInput],  Result<GetStatusResult, GatewayError>>

const CIRCUIT_OPEN_ERROR = 'Payment gateway temporarily unavailable. Will retry automatically.'

export class AsaasAdapter implements IPaymentGateway {
  private readonly authorizeBreaker: AuthorizeBreaker
  private readonly captureBreaker:   CaptureBreaker
  private readonly refundBreaker:    RefundBreaker
  private readonly statusBreaker:    StatusBreaker

  constructor(
    private readonly asaas: AsaasClient,
    private readonly logger: Logger,
  ) {
    const circuitOpts = { timeout: 5000, resetTimeout: 30000 }

    this.authorizeBreaker = createCircuitBreaker<[AuthorizeInput], Result<AuthorizeResult, GatewayError>>(
      this.callAuthorize.bind(this),
      { name: 'asaas-authorize', ...circuitOpts },
      logger,
    )
    this.captureBreaker = createCircuitBreaker<[CaptureInput], Result<CaptureResult, GatewayError>>(
      this.callCapture.bind(this),
      { name: 'asaas-capture', ...circuitOpts },
      logger,
    )
    this.refundBreaker = createCircuitBreaker<[RefundInput], Result<RefundResult, GatewayError>>(
      this.callRefund.bind(this),
      { name: 'asaas-refund', ...circuitOpts },
      logger,
    )
    this.statusBreaker = createCircuitBreaker<[GetStatusInput], Result<GetStatusResult, GatewayError>>(
      this.callGetStatus.bind(this),
      { name: 'asaas-status', ...circuitOpts },
      logger,
    )

    // Fallback quando o circuito está aberto — falha imediata sem esperar timeout
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
      // Asaas trabalha com decimal BRL — converter Cents para reais
      const value   = input.amount / 100
      const dueDate = new Date().toISOString().slice(0, 10)

      const payment = await this.asaas.payments.create(
        {
          billingType:       'CREDIT_CARD',
          value,
          dueDate,
          externalReference: String(input.paymentId),
        },
        { idempotencyKey: input.idempotencyKey },
      )

      const status = this.mapAuthorizeStatus(payment.status)
      if (status === null) {
        return err(new GatewayError(
          `Asaas returned unexpected authorize status: ${payment.status}`,
          'UNEXPECTED_STATUS',
        ))
      }

      return ok({
        gatewayPaymentId: payment.id,
        status,
        gatewayResponse:  { id: payment.id, status: payment.status },
      })
    } catch (error: unknown) {
      if (isInfrastructureError(error)) throw error
      return err(new GatewayError(
        error instanceof Error ? error.message : 'Unknown Asaas error',
        'ASAAS_ERROR',
      ))
    }
  }

  private async callCapture(input: CaptureInput): Promise<Result<CaptureResult, GatewayError>> {
    try {
      const payment = await this.asaas.payments.capture(input.gatewayPaymentId)

      return ok({
        gatewayPaymentId: payment.id,
        gatewayResponse:  { id: payment.id, status: payment.status },
      })
    } catch (error: unknown) {
      if (isInfrastructureError(error)) throw error
      return err(new GatewayError(
        error instanceof Error ? error.message : 'Unknown Asaas error',
        'ASAAS_ERROR',
      ))
    }
  }

  private async callRefund(input: RefundInput): Promise<Result<RefundResult, GatewayError>> {
    try {
      // Asaas trabalha com decimal BRL — converter Cents para reais
      const value = input.amount / 100

      const refund = await this.asaas.payments.refund(
        input.gatewayPaymentId,
        { value },
        { idempotencyKey: input.idempotencyKey },
      )

      return ok({
        refundId:        refund.id,
        gatewayResponse: { id: refund.id, status: refund.status },
      })
    } catch (error: unknown) {
      if (isInfrastructureError(error)) throw error
      return err(new GatewayError(
        error instanceof Error ? error.message : 'Unknown Asaas error',
        'ASAAS_ERROR',
      ))
    }
  }

  private async callGetStatus(input: GetStatusInput): Promise<Result<GetStatusResult, GatewayError>> {
    try {
      const payment = await this.asaas.payments.retrieve(input.gatewayPaymentId)

      return ok({
        gatewayPaymentId: payment.id,
        status:           payment.status,
        gatewayResponse:  { id: payment.id, status: payment.status },
      })
    } catch (error: unknown) {
      if (isInfrastructureError(error)) throw error
      return err(new GatewayError(
        error instanceof Error ? error.message : 'Unknown Asaas error',
        'ASAAS_ERROR',
      ))
    }
  }

  // ─── Helpers privados ────────────────────────────────────────────────────────

  /**
   * Mapeia o status do Asaas após criação de cobrança com CREDIT_CARD.
   * - PENDING                 → authorized (cobrança criada, aguardando captura)
   * - AWAITING_RISK_ANALYSIS  → requires_action (análise de risco manual necessária)
   * - outros                  → null (status inesperado)
   */
  private mapAuthorizeStatus(status: string): 'authorized' | 'requires_action' | null {
    if (status === 'PENDING')                return 'authorized'
    if (status === 'AWAITING_RISK_ANALYSIS') return 'requires_action'
    return null
  }
}
