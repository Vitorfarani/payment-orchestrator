import request from 'supertest'
import express from 'express'
import type { Express } from 'express'
import { createHmac } from 'crypto'
import { randomUUID } from 'crypto'
import { WebhookController } from '../../../src/web/controllers/WebhookController'
import { ok, err } from '../../../src/domain/shared/Result'
import { PaymentId } from '../../../src/domain/shared/types'
import { BusinessRuleError } from '../../../src/domain/shared/errors'

const STRIPE_SECRET = 'whsec_test_secret_key_for_testing'
const ASAAS_TOKEN   = 'asaas-webhook-token-test-12345'

/**
 * Gera um header Stripe-Signature válido para o corpo e segredo fornecidos.
 */
function makeStripeSignature(rawBody: string, secret: string, timestamp?: number): string {
  const t       = timestamp ?? Math.floor(Date.now() / 1000)
  const payload = `${t}.${rawBody}`
  const sig     = createHmac('sha256', secret).update(payload).digest('hex')
  return `t=${t},v1=${sig}`
}

function makeProcessOutput(paymentId: string) {
  return ok({
    paymentId:      PaymentId.of(paymentId),
    previousStatus: 'PROCESSING' as const,
    newStatus:      'CAPTURED'   as const,
    idempotent:     false,
  })
}

function makeApp(controller: WebhookController): Express {
  const app = express()

  app.post(
    '/webhooks/stripe',
    express.raw({ type: 'application/json' }),
    (req, res, next) => void controller.handleStripe(req, res, next),
  )
  app.post(
    '/webhooks/asaas',
    express.json(),
    (req, res, next) => void controller.handleAsaas(req, res, next),
  )

  return app
}

/** App sem express.raw() — simula rota mal configurada onde body não é Buffer. */
function makeAppNoRaw(controller: WebhookController): Express {
  const app = express()
  app.use(express.json())
  app.post('/webhooks/stripe', (req, res, next) => void controller.handleStripe(req, res, next))
  return app
}

