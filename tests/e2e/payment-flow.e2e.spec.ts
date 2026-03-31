/**
 * E2E tests — fluxo completo de pagamento (ADR-020).
 *
 * Setup: PostgreSQL + Redis reais via Testcontainers.
 * Nenhum mock de infraestrutura — banco, Redis e lógica de domínio reais.
 * Workers NÃO são iniciados — payments permanecem em PENDING/AUTHORIZED conforme
 * inseridos, testando a camada HTTP de forma isolada dos workers.
 *
 * Para executar: npm run test:e2e   (--runInBand obrigatório)
 */

// ─── Env vars — antes de qualquer import que leia process.env em runtime ──────
// Os middlewares leem process.env no momento da requisição (runtime), não no
// import. Portanto, setar aqui garante que estarão disponíveis nos testes.
process.env['JWT_SECRET']            = 'e2e-test-jwt-secret-min-32-chars-ok!!'
process.env['STRIPE_WEBHOOK_SECRET'] = 'whsec_e2e_test_secret_key_xyzabc'
process.env['ASAAS_WEBHOOK_TOKEN']   = 'e2e-asaas-token-test'
process.env['NODE_ENV']              = 'test'

import path          from 'path'
import { createHmac, randomUUID } from 'crypto'
import { GenericContainer, Wait } from 'testcontainers'
import type { StartedTestContainer } from 'testcontainers'
import Knex          from 'knex'
import type { Knex as KnexType } from 'knex'
import { Redis }     from 'ioredis'
import request       from 'supertest'
import jwt           from 'jsonwebtoken'
import pino          from 'pino'
import type { Express } from 'express'

// Infrastructure
import { KnexUnitOfWork }
  from '../../src/infrastructure/database/KnexUnitOfWork'
import { PostgresPaymentRepository }
  from '../../src/infrastructure/database/repositories/PostgresPaymentRepository'
import { PostgresSplitRuleRepository }
  from '../../src/infrastructure/database/repositories/PostgresSplitRuleRepository'
import { LedgerQueryRepository }
  from '../../src/infrastructure/database/repositories/LedgerQueryRepository'
import { PostgresAuditLogRepository }
  from '../../src/infrastructure/database/repositories/PostgresAuditLogRepository'
import { RedisPostgresIdempotencyStore }
  from '../../src/infrastructure/idempotency/IdempotencyStore'
import { SensitiveDataMasker }
  from '../../src/infrastructure/security/SensitiveDataMasker'

// Application
import { CreatePaymentUseCase }  from '../../src/application/payment/CreatePaymentUseCase'
import { GetPaymentUseCase }     from '../../src/application/payment/GetPaymentUseCase'
import { RefundPaymentUseCase }  from '../../src/application/payment/RefundPaymentUseCase'
import { ProcessWebhookUseCase } from '../../src/application/payment/ProcessWebhookUseCase'

// Web
import { createApp } from '../../src/web/app'

// ─── Constants ────────────────────────────────────────────────────────────────

const PG_USER = 'e2e_user'
const PG_PASS = 'e2e_pass'
const PG_DB   = 'e2e_db'

const JWT_SECRET            = process.env['JWT_SECRET'] as string
const STRIPE_WEBHOOK_SECRET = process.env['STRIPE_WEBHOOK_SECRET'] as string

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Gera JWT válido com merchantId, assinado pelo JWT_SECRET de teste. */
function generateValidJwt(merchantId: string): string {
  return jwt.sign({ merchantId, role: 'merchant' }, JWT_SECRET, { expiresIn: '1h' })
}

/**
 * Gera cabeçalho Stripe-Signature válido para o payload dado.
 * Formato: t=TIMESTAMP,v1=HMAC-SHA256
 */
function generateStripeHmac(payload: string, secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000)
  const toSign    = `${timestamp}.${payload}`
  const sig       = createHmac('sha256', secret).update(toSign).digest('hex')
  return `t=${timestamp},v1=${sig}`
}

