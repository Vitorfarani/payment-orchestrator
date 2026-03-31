import request from 'supertest'
import express from 'express'
import type { Express, Request, Response, NextFunction } from 'express'
import { randomUUID } from 'crypto'
import { PaymentController } from '../../../src/web/controllers/PaymentController'
import { NotFoundError, BusinessRuleError } from '../../../src/domain/shared/errors'
import { ok, err } from '../../../src/domain/shared/Result'
import type { GetPaymentOutput } from '../../../src/application/payment/GetPaymentUseCase'
import { PaymentId, SellerId, Cents } from '../../../src/domain/shared/types'

const MERCHANT_ID     = 'test-merchant'
const IDEMPOTENCY_KEY = 'test-idempotency-key-12345'

function makeGetPaymentOutput(
  paymentId: string,
  status: GetPaymentOutput['status'] = 'CAPTURED',
): GetPaymentOutput {
  return {
    id:          PaymentId.of(paymentId),
    sellerId:    SellerId.create(),
    amountCents: Cents.of(10000),
    status,
    createdAt:   new Date('2024-01-01T00:00:00Z'),
    updatedAt:   new Date('2024-01-01T01:00:00Z'),
  }
}

function makeApp(controller: PaymentController): Express {
  const app = express()
  app.use(express.json())

  // Inject locals que normalmente os middlewares de auth/requestContext adicionam
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.locals['merchantId'] = MERCHANT_ID
    res.locals['requestId']  = 'req-test-id'
    next()
  })

  app.post('/payments',          (req, res, next) => void controller.create(req, res, next))
  app.get('/payments/:id',       (req, res, next) => void controller.getById(req, res, next))
  app.post('/payments/:id/refund', (req, res, next) => void controller.refund(req, res, next))

  // Error handler mínimo para testes
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: (err as Error).message, code: err.code })
    } else if (err instanceof BusinessRuleError) {
      res.status(409).json({ error: (err as Error).message, code: err.code })
    } else {
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  return app
}

