/**
 * Contract tests — AsaasAdapter como consumer da Asaas API (ADR-020).
 *
 * Cada interação testa um endpoint real da Asaas API usando um mock Pact.
 * O mock registra as interações em pacts/payment-orchestrator-asaas-api.json.
 *
 * Diferenças estruturais do Asaas vs Stripe:
 *   - Valores em decimal BRL (Cents ÷ 100): 5000 Cents → 50.00
 *   - Status em SCREAMING_SNAKE_CASE: PENDING, AWAITING_RISK_ANALYSIS, CONFIRMED
 *   - Reembolso é operação no próprio payment, não em recurso separado
 *   - Corpo das requisições em JSON (não form-encoded como no Stripe)
 *
 * Para executar: npm run test:contract
 */

import path from 'path'
import { PactV3, MatchersV3 } from '@pact-foundation/pact'
import type { Logger } from 'pino'
import type {
  AsaasClient,
  AsaasPaymentObject,
  AsaasRefundObject,
} from '../../src/infrastructure/gateway/AsaasAdapter'
import { AsaasAdapter } from '../../src/infrastructure/gateway/AsaasAdapter'
import { PaymentId, IdempotencyKey, Cents } from '../../src/domain/shared/types'

const { like } = MatchersV3

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ASAAS_PAYMENT_ID = 'pay_contract_test_abc123'

const mockLogger: Logger = {
  warn:   jest.fn(),
  info:   jest.fn(),
  error:  jest.fn(),
  debug:  jest.fn(),
  trace:  jest.fn(),
  fatal:  jest.fn(),
  child:  jest.fn().mockReturnThis(),
  level:  'silent',
  silent: jest.fn(),
} as unknown as Logger

// ─── Pact provider (mock Asaas API) ──────────────────────────────────────────

const provider = new PactV3({
  consumer:  'payment-orchestrator',
  provider:  'asaas-api',
  dir:       path.resolve(process.cwd(), 'pacts'),
  logLevel:  'error',
})

// ─── HTTP implementation of AsaasClient for Pact tests ───────────────────────
// Faz chamadas HTTP reais ao mock server do Pact em vez de usar o SDK Asaas.

function createAsaasHttpClient(baseUrl: string): AsaasClient {
  async function asaasPost(
    endpointPath: string,
    body: Record<string, unknown> = {},
    idempotencyKey?: string,
  ): Promise<AsaasPaymentObject | AsaasRefundObject> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'access_token': 'test_api_key_contract',
    }
    if (idempotencyKey !== undefined) {
      headers['Idempotency-Key'] = idempotencyKey
    }

    const res  = await fetch(`${baseUrl}${endpointPath}`, {
      method:  'POST',
      headers,
      body:    JSON.stringify(body),
    })
    const data = await res.json() as Record<string, unknown>

    if (!res.ok) {
      const message  = String(data['message'] ?? 'Asaas API error')
      const asaasErr = new Error(message)
      ;(asaasErr as Error & { statusCode: number }).statusCode = res.status
      throw asaasErr
    }

    return data as unknown as AsaasPaymentObject | AsaasRefundObject
  }

  async function asaasGet(endpointPath: string): Promise<AsaasPaymentObject> {
    const res = await fetch(`${baseUrl}${endpointPath}`, {
      headers: { 'access_token': 'test_api_key_contract' },
    })
    return res.json() as Promise<AsaasPaymentObject>
  }

  return {
    payments: {
      create: (params, options) =>
        asaasPost(
          '/v3/payments',
          { ...params },
          options?.idempotencyKey,
        ) as Promise<AsaasPaymentObject>,

      capture: (id) =>
        asaasPost(`/v3/payments/${id}/capture`) as Promise<AsaasPaymentObject>,

      retrieve: (id) => asaasGet(`/v3/payments/${id}`),

      refund: (id, params, options) =>
        asaasPost(
          `/v3/payments/${id}/refund`,
          { ...params },
          options?.idempotencyKey,
        ) as Promise<AsaasRefundObject>,
    },
  }
}

// ─── Inputs de teste ─────────────────────────────────────────────────────────

const authorizeInput = {
  paymentId:      PaymentId.create(),
  idempotencyKey: IdempotencyKey.generate(),
  amount:         Cents.of(5000),
  currency:       'BRL' as const,
}

const captureInput   = { gatewayPaymentId: ASAAS_PAYMENT_ID }

const refundInput = {
  gatewayPaymentId: ASAAS_PAYMENT_ID,
  amount:           Cents.of(2500),
  idempotencyKey:   IdempotencyKey.generate(),
}

const getStatusInput = { gatewayPaymentId: ASAAS_PAYMENT_ID }

