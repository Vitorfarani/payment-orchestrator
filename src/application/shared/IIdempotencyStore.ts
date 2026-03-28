import type { IdempotencyKey } from '../../domain/shared/types'

export type IdempotencyStatus = 'PROCESSING' | 'COMPLETED'

export interface IdempotencyRecord {
  readonly key:          IdempotencyKey
  readonly status:       IdempotencyStatus
  readonly statusCode:   number | null
  readonly responseBody: unknown
  readonly createdAt:    Date
  readonly expiresAt:    Date
}

/**
 * Contrato do armazenamento de idempotency keys (ADR-002).
 *
 * Definido em application/ — use cases dependem desta interface,
 * nunca da implementação concreta (Redis + PostgreSQL).
 *
 * Três operações formam o ciclo de vida de uma chave:
 *   tryAcquire → processa → complete (sucesso) ou fail (erro)
 */
export interface IIdempotencyStore {
  /**
   * Tenta registrar a chave atomicamente.
   *
   * Retorna { isNew: true }  → primeira requisição, pode processar.
   * Retorna { isNew: false } → já existe; record contém o estado atual.
   *
   * Se record.status === 'PROCESSING': retornar 409 IDEMPOTENCY_CONFLICT.
   * Se record.status === 'COMPLETED':  retornar resposta original sem reprocessar.
   */
  tryAcquire(key: IdempotencyKey): Promise<
    | { isNew: true }
    | { isNew: false; record: IdempotencyRecord }
  >

  /** Marca operação como concluída e armazena a resposta para replay. */
  complete(key: IdempotencyKey, statusCode: number, responseBody: unknown): Promise<void>

  /**
   * Remove a chave para liberar retry pelo cliente (ADR-002).
   * Chamado quando o processamento falha com erro recuperável.
   */
  fail(key: IdempotencyKey): Promise<void>
}
