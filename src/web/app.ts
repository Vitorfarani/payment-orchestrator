import express from 'express'
import pinoHttp from 'pino-http'
import type { Express, RequestHandler } from 'express'
import type { Logger } from 'pino'
import type { Knex } from 'knex'
import type { Redis } from 'ioredis'
import type { CreatePaymentUseCase } from '../application/payment/CreatePaymentUseCase'
import type { GetPaymentUseCase } from '../application/payment/GetPaymentUseCase'
import type { RefundPaymentUseCase } from '../application/payment/RefundPaymentUseCase'
import type { ProcessWebhookUseCase } from '../application/payment/ProcessWebhookUseCase'
import type { IIdempotencyStore } from '../application/shared/IIdempotencyStore'
import type { LedgerQueryRepository } from '../infrastructure/database/repositories/LedgerQueryRepository'
import type { PostgresAuditLogRepository } from '../infrastructure/database/repositories/PostgresAuditLogRepository'
import type { SensitiveDataMasker } from '../infrastructure/security/SensitiveDataMasker'
import { httpRequestDuration, httpRequestsTotal } from '../infrastructure/metrics/metrics'
import { requestContextMiddleware } from './middlewares/RequestContextMiddleware'
import { errorHandlerMiddleware } from './middlewares/ErrorHandlerMiddleware'
import { PaymentController } from './controllers/PaymentController'
import { WebhookController } from './controllers/WebhookController'
import { LedgerController } from './controllers/LedgerController'
import { HealthController } from './controllers/HealthController'
import { paymentRoutes } from './routes/paymentRoutes'
import { webhookRoutes } from './routes/webhookRoutes'
import { ledgerRoutes } from './routes/ledgerRoutes'
import { healthRoutes } from './routes/healthRoutes'

export interface AppDependencies {
  createPaymentUseCase:  CreatePaymentUseCase
  getPaymentUseCase:     GetPaymentUseCase
  refundPaymentUseCase:  RefundPaymentUseCase
  processWebhookUseCase: ProcessWebhookUseCase
  idempotencyStore:      IIdempotencyStore
  ledgerQueryRepo:       LedgerQueryRepository
  auditLogRepo:          PostgresAuditLogRepository
  masker:                SensitiveDataMasker
  db:                    Knex
  redis:                 Redis
  logger:                Logger
}

/**
 * Intercepta `res.finish` para registrar métricas HTTP no Prometheus (ADR-017).
 * Inline em app.ts — abstração desnecessária para uma função de 8 linhas.
 */
function httpMetricsMiddleware(): RequestHandler {
  return (req, res, next) => {
    const startNs = process.hrtime.bigint()
    res.on('finish', () => {
      const durationSec = Number(process.hrtime.bigint() - startNs) / 1e9
      const labels = {
        method:      req.method,
        route:       req.path,
        status_code: String(res.statusCode),
      }
      httpRequestDuration.observe(labels, durationSec)
      httpRequestsTotal.inc(labels)
    })
    next()
  }
}

/**
 * Factory da aplicação Express — zero singletons, toda dependência injetada.
 *
 * Ordem dos middlewares (crítica — não alterar):
 *   1. requestContext  → observabilidade para TODAS as rotas
 *   2. pinoHttp        → request logging estruturado
 *   3. httpMetrics     → Prometheus
 *   4. webhookRoutes   → ANTES do express.json global (Stripe usa express.raw)
 *   5. express.json    → parser global — só depois dos webhooks
 *   6. paymentRoutes
 *   7. ledgerRoutes
 *   8. healthRoutes
 *   9. errorHandler    → SEMPRE por último
 */
export function createApp(deps: AppDependencies): Express {
  const app = express()

  // ── Observabilidade global ─────────────────────────────────────────────────
  app.use(requestContextMiddleware(deps.logger))
  app.use(pinoHttp({ logger: deps.logger }))
  app.use(httpMetricsMiddleware())

  // ── Webhooks — ANTES do express.json global ────────────────────────────────
  // A rota Stripe usa express.raw({ type: 'application/json' }) para preservar
  // o body bruto necessário para a verificação HMAC-SHA256 (ADR-002).
  const webhookCtrl = new WebhookController({
    processWebhookUseCase: deps.processWebhookUseCase,
    logger:                deps.logger,
  })
  app.use('/webhooks', webhookRoutes(webhookCtrl))

  // ── Parser JSON global ─────────────────────────────────────────────────────
  app.use(express.json())

  // ── Rotas de negócio ───────────────────────────────────────────────────────
  const paymentCtrl = new PaymentController({
    createPaymentUseCase: deps.createPaymentUseCase,
    getPaymentUseCase:    deps.getPaymentUseCase,
    refundPaymentUseCase: deps.refundPaymentUseCase,
    auditLogRepo:         deps.auditLogRepo,
    masker:               deps.masker,
  })
  app.use('/payments', paymentRoutes(paymentCtrl, deps.idempotencyStore, deps.redis))

  const ledgerCtrl = new LedgerController({ ledgerQueryRepo: deps.ledgerQueryRepo })
  app.use('/ledger', ledgerRoutes(ledgerCtrl, deps.redis))

  // ── Saúde e métricas ───────────────────────────────────────────────────────
  const healthCtrl = new HealthController({ db: deps.db, redis: deps.redis })
  app.use(healthRoutes(healthCtrl))

  // ── Error handler — SEMPRE por último ─────────────────────────────────────
  app.use(errorHandlerMiddleware(deps.logger, deps.idempotencyStore))

  return app
}
