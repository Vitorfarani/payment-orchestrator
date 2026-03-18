import {
  Counter,
  Gauge,
  Histogram,
  collectDefaultMetrics,
  register,
} from 'prom-client'
import type { RequestHandler } from 'express'

// Coleta métricas padrão do runtime Node.js (heap, event loop, GC, etc.)
collectDefaultMetrics()

// ─── HTTP ─────────────────────────────────────────────────────────────────────

/** Latência de endpoints HTTP — permite calcular p50, p95, p99 no Grafana. */
export const httpRequestDuration = new Histogram<'method' | 'route' | 'status_code'>({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
})

/** Total de requests HTTP por método, rota e status code. */
export const httpRequestsTotal = new Counter<'method' | 'route' | 'status_code'>({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
})

// ─── Filas BullMQ ─────────────────────────────────────────────────────────────

/** Jobs aguardando processamento por fila. */
export const queueWaitingJobs = new Gauge<'queue'>({
  name: 'queue_waiting_jobs',
  help: 'Number of waiting jobs per queue',
  labelNames: ['queue'],
})

/** Jobs sendo processados ativamente por fila. */
export const queueActiveJobs = new Gauge<'queue'>({
  name: 'queue_active_jobs',
  help: 'Number of active jobs per queue',
  labelNames: ['queue'],
})

/**
 * Jobs falhos por fila — monitor da DLQ (ADR-012).
 * Alerta configurado no Grafana quando cresce indefinidamente.
 */
export const queueFailedJobs = new Gauge<'queue'>({
  name: 'queue_failed_jobs',
  help: 'Number of failed jobs per queue (DLQ monitor — ADR-012)',
  labelNames: ['queue'],
})

// ─── Circuit Breaker ──────────────────────────────────────────────────────────

/**
 * Estado atual do circuit breaker por nome.
 * Valores: 0=closed (normal), 1=open (rejeitando), 2=half_open (testando).
 */
export const circuitBreakerState = new Gauge<'name' | 'state'>({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state per gateway (0=closed, 1=open, 2=half_open)',
  labelNames: ['name', 'state'],
})

/** Total de fallbacks disparados por circuit breaker. */
export const circuitBreakerFallbacksTotal = new Counter<'name'>({
  name: 'circuit_breaker_fallbacks_total',
  help: 'Total circuit breaker fallbacks triggered',
  labelNames: ['name'],
})

// ─── Pool de conexões PostgreSQL ──────────────────────────────────────────────

/** Tamanho do pool de conexões por estado (idle, active, pending). */
export const dbPoolSize = new Gauge<'state'>({
  name: 'db_pool_size',
  help: 'Database connection pool size by state',
  labelNames: ['state'],
})

// ─── Pagamentos ───────────────────────────────────────────────────────────────

/**
 * Total de tentativas de pagamento por status, moeda e gateway.
 * Taxa de aprovação calculada no Grafana:
 *   sum(payment_attempts_total{status="CAPTURED"}) / sum(payment_attempts_total)
 */
export const paymentAttemptsTotal = new Counter<'status' | 'currency' | 'gateway'>({
  name: 'payment_attempts_total',
  help: 'Total payment attempts by outcome, currency and gateway',
  labelNames: ['status', 'currency', 'gateway'],
})

/** Tempo total do pagamento desde PENDING até o status final. */
export const paymentProcessingDuration = new Histogram<'status'>({
  name: 'payment_processing_duration_seconds',
  help: 'Time from PENDING to final payment status',
  labelNames: ['status'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
})

// ─── Split ────────────────────────────────────────────────────────────────────

/**
 * Erros de cálculo de split — deve ser sempre 0.
 * Qualquer valor > 0 indica bug na lógica de rounding (ADR-005).
 */
export const splitCalculationErrorsTotal = new Counter({
  name: 'split_calculation_errors_total',
  help: 'Total split calculation errors — must always be 0',
})

// ─── Ledger — CRÍTICO ─────────────────────────────────────────────────────────

/**
 * ALERTA CRÍTICO: deve ser sempre 0.
 *
 * Qualquer valor > 0 indica inconsistência financeira no ledger de dupla
 * entrada — acionar runbook imediatamente:
 * docs/runbooks/ledger-discrepancy.md
 */
export const ledgerBalanceDiscrepancy = new Gauge({
  name: 'ledger_balance_discrepancy_total',
  help: 'CRITICAL: unbalanced ledger entries. Must always be 0.',
})

/** Total de lançamentos contábeis escritos por código de conta. */
export const ledgerEntriesWrittenTotal = new Counter<'account_code'>({
  name: 'ledger_entries_written_total',
  help: 'Total ledger entries written by account code',
  labelNames: ['account_code'],
})

// ─── Settlement ───────────────────────────────────────────────────────────────

/** Payouts aguardando liquidação. */
export const settlementItemsPendingTotal = new Gauge({
  name: 'settlement_items_pending_total',
  help: 'Number of settlement items awaiting payout',
})

/** Payouts atrasados (payout_date < hoje). */
export const settlementItemsOverdueTotal = new Gauge({
  name: 'settlement_items_overdue_total',
  help: 'Number of overdue settlement items (payout_date < today)',
})

// ─── Outbox ───────────────────────────────────────────────────────────────────

/**
 * Eventos de outbox não processados.
 * Alerta no Grafana se crescer indefinidamente — indica OutboxRelay parado.
 */
export const outboxUnprocessedEventsTotal = new Gauge({
  name: 'outbox_unprocessed_events_total',
  help: 'Number of unprocessed outbox events — alert if grows indefinitely',
})

/** Lag médio entre criação e publicação de um evento de outbox (segundos). */
export const outboxRelayLagSeconds = new Gauge({
  name: 'outbox_relay_lag_seconds',
  help: 'Average seconds between outbox event creation and publication',
})

// ─── Endpoint /metrics ────────────────────────────────────────────────────────

/**
 * Handler Express para o endpoint `GET /metrics`.
 * Retorna todas as métricas no formato Prometheus text exposition.
 */
export function metricsHandler(): RequestHandler {
  return (_req, res, next): void => {
    void register
      .metrics()
      .then((data: string) => {
        res.set('Content-Type', register.contentType)
        res.send(data)
      })
      .catch((err: unknown) => next(err))
  }
}
