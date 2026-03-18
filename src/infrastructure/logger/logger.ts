import pino from 'pino'
import type { Logger } from 'pino'

/**
 * Paths redactados pelo Pino antes de serializar qualquer log.
 * Implementa a Camada 1 do mascaramento de dados sensíveis (ADR-019).
 *
 * A redação ocorre por nome de campo — para dados sensíveis embutidos em
 * strings ou campos com nomes inesperados, a Camada 2 (SensitiveDataMasker)
 * e a Camada 3 (HTTP allowlist) provêm proteção adicional.
 */
const SENSITIVE_REDACT_PATHS: string[] = [
  // Cartão — PCI-DSS
  '*.card_number',
  '*.pan',
  '*.cvv',
  '*.cvc',
  // Dados pessoais — LGPD
  '*.cpf',
  '*.cnpj',
  '*.date_of_birth',
  // Dados bancários
  '*.bank_account',
  '*.agency',
  '*.pix_key',
  // Credenciais
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  '*.api_key',
  '*.secret',
  '*.password',
  '*.token',
  // Endereço completo
  '*.full_address',
]

/**
 * Cria o logger base da aplicação.
 *
 * - JSON estruturado via Pino (5-8× mais rápido que Winston — ADR-017)
 * - `debug` desabilitado em produção: se `LOG_LEVEL` não estiver definido,
 *   usa `info` quando `NODE_ENV=production`, `debug` caso contrário
 * - Redact automático de dados sensíveis — Camada 1 do ADR-019
 * - Campos base obrigatórios `service` e `version` injetados em todo log
 */
export function createLogger(): Logger {
  const level =
    process.env['LOG_LEVEL'] ??
    (process.env['NODE_ENV'] === 'production' ? 'info' : 'debug')

  return pino({
    level,
    base: {
      service: 'payment-orchestrator',
      version: process.env['npm_package_version'] ?? '0.0.0',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label: string) => ({ level: label }),
    },
    redact: {
      paths: SENSITIVE_REDACT_PATHS,
      censor: '[REDACTED]',
    },
  })
}

/**
 * Cria um child logger com `request_id` e `trace_id` injetados.
 *
 * Todos os logs dentro do ciclo de vida de um request HTTP devem usar
 * este logger filho — garantindo rastreabilidade end-to-end (ADR-017).
 *
 * O `request_id` propaga-se do HTTP até os workers via `job.data._meta`.
 */
export function createRequestLogger(
  logger: Logger,
  requestId: string,
  traceId?: string,
): Logger {
  const bindings: Record<string, string> = { request_id: requestId }
  if (traceId !== undefined) {
    bindings['trace_id'] = traceId
  }
  return logger.child(bindings)
}
