import type { Logger } from 'pino'
import type {
  AsaasClient,
  AsaasPaymentObject,
  AsaasRefundObject,
} from '../../../src/infrastructure/gateway/AsaasAdapter'
import { AsaasAdapter } from '../../../src/infrastructure/gateway/AsaasAdapter'
import type { AuthorizeInput, CaptureInput, RefundInput, GetStatusInput } from '../../../src/domain/payment/IPaymentGateway'
import { PaymentId, IdempotencyKey, Cents } from '../../../src/domain/shared/types'

// ─── Helpers de erro ──────────────────────────────────────────────────────────

function connectionError(): Error {
  const e = new Error('Connection failed')
  e.name = 'AsaasConnectionError'
  return e
}

/** Erro 5xx — deve abrir o circuit breaker */
function serverError(): Error {
  return Object.assign(new Error('Internal Server Error'), { statusCode: 500 })
}

/** Erro 4xx — erro de negócio, NÃO deve abrir o circuit breaker */
function businessError(): Error {
  return Object.assign(new Error('Payment already captured'), { statusCode: 400 })
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PAY_PENDING:  AsaasPaymentObject = { id: 'pay_test', status: 'PENDING'                }
const PAY_RISK:     AsaasPaymentObject = { id: 'pay_test', status: 'AWAITING_RISK_ANALYSIS' }
const PAY_RECEIVED: AsaasPaymentObject = { id: 'pay_test', status: 'RECEIVED'               }
const RE_SUCCESS:   AsaasRefundObject  = { id: 'ref_test', status: 'REFUNDED'               }

const authorizeInput: AuthorizeInput = {
  paymentId:      PaymentId.create(),
  idempotencyKey: IdempotencyKey.generate(),
  amount:         Cents.of(5000),
  currency:       'BRL',
}

const captureInput: CaptureInput = {
  gatewayPaymentId: 'pay_test',
}

const refundInput: RefundInput = {
  gatewayPaymentId: 'pay_test',
  amount:           Cents.of(5000),
  idempotencyKey:   IdempotencyKey.generate(),
}

const getStatusInput: GetStatusInput = {
  gatewayPaymentId: 'pay_test',
}

// ─── Factory de mocks ─────────────────────────────────────────────────────────

interface AsaasMocks {
  asaas:      AsaasClient
  createFn:   jest.Mock
  captureFn:  jest.Mock
  retrieveFn: jest.Mock
  refundFn:   jest.Mock
}

function makeAsaas(): AsaasMocks {
  const createFn   = jest.fn().mockResolvedValue(PAY_PENDING)
  const captureFn  = jest.fn().mockResolvedValue(PAY_RECEIVED)
  const retrieveFn = jest.fn().mockResolvedValue(PAY_PENDING)
  const refundFn   = jest.fn().mockResolvedValue(RE_SUCCESS)

  const asaas: AsaasClient = {
    payments: {
      create:   createFn   as AsaasClient['payments']['create'],
      capture:  captureFn  as AsaasClient['payments']['capture'],
      retrieve: retrieveFn as AsaasClient['payments']['retrieve'],
      refund:   refundFn   as AsaasClient['payments']['refund'],
    },
  }

  return { asaas, createFn, captureFn, retrieveFn, refundFn }
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

describe('AsaasAdapter', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ── authorize() ─────────────────────────────────────────────────────────────

  describe('authorize()', () => {
    it('retorna status authorized quando Asaas retorna PENDING', async () => {
      const { asaas } = makeAsaas()
      const adapter = new AsaasAdapter(asaas, mockLogger)

      const result = await adapter.authorize(authorizeInput)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.status).toBe('authorized')
        expect(result.value.gatewayPaymentId).toBe('pay_test')
        expect(result.value.gatewayResponse).toMatchObject({ id: 'pay_test', status: 'PENDING' })
      }
    })

    it('retorna requires_action quando Asaas retorna AWAITING_RISK_ANALYSIS', async () => {
      const { asaas, createFn } = makeAsaas()
      createFn.mockResolvedValue(PAY_RISK)
      const adapter = new AsaasAdapter(asaas, mockLogger)

      const result = await adapter.authorize(authorizeInput)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.status).toBe('requires_action')
      }
    })

    it('retorna UNEXPECTED_STATUS quando Asaas retorna status desconhecido', async () => {
      const { asaas, createFn } = makeAsaas()
      createFn.mockResolvedValue({ id: 'pay_test', status: 'OVERDUE' })
      const adapter = new AsaasAdapter(asaas, mockLogger)

      const result = await adapter.authorize(authorizeInput)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('UNEXPECTED_STATUS')
      }
    })

    it('retorna ASAAS_ERROR para erro de negócio (4xx) sem abrir o circuit breaker', async () => {
      const { asaas, createFn } = makeAsaas()
      createFn.mockRejectedValue(businessError())
      const adapter = new AsaasAdapter(asaas, mockLogger)

      const result = await adapter.authorize(authorizeInput)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('ASAAS_ERROR')
        expect(result.error.message).toBe('Payment already captured')
      }
    })

    it('retorna CIRCUIT_OPEN para AsaasConnectionError', async () => {
      const { asaas, createFn } = makeAsaas()
      createFn.mockRejectedValue(connectionError())
      const adapter = new AsaasAdapter(asaas, mockLogger)

      const result = await adapter.authorize(authorizeInput)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('CIRCUIT_OPEN')
      }
    })

    it('retorna CIRCUIT_OPEN para erros 5xx', async () => {
      const { asaas, createFn } = makeAsaas()
      createFn.mockRejectedValue(serverError())
      const adapter = new AsaasAdapter(asaas, mockLogger)

      const result = await adapter.authorize(authorizeInput)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('CIRCUIT_OPEN')
      }
    })

    it('converte amount de Cents para decimal BRL (÷100)', async () => {
      const { asaas, createFn } = makeAsaas()
      const adapter = new AsaasAdapter(asaas, mockLogger)

      await adapter.authorize({ ...authorizeInput, amount: Cents.of(5000) })

      expect(createFn).toHaveBeenCalledWith(
        expect.objectContaining({ value: 50 }),
        expect.anything(),
      )
    })

    it('passa billingType CREDIT_CARD para o Asaas', async () => {
      const { asaas, createFn } = makeAsaas()
      const adapter = new AsaasAdapter(asaas, mockLogger)

      await adapter.authorize(authorizeInput)

      expect(createFn).toHaveBeenCalledWith(
        expect.objectContaining({ billingType: 'CREDIT_CARD' }),
        expect.anything(),
      )
    })

    it('passa idempotency key para o Asaas', async () => {
      const { asaas, createFn } = makeAsaas()
      const adapter = new AsaasAdapter(asaas, mockLogger)
      const key = IdempotencyKey.of('key-idem-asaas-01')

      await adapter.authorize({ ...authorizeInput, idempotencyKey: key })

      expect(createFn).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ idempotencyKey: key }),
      )
    })

    it('passa paymentId como externalReference para o Asaas', async () => {
      const { asaas, createFn } = makeAsaas()
      const adapter = new AsaasAdapter(asaas, mockLogger)

      await adapter.authorize(authorizeInput)

      expect(createFn).toHaveBeenCalledWith(
        expect.objectContaining({ externalReference: String(authorizeInput.paymentId) }),
        expect.anything(),
      )
    })
  })

  // ── capture() ───────────────────────────────────────────────────────────────

  describe('capture()', () => {
    it('retorna gatewayPaymentId na captura bem-sucedida', async () => {
      const { asaas } = makeAsaas()
      const adapter = new AsaasAdapter(asaas, mockLogger)

      const result = await adapter.capture(captureInput)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.gatewayPaymentId).toBe('pay_test')
        expect(result.value.gatewayResponse).toMatchObject({ status: 'RECEIVED' })
      }
    })

    it('retorna ASAAS_ERROR para erro de negócio na captura', async () => {
      const { asaas, captureFn } = makeAsaas()
      captureFn.mockRejectedValue(new Error('Payment cannot be captured'))
      const adapter = new AsaasAdapter(asaas, mockLogger)

      const result = await adapter.capture(captureInput)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('ASAAS_ERROR')
        expect(result.error.message).toBe('Payment cannot be captured')
      }
    })

    it('retorna CIRCUIT_OPEN para erro de infraestrutura na captura', async () => {
      const { asaas, captureFn } = makeAsaas()
      captureFn.mockRejectedValue(connectionError())
      const adapter = new AsaasAdapter(asaas, mockLogger)

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
      const { asaas } = makeAsaas()
      const adapter = new AsaasAdapter(asaas, mockLogger)

      const result = await adapter.refund(refundInput)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.refundId).toBe('ref_test')
        expect(result.value.gatewayResponse).toMatchObject({ id: 'ref_test' })
      }
    })

    it('converte amount de Cents para decimal BRL no reembolso', async () => {
      const { asaas, refundFn } = makeAsaas()
      const adapter = new AsaasAdapter(asaas, mockLogger)

      await adapter.refund(refundInput)

      expect(refundFn).toHaveBeenCalledWith(
        'pay_test',
        expect.objectContaining({ value: 50 }),
        expect.anything(),
      )
    })

    it('passa gatewayPaymentId e idempotency key corretos no reembolso', async () => {
      const { asaas, refundFn } = makeAsaas()
      const adapter = new AsaasAdapter(asaas, mockLogger)

      await adapter.refund(refundInput)

      expect(refundFn).toHaveBeenCalledWith(
        'pay_test',
        expect.anything(),
        expect.objectContaining({ idempotencyKey: refundInput.idempotencyKey }),
      )
    })

    it('retorna CIRCUIT_OPEN para erro de infraestrutura no reembolso', async () => {
      const { asaas, refundFn } = makeAsaas()
      refundFn.mockRejectedValue(serverError())
      const adapter = new AsaasAdapter(asaas, mockLogger)

      const result = await adapter.refund(refundInput)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('CIRCUIT_OPEN')
      }
    })
  })

  // ── getStatus() ─────────────────────────────────────────────────────────────

  describe('getStatus()', () => {
    it('retorna id e status atual do payment', async () => {
      const { asaas, retrieveFn } = makeAsaas()
      retrieveFn.mockResolvedValue({ id: 'pay_test', status: 'RECEIVED' })
      const adapter = new AsaasAdapter(asaas, mockLogger)

      const result = await adapter.getStatus(getStatusInput)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.gatewayPaymentId).toBe('pay_test')
        expect(result.value.status).toBe('RECEIVED')
      }
    })

    it('retorna CIRCUIT_OPEN para erro de infraestrutura em getStatus', async () => {
      const { asaas, retrieveFn } = makeAsaas()
      retrieveFn.mockRejectedValue(connectionError())
      const adapter = new AsaasAdapter(asaas, mockLogger)

      const result = await adapter.getStatus(getStatusInput)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('CIRCUIT_OPEN')
      }
    })
  })
})
