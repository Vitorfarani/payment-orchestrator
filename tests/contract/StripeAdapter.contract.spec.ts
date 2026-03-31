/**
 * Contract tests — StripeAdapter como consumer da Stripe API (ADR-020).
 *
 * Cada interação testa um endpoint real da Stripe API usando um mock Pact.
 * O mock registra as interações em pacts/payment-orchestrator-stripe-api.json.
 *
 * Para executar: npm run test:contract
 */

import path from 'path'
import { PactV3, MatchersV3 } from '@pact-foundation/pact'
import type { Logger } from 'pino'
import type {
  StripeClient,
  StripePaymentIntentObject,
  StripeRefundObject,
} from '../../src/infrastructure/gateway/StripeAdapter'
import { StripeAdapter } from '../../src/infrastructure/gateway/StripeAdapter'
import { PaymentId, IdempotencyKey, Cents } from '../../src/domain/shared/types'

const { like } = MatchersV3

// ─── Fixtures ────────────────────────────────────────────────────────────────

const PAYMENT_INTENT_ID = 'pi_contract_test_abc123'
const REFUND_ID         = 're_contract_test_xyz789'

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

// ─── Pact provider (mock Stripe API) ─────────────────────────────────────────

const provider = new PactV3({
  consumer:  'payment-orchestrator',
  provider:  'stripe-api',
  dir:       path.resolve(process.cwd(), 'pacts'),
  logLevel:  'error',
})

// ─── HTTP implementation of StripeClient for Pact tests ──────────────────────
// Faz chamadas HTTP reais ao mock server do Pact em vez de usar o SDK stripe.