describe('PaymentController', () => {
  let createUC:    { execute: jest.Mock }
  let getUC:       { execute: jest.Mock }
  let refundUC:    { execute: jest.Mock }
  let auditLogRepo: { save: jest.Mock }
  let masker:      { mask: jest.Mock }
  let controller:  PaymentController
  let app:         Express

  beforeEach(() => {
    createUC     = { execute: jest.fn() }
    getUC        = { execute: jest.fn() }
    refundUC     = { execute: jest.fn() }
    auditLogRepo = { save: jest.fn().mockResolvedValue(undefined) }
    masker       = { mask: jest.fn((data: Record<string, unknown>) => data) }

    controller = new PaymentController({
      createPaymentUseCase: createUC as any,
      getPaymentUseCase:    getUC    as any,
      refundPaymentUseCase: refundUC as any,
      auditLogRepo:         auditLogRepo as any,
      masker:               masker as any,
    })
    app = makeApp(controller)
  })

  // -------------------------------------------------------------------------
  // POST /payments
  // -------------------------------------------------------------------------
  describe('create (POST /payments)', () => {
    it('returns 400 IDEMPOTENCY_KEY_MISSING when x-idempotency-key header is absent', async () => {
      const res = await request(app)
        .post('/payments')
        .send({ sellerId: randomUUID(), amountCents: 1000 })

      expect(res.status).toBe(400)
      expect(res.body['code']).toBe('IDEMPOTENCY_KEY_MISSING')
      expect(createUC.execute).not.toHaveBeenCalled()
    })

    it('returns 422 when amountCents is negative', async () => {
      const res = await request(app)
        .post('/payments')
        .set('x-idempotency-key', IDEMPOTENCY_KEY)
        .send({ sellerId: randomUUID(), amountCents: -100 })

      expect(res.status).toBe(422)
      expect(createUC.execute).not.toHaveBeenCalled()
    })

    it('returns 422 when sellerId is not a valid UUID', async () => {
      const res = await request(app)
        .post('/payments')
        .set('x-idempotency-key', IDEMPOTENCY_KEY)
        .send({ sellerId: 'not-a-uuid', amountCents: 1000 })

      expect(res.status).toBe(422)
      expect(createUC.execute).not.toHaveBeenCalled()
    })

    it('returns 201 with { id, status: PROCESSING, pollUrl } on happy path', async () => {
      const paymentId = randomUUID()
      createUC.execute.mockResolvedValue(ok({ paymentId: PaymentId.of(paymentId) }))

      const res = await request(app)
        .post('/payments')
        .set('x-idempotency-key', IDEMPOTENCY_KEY)
        .send({ sellerId: randomUUID(), amountCents: 5000 })

      expect(res.status).toBe(201)
      expect(res.body['id']).toBe(paymentId)
      expect(res.body['status']).toBe('PROCESSING')
      expect(res.body['pollUrl']).toBe(`/payments/${paymentId}`)
    })

    it('writes audit log payment.created with actorId on success', async () => {
      const paymentId = randomUUID()
      createUC.execute.mockResolvedValue(ok({ paymentId: PaymentId.of(paymentId) }))

      await request(app)
        .post('/payments')
        .set('x-idempotency-key', IDEMPOTENCY_KEY)
        .send({ sellerId: randomUUID(), amountCents: 5000 })

      expect(auditLogRepo.save).toHaveBeenCalledTimes(1)
      const entry = auditLogRepo.save.mock.calls[0][0] as Record<string, unknown>
      expect(entry['action']).toBe('payment.created')
      expect(entry['actorId']).toBe(MERCHANT_ID)
      expect(entry['resourceId']).toBe(paymentId)
    })

    it('propagates Result.err to next() without writing audit log', async () => {
      const notFound = new NotFoundError('Payment', 'pay-x')
      createUC.execute.mockResolvedValue(err(notFound))

      const res = await request(app)
        .post('/payments')
        .set('x-idempotency-key', IDEMPOTENCY_KEY)
        .send({ sellerId: randomUUID(), amountCents: 5000 })

      expect(res.status).toBe(404)
      expect(auditLogRepo.save).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // GET /payments/:id
  // -------------------------------------------------------------------------
  describe('getById (GET /payments/:id)', () => {
    it('returns 422 when payment ID is not a valid UUID', async () => {
      const res = await request(app).get('/payments/not-a-uuid')
      expect(res.status).toBe(422)
      expect(getUC.execute).not.toHaveBeenCalled()
    })

    it('returns 404 via NotFoundError', async () => {
      getUC.execute.mockResolvedValue(err(new NotFoundError('Payment', randomUUID())))

      const res = await request(app).get(`/payments/${randomUUID()}`)

      expect(res.status).toBe(404)
    })

    it('returns 200 with DTO — sensitive fields absent', async () => {
      const paymentId = randomUUID()
      getUC.execute.mockResolvedValue(ok(makeGetPaymentOutput(paymentId)))

      const res = await request(app).get(`/payments/${paymentId}`)

      expect(res.status).toBe(200)
      expect(res.body['id']).toBe(paymentId)
      expect(res.body['status']).toBe('CAPTURED')
      expect(res.body['amountCents']).toBe(10000)
      expect(res.body['pollUrl']).toBe(`/payments/${paymentId}`)
      // Campos sensíveis / internos devem estar ausentes
      expect(res.body['gateway']).toBeUndefined()
      expect(res.body['gatewayPaymentId']).toBeUndefined()
      expect(res.body['gatewayResponse']).toBeUndefined()
      expect(res.body['errorMessage']).toBeUndefined()
      expect(res.body['metadata']).toBeUndefined()
    })

    it('sets Retry-After: 2 header when status is PROCESSING', async () => {
      const paymentId = randomUUID()
      getUC.execute.mockResolvedValue(ok(makeGetPaymentOutput(paymentId, 'PROCESSING')))

      const res = await request(app).get(`/payments/${paymentId}`)

      expect(res.status).toBe(200)
      expect(res.headers['retry-after']).toBe('2')
    })

    it('sets Retry-After: 2 header when status is PENDING', async () => {
      const paymentId = randomUUID()
      getUC.execute.mockResolvedValue(ok(makeGetPaymentOutput(paymentId, 'PENDING')))

      const res = await request(app).get(`/payments/${paymentId}`)

      expect(res.status).toBe(200)
      expect(res.headers['retry-after']).toBe('2')
    })

    it('does not set Retry-After header when status is CAPTURED', async () => {
      const paymentId = randomUUID()
      getUC.execute.mockResolvedValue(ok(makeGetPaymentOutput(paymentId, 'CAPTURED')))

      const res = await request(app).get(`/payments/${paymentId}`)

      expect(res.status).toBe(200)
      expect(res.headers['retry-after']).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // POST /payments/:id/refund
  // -------------------------------------------------------------------------
  describe('refund (POST /payments/:id/refund)', () => {
    it('returns 400 IDEMPOTENCY_KEY_MISSING when x-idempotency-key is absent', async () => {
      const res = await request(app)
        .post(`/payments/${randomUUID()}/refund`)
        .send({})

      expect(res.status).toBe(400)
      expect(res.body['code']).toBe('IDEMPOTENCY_KEY_MISSING')
      expect(refundUC.execute).not.toHaveBeenCalled()
    })

    it('returns 422 when payment ID is invalid', async () => {
      const res = await request(app)
        .post('/payments/not-a-uuid/refund')
        .set('x-idempotency-key', IDEMPOTENCY_KEY)
        .send({})

      expect(res.status).toBe(422)
      expect(refundUC.execute).not.toHaveBeenCalled()
    })

    it('returns 200 with split amounts on happy path', async () => {
      const paymentId = randomUUID()
      refundUC.execute.mockResolvedValue(ok({
        paymentId:         PaymentId.of(paymentId),
        refundAmountCents: Cents.of(10000),
        platformRefund:    Cents.of(1000),
        sellerRefund:      Cents.of(9000),
      }))

      const res = await request(app)
        .post(`/payments/${paymentId}/refund`)
        .set('x-idempotency-key', IDEMPOTENCY_KEY)
        .send({ amountCents: 10000 })

      expect(res.status).toBe(200)
      expect(res.body['paymentId']).toBe(paymentId)
      expect(res.body['refundAmountCents']).toBe(10000)
      expect(res.body['platformRefund']).toBe(1000)
      expect(res.body['sellerRefund']).toBe(9000)
    })

    it('performs full refund when amountCents is absent from body', async () => {
      const paymentId = randomUUID()
      refundUC.execute.mockResolvedValue(ok({
        paymentId:         PaymentId.of(paymentId),
        refundAmountCents: Cents.of(5000),
        platformRefund:    Cents.of(500),
        sellerRefund:      Cents.of(4500),
      }))

      const res = await request(app)
        .post(`/payments/${paymentId}/refund`)
        .set('x-idempotency-key', IDEMPOTENCY_KEY)
        .send({})

      expect(res.status).toBe(200)
      const call = refundUC.execute.mock.calls[0][0] as Record<string, unknown>
      expect(call['refundAmountCents']).toBeUndefined()
    })

    it('writes audit log payment.refunded on success', async () => {
      const paymentId = randomUUID()
      refundUC.execute.mockResolvedValue(ok({
        paymentId:         PaymentId.of(paymentId),
        refundAmountCents: Cents.of(10000),
        platformRefund:    Cents.of(1000),
        sellerRefund:      Cents.of(9000),
      }))

      await request(app)
        .post(`/payments/${paymentId}/refund`)
        .set('x-idempotency-key', IDEMPOTENCY_KEY)
        .send({})

      expect(auditLogRepo.save).toHaveBeenCalledTimes(1)
      const entry = auditLogRepo.save.mock.calls[0][0] as Record<string, unknown>
      expect(entry['action']).toBe('payment.refunded')
      expect(entry['actorId']).toBe(MERCHANT_ID)
    })

    it('propagates Result.err to next()', async () => {
      refundUC.execute.mockResolvedValue(err(new BusinessRuleError('Refund exceeds payment')))

      const res = await request(app)
        .post(`/payments/${randomUUID()}/refund`)
        .set('x-idempotency-key', IDEMPOTENCY_KEY)
        .send({})

      expect(res.status).toBe(409)
      expect(auditLogRepo.save).not.toHaveBeenCalled()
    })
  })
})