// ─── Estado compartilhado entre testes ───────────────────────────────────────

const MERCHANT_ID     = randomUUID()
const SELLER_ID       = randomUUID()
const SHARED_IDEM_KEY = `e2e-create-payment-${randomUUID()}`

let pgContainer:    StartedTestContainer
let redisContainer: StartedTestContainer
let db:             KnexType
let redis:          Redis
let app:            Express

// IDs gerados durante os testes e compartilhados entre cenários dependentes
let createdPaymentId: string   // definido no teste 1, usado nos testes 2 e 4
let webhookPaymentId: string   // inserido em beforeAll, usado nos testes 6 e 7
let webhookEventId:   string   // definido no teste 6, reutilizado no teste 7
let webhookBody:      string   // corpo do evento, reutilizado no teste 7

// ─── Setup / Teardown ────────────────────────────────────────────────────────

jest.setTimeout(120_000)

beforeAll(async () => {
  // 1. PostgreSQL
  pgContainer = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_DB:       PG_DB,
      POSTGRES_USER:     PG_USER,
      POSTGRES_PASSWORD: PG_PASS,
    })
    .withExposedPorts(5432)
    .withWaitStrategy(
      Wait.forLogMessage('database system is ready to accept connections', 2),
    )
    .start()

  // 2. Redis
  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start()

  // 3. Conexões
  const pgPort    = pgContainer.getMappedPort(5432)
  const redisPort = redisContainer.getMappedPort(6379)
  const pgUrl     = `postgresql://${PG_USER}:${PG_PASS}@localhost:${pgPort}/${PG_DB}`
  const redisUrl  = `redis://localhost:${redisPort}`

  db = Knex({
    client: 'pg',
    connection: pgUrl,
    pool: { min: 1, max: 5 },
    migrations: {
      directory:      path.resolve(__dirname, '../../src/infrastructure/database/migrations'),
      loadExtensions: ['.ts'],
    },
  })

  redis = new Redis(redisUrl, { maxRetriesPerRequest: null })

  // 4. Migrations
  await db.migrate.latest()

  // 5. Seed: seller necessário para FK em payments
  await db('sellers').insert({
    id:                  SELLER_ID,
    name:                'E2E Test Seller',
    document:            '12345678000100',
    email:               'e2e-seller@test.com',
    settlement_schedule: 'D+14',
    status:              'ACTIVE',
  })

  // 6. Payment com AUTHORIZED para os testes de webhook (6 e 7)
  // Workers não rodam em E2E — inserimos diretamente no estado correto para testar
  // a transição AUTHORIZED → CAPTURED via webhook.
  webhookPaymentId = randomUUID()
  await db('payments').insert({
    id:              webhookPaymentId,
    seller_id:       SELLER_ID,
    amount_cents:    10000,
    currency:        'BRL',
    status:          'AUTHORIZED',
    idempotency_key: `webhook-test-idem-${webhookPaymentId}`,
  })

  // 7. Dependências reais
  const uow              = new KnexUnitOfWork(db)
  const paymentRepo      = new PostgresPaymentRepository(db)
  const splitRuleRepo    = new PostgresSplitRuleRepository(db)
  const ledgerQueryRepo  = new LedgerQueryRepository(db)
  const auditLogRepo     = new PostgresAuditLogRepository(db)
  const idempotencyStore = new RedisPostgresIdempotencyStore(db, redis)
  const masker           = new SensitiveDataMasker()

  // 8. Use cases reais
  const createPaymentUseCase  = new CreatePaymentUseCase(uow)
  const getPaymentUseCase     = new GetPaymentUseCase(paymentRepo)
  const refundPaymentUseCase  = new RefundPaymentUseCase(uow, splitRuleRepo)
  const processWebhookUseCase = new ProcessWebhookUseCase(uow)

  // 9. App Express com logger silencioso para não poluir a saída dos testes
  const logger = pino({ level: 'silent' })

  app = createApp({
    createPaymentUseCase,
    getPaymentUseCase,
    refundPaymentUseCase,
    processWebhookUseCase,
    idempotencyStore,
    ledgerQueryRepo,
    auditLogRepo,
    masker,
    db,
    redis,
    logger,
  })
})