describe('WebhookController', () => {
  let processUC: { execute: jest.Mock }
  let logger:    { warn: jest.Mock; info: jest.Mock }
  let controller: WebhookController
  let app: Express

  beforeEach(() => {
    processUC = { execute: jest.fn() }
    logger    = { warn: jest.fn(), info: jest.fn() }

    process.env['STRIPE_WEBHOOK_SECRET'] = STRIPE_SECRET
    process.env['ASAAS_WEBHOOK_TOKEN']   = ASAAS_TOKEN

    controller = new WebhookController({
      processWebhookUseCase: processUC as any,
      logger:                logger    as any,
    })
    app = makeApp(controller)
  })

  afterEach(() => {
    delete process.env['STRIPE_WEBHOOK_SECRET']
    delete process.env['ASAAS_WEBHOOK_TOKEN']
  })

  // -------------------------------------------------------------------------
  // POST /webhooks/stripe
  // -------------------------------------------------------------------------
  describe('handleStripe', () => {
    it('returns 401 when HMAC signature is invalid', async () => {
      const body = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded', data: { object: {} } })

      const res = await request(app)
        .post('/webhooks/stripe')
        .set('stripe-signature', 'invalid-header')
        .set('content-type', 'application/json')
        .send(body)

      expect(res.status).toBe(401)
      expect(processUC.execute).not.toHaveBeenCalled()
    })

    it('returns 200 silently for unknown event type without calling use case', async () => {
      const body = JSON.stringify({ id: 'evt_1', type: 'unknown.event.type', data: { object: {} } })
      const sig  = makeStripeSignature(body, STRIPE_SECRET)

      const res = await request(app)
        .post('/webhooks/stripe')
        .set('stripe-signature', sig)
        .set('content-type', 'application/json')
        .send(body)

      expect(res.status).toBe(200)
      expect(processUC.execute).not.toHaveBeenCalled()
    })

    it('calls processWebhookUseCase for a known event and returns 200', async () => {
      const paymentId = randomUUID()
      const body = JSON.stringify({
        id:   'evt_1',
        type: 'payment_intent.succeeded',
        data: { object: { metadata: { payment_id: paymentId } } },
      })
      const sig = makeStripeSignature(body, STRIPE_SECRET)
      processUC.execute.mockResolvedValue(makeProcessOutput(paymentId))

      const res = await request(app)
        .post('/webhooks/stripe')
        .set('stripe-signature', sig)
        .set('content-type', 'application/json')
        .send(body)

      expect(res.status).toBe(200)
      expect(res.body['received']).toBe(true)
      expect(processUC.execute).toHaveBeenCalledTimes(1)

      const input = processUC.execute.mock.calls[0][0] as Record<string, unknown>
      expect(input['paymentId']).toBe(paymentId)
      expect(input['newStatus']).toBe('CAPTURED')
      expect(input['eventId']).toBe('evt_1')
    })

    it('returns 200 and swallows business error (log + no retry)', async () => {
      const paymentId = randomUUID()
      const body = JSON.stringify({
        id:   'evt_2',
        type: 'payment_intent.succeeded',
        data: { object: { metadata: { payment_id: paymentId } } },
      })
      const sig = makeStripeSignature(body, STRIPE_SECRET)
      processUC.execute.mockResolvedValue(err(new BusinessRuleError('Invalid transition')))

      const res = await request(app)
        .post('/webhooks/stripe')
        .set('stripe-signature', sig)
        .set('content-type', 'application/json')
        .send(body)

      expect(res.status).toBe(200)
      expect(logger.warn).toHaveBeenCalled()
    })

    it('rejects replay with timestamp older than 300 seconds', async () => {
      const oldTs  = Math.floor(Date.now() / 1000) - 400
      const body   = JSON.stringify({ id: 'evt_old', type: 'payment_intent.succeeded', data: { object: {} } })
      const sig    = makeStripeSignature(body, STRIPE_SECRET, oldTs)

      const res = await request(app)
        .post('/webhooks/stripe')
        .set('stripe-signature', sig)
        .set('content-type', 'application/json')
        .send(body)

      expect(res.status).toBe(401)
      expect(processUC.execute).not.toHaveBeenCalled()
    })

    it('returns 200 silently when payment_id is absent in metadata', async () => {
      const body = JSON.stringify({
        id:   'evt_3',
        type: 'payment_intent.succeeded',
        data: { object: { metadata: {} } },
      })
      const sig = makeStripeSignature(body, STRIPE_SECRET)

      const res = await request(app)
        .post('/webhooks/stripe')
        .set('stripe-signature', sig)
        .set('content-type', 'application/json')
        .send(body)

      expect(res.status).toBe(200)
      expect(processUC.execute).not.toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalled()
    })

    it('returns 200 silently when req.body is not a Buffer (route misconfiguration)', async () => {
      const appNoRaw = makeAppNoRaw(controller)

      const res = await request(appNoRaw)
        .post('/webhooks/stripe')
        .set('stripe-signature', 'any')
        .set('content-type', 'application/json')
        .send({ id: 'evt_1', type: 'payment_intent.succeeded' })

      expect(res.status).toBe(200)
      expect(res.body['received']).toBe(true)
      expect(processUC.execute).not.toHaveBeenCalled()
    })

    it('returns 200 silently when body is valid HMAC but invalid JSON', async () => {
      const rawBody = 'not-json-at-all{'
      const sig     = makeStripeSignature(rawBody, STRIPE_SECRET)

      const res = await request(app)
        .post('/webhooks/stripe')
        .set('stripe-signature', sig)
        .set('content-type', 'application/json')
        .send(rawBody)

      expect(res.status).toBe(200)
      expect(res.body['received']).toBe(true)
      expect(processUC.execute).not.toHaveBeenCalled()
    })

    it('returns 200 silently when parsed JSON does not match Stripe schema', async () => {
      const body = JSON.stringify({ unexpected_field: 'no id or type here' })
      const sig  = makeStripeSignature(body, STRIPE_SECRET)

      const res = await request(app)
        .post('/webhooks/stripe')
        .set('stripe-signature', sig)
        .set('content-type', 'application/json')
        .send(body)

      expect(res.status).toBe(200)
      expect(res.body['received']).toBe(true)
      expect(processUC.execute).not.toHaveBeenCalled()
    })

    it('returns 200 silently when payment_id is not a valid UUID', async () => {
      const body = JSON.stringify({
        id:   'evt_bad_uuid',
        type: 'payment_intent.succeeded',
        data: { object: { metadata: { payment_id: 'not-a-uuid' } } },
      })
      const sig = makeStripeSignature(body, STRIPE_SECRET)

      const res = await request(app)
        .post('/webhooks/stripe')
        .set('stripe-signature', sig)
        .set('content-type', 'application/json')
        .send(body)

      expect(res.status).toBe(200)
      expect(res.body['received']).toBe(true)
      expect(processUC.execute).not.toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalled()
    })

    it('maps charge.dispute.closed correctly (won/lost)', async () => {
      const paymentId = randomUUID()

      // won
      const bodyWon = JSON.stringify({
        id:   'evt_won',
        type: 'charge.dispute.closed',
        data: { object: { status: 'won', metadata: { payment_id: paymentId } } },
      })
      const sigWon = makeStripeSignature(bodyWon, STRIPE_SECRET)
      processUC.execute.mockResolvedValue(makeProcessOutput(paymentId))

      await request(app)
        .post('/webhooks/stripe')
        .set('stripe-signature', sigWon)
        .set('content-type', 'application/json')
        .send(bodyWon)

      expect(processUC.execute.mock.calls[0][0]).toMatchObject({ newStatus: 'CHARGEBACK_WON' })

      processUC.execute.mockClear()

      // lost
      const bodyLost = JSON.stringify({
        id:   'evt_lost',
        type: 'charge.dispute.closed',
        data: { object: { status: 'lost', metadata: { payment_id: paymentId } } },
      })
      const sigLost = makeStripeSignature(bodyLost, STRIPE_SECRET)
      processUC.execute.mockResolvedValue(makeProcessOutput(paymentId))

      await request(app)
        .post('/webhooks/stripe')
        .set('stripe-signature', sigLost)
        .set('content-type', 'application/json')
        .send(bodyLost)

      expect(processUC.execute.mock.calls[0][0]).toMatchObject({ newStatus: 'CHARGEBACK_LOST' })
    })
  })

  // -------------------------------------------------------------------------
  // POST /webhooks/asaas
  // -------------------------------------------------------------------------
  describe('handleAsaas', () => {
    it('returns 401 when asaas-access-token is incorrect', async () => {
      const res = await request(app)
        .post('/webhooks/asaas')
        .set('asaas-access-token', 'wrong-token')
        .send({ event: 'PAYMENT_AUTHORIZED', payment: { id: randomUUID() } })

      expect(res.status).toBe(401)
      expect(processUC.execute).not.toHaveBeenCalled()
    })

    it('returns 200 and calls use case when token is valid', async () => {
      const paymentId = randomUUID()
      processUC.execute.mockResolvedValue(ok({
        paymentId:      PaymentId.of(paymentId),
        previousStatus: 'PENDING'    as const,
        newStatus:      'AUTHORIZED' as const,
        idempotent:     false,
      }))

      const res = await request(app)
        .post('/webhooks/asaas')
        .set('asaas-access-token', ASAAS_TOKEN)
        .send({ event: 'PAYMENT_AUTHORIZED', payment: { id: paymentId } })

      expect(res.status).toBe(200)
      expect(res.body['received']).toBe(true)
      expect(processUC.execute).toHaveBeenCalledTimes(1)
    })

    it('returns 200 silently for unknown Asaas event without calling use case', async () => {
      const res = await request(app)
        .post('/webhooks/asaas')
        .set('asaas-access-token', ASAAS_TOKEN)
        .send({ event: 'PAYMENT_UNKNOWN_EVENT', payment: { id: randomUUID() } })

      expect(res.status).toBe(200)
      expect(processUC.execute).not.toHaveBeenCalled()
    })

    it('returns 200 silently when Asaas body does not match schema', async () => {
      const res = await request(app)
        .post('/webhooks/asaas')
        .set('asaas-access-token', ASAAS_TOKEN)
        .send({ unexpected_field: 'no event or payment' })

      expect(res.status).toBe(200)
      expect(res.body['received']).toBe(true)
      expect(processUC.execute).not.toHaveBeenCalled()
    })

    it('returns 200 silently when Asaas payment.id is not a valid UUID', async () => {
      const res = await request(app)
        .post('/webhooks/asaas')
        .set('asaas-access-token', ASAAS_TOKEN)
        .send({ event: 'PAYMENT_AUTHORIZED', payment: { id: 'cus_not_a_uuid' } })

      expect(res.status).toBe(200)
      expect(res.body['received']).toBe(true)
      expect(processUC.execute).not.toHaveBeenCalled()
    })
  })
})
