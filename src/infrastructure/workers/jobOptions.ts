import type { JobsOptions } from 'bullmq'

/**
 * Backoff exponencial com jitter para o PaymentWorker e workers genéricos (ADR-012).
 *
 * delay = 2000ms * 2^(attempt-1) * (0.75 + random * 0.5)
 * Cap: 60s — evita esperas absurdas em falhas permanentes.
 *
 * Registrado no Worker via `settings.backoffStrategy` junto com
 * `DEFAULT_JOB_OPTIONS` (que define `backoff.type = 'custom'`).
 */
export function defaultBackoffStrategy(attemptsMade: number): number {
  const exponential = 2_000 * Math.pow(2, attemptsMade - 1)
  const jitter = exponential * (0.75 + Math.random() * 0.5)
  return Math.min(Math.floor(jitter), 60_000)
}

/**
 * Backoff para o LedgerWorker — base 1s, cap 30s.
 *
 * O Ledger é o worker mais crítico do sistema (ADR-012):
 * - 8 tentativas antes de ir para DLQ
 * - Delay menor: precisa ser processado o mais rápido possível
 * - Um job na DLQ do Ledger gera alerta crítico imediato
 */
export function ledgerBackoffStrategy(attemptsMade: number): number {
  const exponential = 1_000 * Math.pow(2, attemptsMade - 1)
  const jitter = exponential * (0.75 + Math.random() * 0.5)
  return Math.min(Math.floor(jitter), 30_000)
}

/**
 * Backoff para o SettlementWorker — fixo entre 30s e 40s.
 *
 * Payouts têm custo de transação real no gateway.
 * Não devemos ser agressivos em retries — 3 tentativas espaçadas.
 */
export function settlementBackoffStrategy(): number {
  return 30_000 + Math.floor(Math.random() * 10_000)
}

// ─── Configurações de job centralizadas ───────────────────────────────────────
//
// Importadas por todos os workers ao chamar queue.add().
// O backoff.type = 'custom' instrui o BullMQ a usar a função registrada em
// Worker({ settings: { backoffStrategy } }) — cada worker registra a sua.

/** Configuração padrão — PaymentWorker e WebhookOutbound (ADR-012). */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'custom' },
  removeOnComplete: { count: 100 },
  removeOnFail: false,
}

/** LedgerWorker — 8 tentativas, alerta crítico se for para DLQ (ADR-012). */
export const LEDGER_JOB_OPTIONS: JobsOptions = {
  attempts: 8,
  backoff: { type: 'custom' },
  removeOnComplete: { count: 100 },
  removeOnFail: false,
}

/** SettlementWorker — 3 tentativas espaçadas, não agressivo (ADR-012). */
export const SETTLEMENT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'custom' },
  removeOnComplete: { count: 100 },
  removeOnFail: false,
}
