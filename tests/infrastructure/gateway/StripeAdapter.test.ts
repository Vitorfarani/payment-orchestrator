import type { Logger } from 'pino'
import type {
  StripeClient,
  StripePaymentIntentObject,
  StripeRefundObject,
} from '../../../src/infrastructure/gateway/StripeAdapter'
import { StripeAdapter } from '../../../src/infrastructure/gateway/StripeAdapter'
import type { AuthorizeInput, CaptureInput, RefundInput, GetStatusInput } from '../../../src/domain/payment/IPaymentGateway'
import { PaymentId, IdempotencyKey, Cents } from '../../../src/domain/shared/types'

// ─── Helpers de erro ──────────────────────────────────────────────────────────

function connectionError(): Error {
  const e = new Error('Connection failed')
  e.name = 'StripeConnectionError'
  return e
}

/** Erro 5xx — deve abrir o circuit breaker */
function serverError(): Error {
  return Object.assign(new Error('Internal Server Error'), { statusCode: 500 })
}

/** Erro 4xx — erro de negócio, NÃO deve abrir o circuit breaker */
function cardDeclinedError(): Error {
  return Object.assign(new Error('Your card was declined'), { statusCode: 402 })
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PI_AUTHORIZED: StripePaymentIntentObject = { id: 'pi_test', status: 'requires_capture' }
const PI_ACTION:     StripePaymentIntentObject = { id: 'pi_test', status: 'requires_action'  }
const PI_CAPTURED:   StripePaymentIntentObject = { id: 'pi_test', status: 'succeeded'        }
const RE_SUCCESS:    StripeRefundObject        = { id: 're_test', status: 'succeeded'        }

const authorizeInput: AuthorizeInput = {
  paymentId:      PaymentId.create(),
  idempotencyKey: IdempotencyKey.generate(),
  amount:         Cents.of(5000),
  currency:       'BRL',
}

const captureInput: CaptureInput = {
  gatewayPaymentId: 'pi_test',
}

const refundInput: RefundInput = {
  gatewayPaymentId: 'pi_test',
  amount:           Cents.of(5000),
  idempotencyKey:   IdempotencyKey.generate(),
}

const getStatusInput: GetStatusInput = {
  gatewayPaymentId: 'pi_test',
}

// ─── Factory de mocks ─────────────────────────────────────────────────────────

interface StripeMocks {
  stripe:     StripeClient
  createFn:   jest.Mock
  captureFn:  jest.Mock
  retrieveFn: jest.Mock
  refundFn:   jest.Mock
}

function makeStripe(): StripeMocks {
  const createFn   = jest.fn().mockResolvedValue(PI_AUTHORIZED)
  const captureFn  = jest.fn().mockResolvedValue(PI_CAPTURED)
  const retrieveFn = jest.fn().mockResolvedValue(PI_AUTHORIZED)
  const refundFn   = jest.fn().mockResolvedValue(RE_SUCCESS)

  const stripe: StripeClient = {
    paymentIntents: {
      create:   createFn   as StripeClient['paymentIntents']['create'],
      capture:  captureFn  as StripeClient['paymentIntents']['capture'],
      retrieve: retrieveFn as StripeClient['paymentIntents']['retrieve'],
    },
    refunds: {
      create: refundFn as StripeClient['refunds']['create'],
    },
  }

  return { stripe, createFn, captureFn, retrieveFn, refundFn }
}

const mockLogger = {
  warn:  jest.fn(),
  info:  jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  fatal: jest.fn(),
  child: jest.fn(),
} as unknown as Logger

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('StripeAdapter', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ── authorize() ─────────────────────────────────────────────────────────────

  describe('authorize()', () => {
    it('retorna status authorized quando Stripe retorna requires_capture', async () => {
      const { stripe } = makeStripe()
      const adapter = new StripeAdapter(stripe, mockLogger)

      const result = await adapter.authorize(authorizeInput)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.status).toBe('authorized')
        expect(result.value.gatewayPaymentId).toBe('pi_test')
        expect(result.value.gatewayResponse).toMatchObject({ id: 'pi_test', status: 'requires_capture' })
      }
    })

    it('retorna status requires_action quando Stripe retorna requires_action', async () => {
      const { stripe, createFn } = makeStripe()
      createFn.mockResolvedValue(PI_ACTION)
      const adapter = new StripeAdapter(stripe, mockLogger)

      const result = await adapter.authorize(authorizeInput)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.status).toBe('requires_action')
      }
    })

    it('retorna UNEXPECTED_STATUS quando Stripe retorna status desconhecido', async () => {
      const { stripe, createFn } = makeStripe()
      createFn.mockResolvedValue({ id: 'pi_test', status: 'canceled' })
      const adapter = new StripeAdapter(stripe, mockLogger)

      const result = await adapter.authorize(authorizeInput)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('UNEXPECTED_STATUS')
      }
    })

    it('retorna STRIPE_ERROR para erro de negócio (4xx) sem abrir o circuit breaker', async () => {
      const { stripe, createFn } = makeStripe()
      createFn.mockRejectedValue(cardDeclinedError())
      const adapter = new StripeAdapter(stripe, mockLogger)

      const result = await adapter.authorize(authorizeInput)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('STRIPE_ERROR')
        expect(result.error.message).toBe('Your card was declined')
      }
    })

    it('retorna CIRCUIT_OPEN e dispara o CB para StripeConnectionError', async () => {
      const { stripe, createFn } = makeStripe()
      createFn.mockRejectedValue(connectionError())
      const adapter = new StripeAdapter(stripe, mockLogger)

      const result = await adapter.authorize(authorizeInput)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('CIRCUIT_OPEN')
      }
    })

    it('retorna CIRCUIT_OPEN e dispara o CB para erros 5xx', async () => {
      const { stripe, createFn } = makeStripe()
      createFn.mockRejectedValue(serverError())
      const adapter = new StripeAdapter(stripe, mockLogger)

      const result = await adapter.authorize(authorizeInput)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('CIRCUIT_OPEN')
      }
    })

    it('passa currency em lowercase para o Stripe', async () => {
      const { stripe, createFn } = makeStripe()
      const adapter = new StripeAdapter(stripe, mockLogger)

      await adapter.authorize({ ...authorizeInput, currency: 'BRL' })

      expect(createFn).toHaveBeenCalledWith(
        expect.objectContaining({ currency: 'brl' }),
        expect.anything(),
      )
    })

    it('passa capture_method manual para o Stripe', async () => {
      const { stripe, createFn } = makeStripe()
      const adapter = new StripeAdapter(stripe, mockLogger)

      await adapter.authorize(authorizeInput)

      expect(createFn).toHaveBeenCalledWith(
        expect.objectContaining({ capture_method: 'manual' }),
        expect.anything(),
      )
    })

    it('passa idempotency key para o Stripe', async () => {
      const { stripe, createFn } = makeStripe()
      const adapter = new StripeAdapter(stripe, mockLogger)
      const key = IdempotencyKey.of('key-idempotente-12')

      await adapter.authorize({ ...authorizeInput, idempotencyKey: key })

      expect(createFn).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ idempotencyKey: key }),
      )
    })

    it('converte metadata de unknown para string', async () => {
      const { stripe, createFn } = makeStripe()
      const adapter = new StripeAdapter(stripe, mockLogger)

      await adapter.authorize({ ...authorizeInput, metadata: { orderId: 42, active: true } })

      expect(createFn).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { orderId: '42', active: 'true' } }),
        expect.anything(),
      )
    })

    it('omite metadata quando não fornecido', async () => {
      const { stripe, createFn } = makeStripe()
      const adapter = new StripeAdapter(stripe, mockLogger)

      await adapter.authorize(authorizeInput)

      const params = createFn.mock.calls[0][0] as Record<string, unknown>
      expect(params).not.toHaveProperty('metadata')
    })
  })

  // ── capture() ───────────────────────────────────────────────────────────────

  describe('capture()', () => {
    it('retorna gatewayPaymentId na captura bem-sucedida', async () => {
      const { stripe } = makeStripe()
      const adapter = new StripeAdapter(stripe, mockLogger)

      const result = await adapter.capture(captureInput)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.gatewayPaymentId).toBe('pi_test')
        expect(result.value.gatewayResponse).toMatchObject({ status: 'succeeded' })
      }
    })

    it('retorna STRIPE_ERROR para erro de negócio na captura', async () => {
      const { stripe, captureFn } = makeStripe()
      captureFn.mockRejectedValue(new Error('PaymentIntent cannot be captured'))
      const adapter = new StripeAdapter(stripe, mockLogger)

      const result = await adapter.capture(captureInput)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('STRIPE_ERROR')
        expect(result.error.message).toBe('PaymentIntent cannot be captured')
      }
    })

    it('retorna CIRCUIT_OPEN para erro de infraestrutura na captura', async () => {
      const { stripe, captureFn } = makeStripe()
      captureFn.mockRejectedValue(connectionError())
      const adapter = new StripeAdapter(stripe, mockLogger)

      const result = await adapter.capture(captureInput)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('CIRCUIT_OPEN')
      }
    })
  })

  // ── refund() ────────────────────────────────────────────────────────────────

  describe('refund()', () => {
    it('retorna refundId no reembolso bem-sucedido', async () => {
      const { stripe } = makeStripe()
      const adapter = new StripeAdapter(stripe, mockLogger)

      const result = await adapter.refund(refundInput)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.refundId).toBe('re_test')
        expect(result.value.gatewayResponse).toMatchObject({ id: 're_test' })
      }
    })

    it('passa payment_intent, amount e idempotency key ao Stripe', async () => {
      const { stripe, refundFn } = makeStripe()
      const adapter = new StripeAdapter(stripe, mockLogger)

      await adapter.refund(refundInput)

      expect(refundFn).toHaveBeenCalledWith(
        expect.objectContaining({ payment_intent: 'pi_test', amount: 5000 }),
        expect.objectContaining({ idempotencyKey: refundInput.idempotencyKey }),
      )
    })

    it('retorna CIRCUIT_OPEN para erro de infraestrutura no reembolso', async () => {
      const { stripe, refundFn } = makeStripe()
      refundFn.mockRejectedValue(serverError())
      const adapter = new StripeAdapter(stripe, mockLogger)

      const result = await adapter.refund(refundInput)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('CIRCUIT_OPEN')
      }
    })
  })

  // ── getStatus() ─────────────────────────────────────────────────────────────

  describe('getStatus()', () => {
    it('retorna id e status atual do PaymentIntent', async () => {
      const { stripe, retrieveFn } = makeStripe()
      retrieveFn.mockResolvedValue({ id: 'pi_test', status: 'requires_capture' })
      const adapter = new StripeAdapter(stripe, mockLogger)

      const result = await adapter.getStatus(getStatusInput)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.gatewayPaymentId).toBe('pi_test')
        expect(result.value.status).toBe('requires_capture')
      }
    })

    it('retorna CIRCUIT_OPEN para erro de infraestrutura em getStatus', async () => {
      const { stripe, retrieveFn } = makeStripe()
      retrieveFn.mockRejectedValue(connectionError())
      const adapter = new StripeAdapter(stripe, mockLogger)

      const result = await adapter.getStatus(getStatusInput)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('CIRCUIT_OPEN')
      }
    })
  })
})