afterAll(async () => {
  await redis.quit()
  await db.destroy()
  await pgContainer.stop()
  await redisContainer.stop()
})

// ─── Cenários ─────────────────────────────────────────────────────────────────

describe('Payment flow — E2E', () => {
  // ── 1. POST /payments happy path ───────────────────────────────────────────

  it('1. POST /payments → 201, body com id e status PROCESSING, payment persiste no banco', async () => {
    const res = await request(app)
      .post('/payments')
      .set('Authorization',     `Bearer ${generateValidJwt(MERCHANT_ID)}`)
      .set('x-idempotency-key', SHARED_IDEM_KEY)
      .send({ sellerId: SELLER_ID, amountCents: 5000 })

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({
      status:  'PROCESSING',
      pollUrl: expect.stringContaining('/payments/'),
    })
    expect(typeof res.body.id).toBe('string')

    createdPaymentId = res.body.id as string

    // Verifica persistência no banco
    const row = await db('payments').where({ id: createdPaymentId }).first()
    expect(row).toBeDefined()
    expect(row.seller_id).toBe(SELLER_ID)
    expect(Number(row.amount_cents)).toBe(5000)
  })

  // ── 2. POST /payments — mesma chave de idempotência ────────────────────────

  it('2. POST /payments com mesma x-idempotency-key → 201, corpo idêntico ao primeiro', async () => {
    const res = await request(app)
      .post('/payments')
      .set('Authorization',     `Bearer ${generateValidJwt(MERCHANT_ID)}`)
      .set('x-idempotency-key', SHARED_IDEM_KEY)
      .send({ sellerId: SELLER_ID, amountCents: 9999 }) // amount diferente — deve ser ignorado

    // Resposta idempotente: mesmo id, mesmo status do primeiro request
    expect(res.status).toBe(201)
    expect(res.body.id).toBe(createdPaymentId)
    expect(res.body.status).toBe('PROCESSING')

    // Sem segundo INSERT no banco: apenas o payment original existe
    const rows = await db('payments').where({ idempotency_key: `${MERCHANT_ID}:${SHARED_IDEM_KEY}` })
    expect(rows.length).toBeLessThanOrEqual(1)
  })

  // ── 3. POST /payments — sem x-idempotency-key ──────────────────────────────

  it('3. POST /payments sem x-idempotency-key → 400 IDEMPOTENCY_KEY_MISSING', async () => {
    const res = await request(app)
      .post('/payments')
      .set('Authorization', `Bearer ${generateValidJwt(MERCHANT_ID)}`)
      .send({ sellerId: SELLER_ID, amountCents: 5000 })

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_MISSING')
  })

  // ── 4. GET /payments/:id após criação ──────────────────────────────────────

  it('4. GET /payments/:id → 200, status pending/processing, header Retry-After: 2 presente', async () => {
    const res = await request(app)
      .get(`/payments/${createdPaymentId}`)
      .set('Authorization', `Bearer ${generateValidJwt(MERCHANT_ID)}`)

    expect(res.status).toBe(200)
    // Payment criado via use case — status inicial é PENDING (worker não rodou)
    expect(['PENDING', 'PROCESSING']).toContain(res.body.status)
    expect(res.headers['retry-after']).toBe('2')
  })

  // ── 5. GET /payments/:nonexistent ──────────────────────────────────────────

  it('5. GET /payments/:id com UUID inexistente → 404', async () => {
    const nonExistentId = randomUUID()
    const res = await request(app)
      .get(`/payments/${nonExistentId}`)
      .set('Authorization', `Bearer ${generateValidJwt(MERCHANT_ID)}`)

    expect(res.status).toBe(404)
  })

  // ── 6. POST /webhooks/stripe — evento válido ────────────────────────────────

  it('6. POST /webhooks/stripe com payment_intent.succeeded e HMAC válido → 200, status CAPTURED no banco', async () => {
    webhookEventId = `evt_e2e_${randomUUID()}`

    webhookBody = JSON.stringify({
      id:   webhookEventId,
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id:       `pi_e2e_${randomUUID()}`,
          status:   'succeeded',
          metadata: { payment_id: webhookPaymentId },
        },
      },
    })

    const signature = generateStripeHmac(webhookBody, STRIPE_WEBHOOK_SECRET)

    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type',      'application/json')
      .set('Stripe-Signature',  signature)
      .send(webhookBody)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ received: true })

    // Status atualizado para CAPTURED no banco
    const row = await db('payments').where({ id: webhookPaymentId }).first()
    expect(row.status).toBe('CAPTURED')
  })

  // ── 7. POST /webhooks/stripe — evento duplicado (idempotência) ──────────────

  it('7. POST /webhooks/stripe com mesmo event.id → 200, status não muda (idempotente)', async () => {
    // Reenvia o mesmo evento — o payment já está CAPTURED
    // ProcessWebhookUseCase detecta "já está no estado alvo" e retorna ok idempotente
    const signature = generateStripeHmac(webhookBody, STRIPE_WEBHOOK_SECRET)

    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type',     'application/json')
      .set('Stripe-Signature', signature)
      .send(webhookBody)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ received: true })

    // Status permanece CAPTURED
    const row = await db('payments').where({ id: webhookPaymentId }).first()
    expect(row.status).toBe('CAPTURED')
  })

  // ── 8. POST /webhooks/stripe — HMAC inválido ───────────────────────────────

  it('8. POST /webhooks/stripe com HMAC inválido → 401', async () => {
    const body = JSON.stringify({
      id:   `evt_invalid_${randomUUID()}`,
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_test', status: 'succeeded', metadata: {} } },
    })

    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type',     'application/json')
      .set('Stripe-Signature', 't=1234567890,v1=invalidsignature')
      .send(body)

    expect(res.status).toBe(401)
    expect(res.body.code).toBe('WEBHOOK_INVALID_SIGNATURE')
  })

  // ── 9. GET /ledger/summary ─────────────────────────────────────────────────

  it('9. GET /ledger/summary?sellerId=... → 200, shape correto com data[] e count', async () => {
    const res = await request(app)
      .get('/ledger/summary')
      .query({ sellerId: SELLER_ID })
      .set('Authorization', `Bearer ${generateValidJwt(MERCHANT_ID)}`)

    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data)).toBe(true)
    expect(typeof res.body.count).toBe('number')
    expect(res.body.count).toBe(res.body.data.length)
  })

  // ── 10. GET /health/live ────────────────────────────────────────────────────

  it('10. GET /health/live → 200 { status: ok }', async () => {
    const res = await request(app).get('/health/live')

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
  })

  // ── 11. GET /health/ready ───────────────────────────────────────────────────

  it('11. GET /health/ready com deps saudáveis → 200 { checks: { postgres: ok, redis: ok } }', async () => {
    const res = await request(app).get('/health/ready')

    expect(res.status).toBe(200)
    expect(res.body.checks).toMatchObject({
      postgres: 'ok',
      redis:    'ok',
    })
  })

  // ── 12. POST /payments sem Authorization ────────────────────────────────────

  it('12. POST /payments sem Authorization header → 401 AUTH_MISSING', async () => {
    const res = await request(app)
      .post('/payments')
      .set('x-idempotency-key', `e2e-no-auth-key-${randomUUID()}`)
      .send({ sellerId: SELLER_ID, amountCents: 5000 })

    expect(res.status).toBe(401)
    expect(res.body.code).toBe('AUTH_MISSING')
  })
})
