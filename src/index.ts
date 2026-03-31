/**
 * Bootstrap da aplicação (ADR-013, ADR-017).
 *
 * ATENÇÃO: initializeTracing() DEVE ser chamado antes de qualquer outro import
 * de infraestrutura para que a instrumentação automática do OpenTelemetry seja
 * aplicada (Express, pg, BullMQ, HTTP clients).
 */

// 1. Tracing — primeiro de tudo (ADR-017)
import { initializeTracing } from './infrastructure/tracing/tracing'
initializeTracing()

import http from 'node:http'
import { Redis } from 'ioredis'
import { Queue, Worker } from 'bullmq'
import type { Job } from 'bullmq'

import { createLogger } from './infrastructure/logger/logger'
import { createApp } from './web/app'

// Infraestrutura — banco
import Knex from 'knex'
import knexConfig from './infrastructure/database/knexfile'
import { KnexUnitOfWork } from './infrastructure/database/KnexUnitOfWork'
import { PostgresPaymentRepository } from './infrastructure/database/repositories/PostgresPaymentRepository'
import { PostgresSplitRuleRepository } from './infrastructure/database/repositories/PostgresSplitRuleRepository'
import { PostgresLedgerRepository } from './infrastructure/database/repositories/PostgresLedgerRepository'
import { PostgresSettlementRepository } from './infrastructure/database/repositories/PostgresSettlementRepository'
import { LedgerQueryRepository } from './infrastructure/database/repositories/LedgerQueryRepository'
import { PostgresAuditLogRepository } from './infrastructure/database/repositories/PostgresAuditLogRepository'

// Infraestrutura — idempotência
import { RedisPostgresIdempotencyStore } from './infrastructure/idempotency/IdempotencyStore'

// Infraestrutura — segurança
import { SensitiveDataMasker } from './infrastructure/security/SensitiveDataMasker'

// Infraestrutura — gateway
import type { StripeClient } from './infrastructure/gateway/StripeAdapter'
import { StripeAdapter } from './infrastructure/gateway/StripeAdapter'

// Infraestrutura — outbox + graceful shutdown
import { OutboxRelay } from './infrastructure/outbox/OutboxRelay'
import type { QueueLike } from './infrastructure/outbox/OutboxRelay'
import { GracefulShutdown } from './infrastructure/GracefulShutdown'

// Infraestrutura — workers
import { PaymentWorker } from './infrastructure/queue/workers/PaymentWorker'
import { LedgerWorker } from './infrastructure/queue/workers/LedgerWorker'
import { SettlementWorker } from './infrastructure/queue/workers/SettlementWorker'
import {
  DEFAULT_JOB_OPTIONS,
  LEDGER_JOB_OPTIONS,
  SETTLEMENT_JOB_OPTIONS,
} from './infrastructure/workers/jobOptions'

// Infraestrutura — outbox repository
import { PostgresOutboxRepository } from './infrastructure/database/repositories/PostgresOutboxRepository'

// Application — use cases
import { CreatePaymentUseCase } from './application/payment/CreatePaymentUseCase'
import { GetPaymentUseCase } from './application/payment/GetPaymentUseCase'
import { RefundPaymentUseCase } from './application/payment/RefundPaymentUseCase'
import { ProcessWebhookUseCase } from './application/payment/ProcessWebhookUseCase'

// ─── 2. Validação fail-fast das env vars obrigatórias ─────────────────────────

const REQUIRED_ENV_VARS = [
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'STRIPE_WEBHOOK_SECRET',
  'ASAAS_WEBHOOK_TOKEN',
]

for (const key of REQUIRED_ENV_VARS) {
  if (!process.env[key]) {
    process.stderr.write(`[bootstrap] Missing required env var: ${key}\n`)
    process.exit(1)
  }
}

// ─── 3. Logger ────────────────────────────────────────────────────────────────

const logger = createLogger()

// ─── 4. Banco de dados e Redis ────────────────────────────────────────────────

const env      = process.env['NODE_ENV'] ?? 'development'
const dbConfig = knexConfig[env]

if (dbConfig === undefined) {
  logger.error({ service: 'bootstrap' }, `Knex config not found for environment: ${env}`)
  process.exit(1)
}

const db    = Knex(dbConfig)
const redis = new Redis(process.env['REDIS_URL'] ?? '', { maxRetriesPerRequest: null })

redis.on('error', (err: Error) => {
  logger.error({ service: 'bootstrap', err }, 'Redis connection error')
})

// ─── 5. Repositórios ──────────────────────────────────────────────────────────

const uow              = new KnexUnitOfWork(db)
const paymentRepo      = new PostgresPaymentRepository(db)
const splitRuleRepo    = new PostgresSplitRuleRepository(db)
const journalEntryRepo = new PostgresLedgerRepository(db)
const settlementRepo   = new PostgresSettlementRepository(db)
const ledgerQueryRepo  = new LedgerQueryRepository(db)
const auditLogRepo     = new PostgresAuditLogRepository(db)
const idempotencyStore = new RedisPostgresIdempotencyStore(db, redis)
const masker           = new SensitiveDataMasker()

// ─── 6. Use cases ─────────────────────────────────────────────────────────────

const createPaymentUseCase  = new CreatePaymentUseCase(uow)
const getPaymentUseCase     = new GetPaymentUseCase(paymentRepo)
const refundPaymentUseCase  = new RefundPaymentUseCase(uow, splitRuleRepo)
const processWebhookUseCase = new ProcessWebhookUseCase(uow)