// ─── Testes ──────────────────────────────────────────────────────────────────

describe('AsaasAdapter — Pact contract', () => {
  it('1. POST /v3/payments → criação bem-sucedida (status: PENDING)', () => {
    return provider
      .addInteraction({
        states:        [{ description: 'can create a payment charge' }],
        uponReceiving: 'a request to create an Asaas payment',
        withRequest: {
          method:  'POST',
          path:    '/v3/payments',
          headers: { 'Content-Type': like('application/json') },
        },
        willRespondWith: {
          status:  200,
          headers: { 'Content-Type': like('application/json') },
          body: {
            id:     like(ASAAS_PAYMENT_ID),
            status: like('PENDING'),
          },
        },
      })
      .executeTest(async (mockServer) => {
        const adapter = new AsaasAdapter(createAsaasHttpClient(mockServer.url), mockLogger)
        const result  = await adapter.authorize(authorizeInput)

        // PENDING no Asaas mapeia para 'authorized' no domínio
        expect(result.ok).toBe(true)
        if (result.ok) {
          expect(result.value.status).toBe('authorized')
          expect(typeof result.value.gatewayPaymentId).toBe('string')
          expect(result.value.gatewayResponse).toMatchObject({ status: 'PENDING' })
        }
      })
  })

  it('2. POST /v3/payments/{id}/capture → captura bem-sucedida', () => {
    return provider
      .addInteraction({
        states:        [{ description: 'payment can be captured' }],
        uponReceiving: 'a request to capture an Asaas payment',
        withRequest: {
          method: 'POST',
          path:   `/v3/payments/${ASAAS_PAYMENT_ID}/capture`,
        },
        willRespondWith: {
          status:  200,
          headers: { 'Content-Type': like('application/json') },
          body: {
            id:     like(ASAAS_PAYMENT_ID),
            status: like('CONFIRMED'),
          },
        },
      })
      .executeTest(async (mockServer) => {
        const adapter = new AsaasAdapter(createAsaasHttpClient(mockServer.url), mockLogger)
        const result  = await adapter.capture(captureInput)

        expect(result.ok).toBe(true)
        if (result.ok) {
          expect(result.value.gatewayPaymentId).toBe(ASAAS_PAYMENT_ID)
          expect(result.value.gatewayResponse).toMatchObject({ id: ASAAS_PAYMENT_ID })
        }
      })
  })

  it('3. POST /v3/payments/{id}/refund → estorno bem-sucedido', () => {
    return provider
      .addInteraction({
        states:        [{ description: 'payment can be refunded' }],
        uponReceiving: 'a request to refund an Asaas payment',
        withRequest: {
          method:  'POST',
          path:    `/v3/payments/${ASAAS_PAYMENT_ID}/refund`,
          headers: { 'Content-Type': like('application/json') },
        },
        willRespondWith: {
          status:  200,
          headers: { 'Content-Type': like('application/json') },
          body: {
            id:     like(ASAAS_PAYMENT_ID),
            status: like('REFUNDED'),
          },
        },
      })
      .executeTest(async (mockServer) => {
        const adapter = new AsaasAdapter(createAsaasHttpClient(mockServer.url), mockLogger)
        const result  = await adapter.refund(refundInput)

        expect(result.ok).toBe(true)
        if (result.ok) {
          expect(typeof result.value.refundId).toBe('string')
          expect(result.value.gatewayResponse).toMatchObject({ status: 'REFUNDED' })
        }
      })
  })

  it('4. GET /v3/payments/{id} → status atual do pagamento', () => {
    return provider
      .addInteraction({
        states:        [{ description: 'payment exists' }],
        uponReceiving: 'a request to retrieve an Asaas payment status',
        withRequest: {
          method: 'GET',
          path:   `/v3/payments/${ASAAS_PAYMENT_ID}`,
        },
        willRespondWith: {
          status:  200,
          headers: { 'Content-Type': like('application/json') },
          body: {
            id:     like(ASAAS_PAYMENT_ID),
            status: like('PENDING'),
          },
        },
      })
      .executeTest(async (mockServer) => {
        const adapter = new AsaasAdapter(createAsaasHttpClient(mockServer.url), mockLogger)
        const result  = await adapter.getStatus(getStatusInput)

        expect(result.ok).toBe(true)
        if (result.ok) {
          expect(result.value.gatewayPaymentId).toBe(ASAAS_PAYMENT_ID)
          expect(typeof result.value.status).toBe('string')
          expect(result.value.gatewayResponse).toMatchObject({ id: ASAAS_PAYMENT_ID })
        }
      })
  })
})
