/**
 * Factory de Circuit Breaker para chamadas ao gateway externo (ADR-008).
 *
 * Configuração padrão (todos os valores sobrescritíveis via CircuitBreakerOptions):
 *   - timeout:                  5 000ms  — falha se gateway não responder
 *   - errorThresholdPercentage: 50%      — % de falhas para abrir o circuito
 *   - volumeThreshold:          5        — mínimo de chamadas antes de avaliar
 *   - resetTimeout:             30 000ms — tempo em OPEN antes de tentar HALF-OPEN
 *
 * Métricas atualizadas em cada transição de estado (ADR-017):
 *   - circuitBreakerState         — Gauge: estado atual por nome
 *   - circuitBreakerFallbacksTotal — Counter: total de fallbacks disparados
 */

import CircuitBreaker from 'opossum'
import type { Logger } from 'pino'
import { circuitBreakerState, circuitBreakerFallbacksTotal } from '../metrics/metrics'

export interface CircuitBreakerOptions {
  readonly name:                      string
  readonly timeout?:                  number
  readonly errorThresholdPercentage?: number
  readonly volumeThreshold?:          number
  readonly resetTimeout?:             number
}

export function createCircuitBreaker<TI extends unknown[], TR>(
  fn: (...args: TI) => Promise<TR>,
  options: CircuitBreakerOptions,
  logger: Logger,
): CircuitBreaker<TI, TR> {
  const breaker = new CircuitBreaker<TI, TR>(fn, {
    name:                     options.name,
    timeout:                  options.timeout                  ?? 5000,
    errorThresholdPercentage: options.errorThresholdPercentage ?? 50,
    volumeThreshold:          options.volumeThreshold          ?? 5,
    resetTimeout:             options.resetTimeout             ?? 30000,
  })

  // ─── Transições de estado → métricas + log ────────────────────────────────

  breaker.on('open', () => {
    circuitBreakerState.set({ name: options.name, state: 'open' }, 1)
    logger.warn({ circuit: options.name }, 'Circuit breaker opened')
  })

  breaker.on('close', () => {
    circuitBreakerState.set({ name: options.name, state: 'closed' }, 1)
    logger.info({ circuit: options.name }, 'Circuit breaker closed')
  })

  breaker.on('halfOpen', () => {
    circuitBreakerState.set({ name: options.name, state: 'half_open' }, 1)
    logger.info({ circuit: options.name }, 'Circuit breaker half-open, testing recovery')
  })

  breaker.on('fallback', () => {
    circuitBreakerFallbacksTotal.inc({ name: options.name })
  })

  return breaker
}