// ─── 7. Express app ───────────────────────────────────────────────────────────

const app = createApp({
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

// ─── 8. HTTP server ───────────────────────────────────────────────────────────

const PORT   = parseInt(process.env['PORT'] ?? '3000', 10)
const server = http.createServer(app)

server.listen(PORT, () => {
  logger.info({ service: 'bootstrap', port: PORT }, 'HTTP server listening')
})

// ─── 9. Outbox Relay ──────────────────────────────────────────────────────────

// Filas BullMQ — conexão separada da do app (recomendação do BullMQ)
const redisUrl      = process.env['REDIS_URL'] ?? ''
const redisHostInfo = new URL(redisUrl)
const bullConnection = {
  host:     redisHostInfo.hostname,
  port:     parseInt(redisHostInfo.port || '6379', 10),
  ...(redisHostInfo.password !== '' ? { password: redisHostInfo.password } : {}),
}

const paymentQueue    = new Queue('payment',    { connection: bullConnection, defaultJobOptions: DEFAULT_JOB_OPTIONS })
const ledgerQueue     = new Queue('ledger',     { connection: bullConnection, defaultJobOptions: LEDGER_JOB_OPTIONS })
const settlementQueue = new Queue('settlement', { connection: bullConnection, defaultJobOptions: SETTLEMENT_JOB_OPTIONS })

/**
 * Fan-out: PAYMENT_CAPTURED precisa chegar tanto no LedgerWorker quanto
 * no SettlementWorker. O OutboxRelay só conhece um QueueLike por event type,
 * então usamos um wrapper que adiciona nas duas filas simultaneamente.
 */
class MultiQueue implements QueueLike {
  constructor(private readonly queues: QueueLike[]) {}

  async add(
    name: string,
    data: Record<string, unknown>,
    opts: { jobId: string },
  ): Promise<unknown> {
    await Promise.all(this.queues.map((q) => q.add(name, data, opts)))
    return undefined
  }
}

const capturedMultiQueue = new MultiQueue([ledgerQueue, settlementQueue])

const outboxRepo = new PostgresOutboxRepository(db)

const relay = new OutboxRelay({
  outboxRepo,
  resolveQueue: (eventType: string): QueueLike | undefined => {
    switch (eventType) {
      case 'PAYMENT_CREATED':      return paymentQueue
      case 'PAYMENT_CAPTURED':     return capturedMultiQueue
      case 'PAYMENT_REFUNDED':     return ledgerQueue
      case 'SETTLEMENT_COMPLETED': return ledgerQueue
      default:                     return undefined
    }
  },
  logger,
})

void relay.start()

// ─── 10. Workers ──────────────────────────────────────────────────────────────

/**
 * Gateway stub — workers falharão jobs até STRIPE_API_KEY ser configurado.
 * BullMQ retentará automaticamente via backoff exponencial (ADR-012).
 * Substituir por: new StripeAdapter(new Stripe(key, { apiVersion: '2023-10-16' }), logger)
 */
const stripeClientStub: StripeClient = {
  paymentIntents: {
    create:   () => Promise.reject(new Error('STRIPE_API_KEY not configured — install stripe package')),
    capture:  () => Promise.reject(new Error('STRIPE_API_KEY not configured — install stripe package')),
    retrieve: () => Promise.reject(new Error('STRIPE_API_KEY not configured — install stripe package')),
  },
  refunds: {
    create: () => Promise.reject(new Error('STRIPE_API_KEY not configured — install stripe package')),
  },
}

const gateway = new StripeAdapter(stripeClientStub, logger)

const paymentWorkerDomain    = new PaymentWorker({ uow, gateway, gatewayName: 'stripe', splitRuleRepo, logger })
const ledgerWorkerDomain     = new LedgerWorker({ uow, journalEntryRepo, logger })
const settlementWorkerDomain = new SettlementWorker({ uow, settlementRepo, logger })

const paymentBullWorker = new Worker(
  'payment',
  async (job: Job<Record<string, unknown>>) => { await paymentWorkerDomain.process(job) },
  { connection: bullConnection },
)

const ledgerBullWorker = new Worker(
  'ledger',
  async (job: Job<Record<string, unknown>>) => { await ledgerWorkerDomain.process(job) },
  { connection: bullConnection },
)

const settlementBullWorker = new Worker(
  'settlement',
  async (job: Job<Record<string, unknown>>) => { await settlementWorkerDomain.process(job) },
  { connection: bullConnection },
)

paymentBullWorker.on('failed',    (job, err) => logger.error({ service: 'PaymentWorker',    jobId: job?.id, err }, 'Job failed'))
ledgerBullWorker.on('failed',     (job, err) => logger.error({ service: 'LedgerWorker',     jobId: job?.id, err }, 'Job failed'))
settlementBullWorker.on('failed', (job, err) => logger.error({ service: 'SettlementWorker', jobId: job?.id, err }, 'Job failed'))

logger.info({ service: 'bootstrap' }, 'Workers started: payment, ledger, settlement')

// ─── 11. Graceful Shutdown ────────────────────────────────────────────────────

const gracefulShutdown = new GracefulShutdown({
  server,
  workers: [paymentBullWorker, ledgerBullWorker, settlementBullWorker],
  relay,
  db,
  redis,
  logger,
})

gracefulShutdown.register()

logger.info({ service: 'bootstrap', port: PORT }, 'payment-orchestrator ready')