function createStripeHttpClient(baseUrl: string): StripeClient {
  async function stripePost(
    endpointPath: string,
    body: Record<string, string> = {},
    idempotencyKey?: string,
  ): Promise<StripePaymentIntentObject | StripeRefundObject> {
    const headers: Record<string, string> = {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': 'Bearer sk_test_contract',
    }
    if (idempotencyKey !== undefined) {
      headers['Idempotency-Key'] = idempotencyKey
    }

    const res  = await fetch(`${baseUrl}${endpointPath}`, {
      method:  'POST',
      headers,
      body:    new URLSearchParams(body).toString(),
    })
    const data = await res.json() as Record<string, unknown>

    if (!res.ok) {
      const errObj  = data['error']
      const message =
        typeof errObj === 'object' && errObj !== null
          ? String((errObj as Record<string, unknown>)['message'] ?? 'Stripe error')
          : 'Stripe API error'
      const stripeErr = new Error(message)
      ;(stripeErr as Error & { statusCode: number }).statusCode = res.status
      throw stripeErr
    }

    return data as unknown as StripePaymentIntentObject | StripeRefundObject
  }

  async function stripeGet(endpointPath: string): Promise<StripePaymentIntentObject> {
    const res = await fetch(`${baseUrl}${endpointPath}`, {
      headers: { 'Authorization': 'Bearer sk_test_contract' },
    })
    return res.json() as Promise<StripePaymentIntentObject>
  }

  return {
    paymentIntents: {
      create: (params, options) =>
        stripePost(
          '/v1/payment_intents',
          {
            amount:         String(params.amount),
            currency:       params.currency,
            capture_method: params.capture_method,
          },
          options?.idempotencyKey,
        ) as Promise<StripePaymentIntentObject>,

      capture: (id) =>
        stripePost(`/v1/payment_intents/${id}/capture`) as Promise<StripePaymentIntentObject>,

      retrieve: (id) => stripeGet(`/v1/payment_intents/${id}`),
    },

    refunds: {
      create: (params, options) =>
        stripePost(
          '/v1/refunds',
          {
            payment_intent: params.payment_intent,
            amount:         String(params.amount),
          },
          options?.idempotencyKey,
        ) as Promise<StripeRefundObject>,
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

const captureInput   = { gatewayPaymentId: PAYMENT_INTENT_ID }

const refundInput = {
  gatewayPaymentId: PAYMENT_INTENT_ID,
  amount:           Cents.of(2500),
  idempotencyKey:   IdempotencyKey.generate(),
}

const getStatusInput = { gatewayPaymentId: PAYMENT_INTENT_ID }

// ─── Testes ──────────────────────────────────────────────────────────────────

describe('StripeAdapter — Pact contract', () => {
  it('1. POST /v1/payment_intents → autorização bem-sucedida (status: requires_capture)', () => {
    return provider
      .addInteraction({
        states:        [{ description: 'card can be authorized' }],
        uponReceiving: 'a request to authorize a payment intent',
        withRequest: {
          method:  'POST',
          path:    '/v1/payment_intents',
          headers: { 'Content-Type': like('application/x-www-form-urlencoded') },
        },
        willRespondWith: {
          status:  200,
          headers: { 'Content-Type': like('application/json') },
          body: {
            id:     like(PAYMENT_INTENT_ID),
            status: like('requires_capture'),
          },
        },
      })
      .executeTest(async (mockServer) => {
        const adapter = new StripeAdapter(createStripeHttpClient(mockServer.url), mockLogger)
        const result  = await adapter.authorize(authorizeInput)

        expect(result.ok).toBe(true)
        if (result.ok) {
          expect(result.value.status).toBe('authorized')
          expect(typeof result.value.gatewayPaymentId).toBe('string')
          expect(result.value.gatewayResponse).toMatchObject({ status: 'requires_capture' })
        }
      })
  })

  it('2. POST /v1/payment_intents/{id}/capture → captura bem-sucedida (status: succeeded)', () => {
    return provider
      .addInteraction({
        states:        [{ description: 'payment intent can be captured' }],
        uponReceiving: 'a request to capture a payment intent',
        withRequest: {
          method:  'POST',
          path:    `/v1/payment_intents/${PAYMENT_INTENT_ID}/capture`,
          headers: { 'Content-Type': like('application/x-www-form-urlencoded') },
        },
        willRespondWith: {
          status:  200,
          headers: { 'Content-Type': like('application/json') },
          body: {
            id:     like(PAYMENT_INTENT_ID),
            status: like('succeeded'),
          },
        },
      })
      .executeTest(async (mockServer) => {
        const adapter = new StripeAdapter(createStripeHttpClient(mockServer.url), mockLogger)
        const result  = await adapter.capture(captureInput)

        expect(result.ok).toBe(true)
        if (result.ok) {
          expect(result.value.gatewayPaymentId).toBe(PAYMENT_INTENT_ID)
          expect(result.value.gatewayResponse).toMatchObject({ status: 'succeeded' })
        }
      })
  })

  it('3. POST /v1/refunds → estorno bem-sucedido (status: succeeded)', () => {
    return provider
      .addInteraction({
        states:        [{ description: 'payment intent can be refunded' }],
        uponReceiving: 'a request to create a refund',
        withRequest: {
          method:  'POST',
          path:    '/v1/refunds',
          headers: { 'Content-Type': like('application/x-www-form-urlencoded') },
        },
        willRespondWith: {
          status:  200,
          headers: { 'Content-Type': like('application/json') },
          body: {
            id:     like(REFUND_ID),
            status: like('succeeded'),
          },
        },
      })
      .executeTest(async (mockServer) => {
        const adapter = new StripeAdapter(createStripeHttpClient(mockServer.url), mockLogger)
        const result  = await adapter.refund(refundInput)

        expect(result.ok).toBe(true)
        if (result.ok) {
          expect(typeof result.value.refundId).toBe('string')
          expect(result.value.gatewayResponse).toMatchObject({ status: 'succeeded' })
        }
      })
  })

  it('4. GET /v1/payment_intents/{id} → status atual do PaymentIntent', () => {
    return provider
      .addInteraction({
        states:        [{ description: 'payment intent exists' }],
        uponReceiving: 'a request to retrieve payment intent status',
        withRequest: {
          method: 'GET',
          path:   `/v1/payment_intents/${PAYMENT_INTENT_ID}`,
        },
        willRespondWith: {
          status:  200,
          headers: { 'Content-Type': like('application/json') },
          body: {
            id:     like(PAYMENT_INTENT_ID),
            status: like('requires_capture'),
            amount: like(5000),
          },
        },
      })
      .executeTest(async (mockServer) => {
        const adapter = new StripeAdapter(createStripeHttpClient(mockServer.url), mockLogger)
        const result  = await adapter.getStatus(getStatusInput)

        expect(result.ok).toBe(true)
        if (result.ok) {
          expect(result.value.gatewayPaymentId).toBe(PAYMENT_INTENT_ID)
          expect(typeof result.value.status).toBe('string')
          expect(result.value.gatewayResponse).toMatchObject({ id: PAYMENT_INTENT_ID })
        }
      })
  })

  it('5. POST /v1/payment_intents → cartão recusado (402 card_declined)', () => {
    return provider
      .addInteraction({
        states:        [{ description: 'card will be declined' }],
        uponReceiving: 'a request to authorize a payment with a declined card',
        withRequest: {
          method:  'POST',
          path:    '/v1/payment_intents',
          headers: { 'Content-Type': like('application/x-www-form-urlencoded') },
        },
        willRespondWith: {
          status:  402,
          headers: { 'Content-Type': like('application/json') },
          body: {
            error: {
              code:    like('card_declined'),
              message: like('Your card was declined.'),
            },
          },
        },
      })
      .executeTest(async (mockServer) => {
        const adapter = new StripeAdapter(createStripeHttpClient(mockServer.url), mockLogger)
        const result  = await adapter.authorize(authorizeInput)

        // 402 é erro de negócio (< 500) — isInfrastructureError retorna false
        // O adapter retorna err(GatewayError('STRIPE_ERROR')) sem abrir o CB
        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.error.code).toBe('STRIPE_ERROR')
          expect(result.error.message).toContain('declined')
        }
      })
  })
})
