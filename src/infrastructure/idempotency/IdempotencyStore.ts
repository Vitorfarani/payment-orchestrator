/**
 * Armazenamento de idempotency keys em duas camadas (ADR-002):
 *   Camada 1 — Redis: cache rápido com TTL de 24h
 *   Camada 2 — PostgreSQL: registro durável, resolve race conditions via UNIQUE constraint
 *
 * Fluxo de tryAcquire:
 *   Redis HIT  → retorna resultado cacheado (< 1ms)
 *   Redis MISS → INSERT no PostgreSQL
 *     ↳ INSERT ok   → primeira vez, pode processar
 *     ↳ INSERT 23505 → chave já existe → SELECT → devolve registro + repopula Redis se COMPLETED
 *
 * A chave expirada no Redis não reprocessa: o registro permanente no PostgreSQL é
 * encontrado no SELECT pós-conflito e repopulado no cache (ADR-002 passo 4).
 */

import type { Knex } from 'knex'
import type { Redis } from 'ioredis'
import { IdempotencyKey } from '../../domain/shared/types'

// ─── Tipos públicos ───────────────────────────────────────────────────────────

export type IdempotencyStatus = 'PROCESSING' | 'COMPLETED'

export interface IdempotencyRecord {
  readonly key:          IdempotencyKey
  readonly status:       IdempotencyStatus
  readonly statusCode:   number | null
  readonly responseBody: unknown
  readonly createdAt:    Date
  readonly expiresAt:    Date
}

export interface IIdempotencyStore {
  /**
   * Tenta registrar a chave atomicamente.
   * Retorna { isNew: true }  → primeira requisição, pode processar.
   * Retorna { isNew: false } → já existe, retornar record ao caller.
   */
  tryAcquire(key: IdempotencyKey): Promise<
    | { isNew: true }
    | { isNew: false; record: IdempotencyRecord }
  >

  /** Marca operação como concluída e popula o cache Redis. */
  complete(key: IdempotencyKey, statusCode: number, responseBody: unknown): Promise<void>

  /**
   * Remove a chave do PostgreSQL para liberar retry.
   * Não popula Redis — próxima tentativa percorre o fluxo normal (ADR-002).
   */
  fail(key: IdempotencyKey): Promise<void>
}

// ─── Tipos internos ───────────────────────────────────────────────────────────

/** Linha da tabela idempotency_keys lida do PostgreSQL via Knex. */
interface IdempotencyRow {
  key:           string
  response_body: unknown  // JSONB: null = PROCESSING, objeto = COMPLETED
  status_code:   number | null
  created_at:    Date
  expires_at:    Date
}

/** Formato serializado para armazenamento no Redis. */
interface SerializedRecord {
  key:          string
  status:       IdempotencyStatus
  statusCode:   number | null
  responseBody: unknown
  createdAt:    string
  expiresAt:    string
}

// ─── Constantes ───────────────────────────────────────────────────────────────

const REDIS_PREFIX         = 'idempotency:'
const DEFAULT_TTL_SECONDS  = 60 * 60 * 24  // 24 horas

// ─── Helpers internos ─────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Detecta violação de unicidade do PostgreSQL (código SQLSTATE 23505). */
function isUniqueViolationError(err: unknown): boolean {
  if (!isRecord(err)) return false
  return err['code'] === '23505'
}

function rowToRecord(row: IdempotencyRow): IdempotencyRecord {
  return {
    key:          IdempotencyKey.of(row.key),
    status:       row.response_body !== null && row.response_body !== undefined
                    ? 'COMPLETED'
                    : 'PROCESSING',
    statusCode:   row.status_code,
    responseBody: row.response_body ?? null,
    createdAt:    row.created_at,
    expiresAt:    row.expires_at,
  }
}

/**
 * Deserializa um registro do Redis.
 * Retorna null se o JSON estiver corrompido ou com campos inválidos —
 * nesse caso tryAcquire cai para o PostgreSQL automaticamente.
 */
function parseSerializedRecord(json: string): IdempotencyRecord | null {
  try {
    const raw: unknown = JSON.parse(json)
    if (!isRecord(raw)) return null

    const { key, status, statusCode, responseBody, createdAt, expiresAt } = raw

    if (typeof key !== 'string') return null
    if (status !== 'PROCESSING' && status !== 'COMPLETED') return null
    if (statusCode !== null && typeof statusCode !== 'number') return null
    if (typeof createdAt !== 'string') return null
    if (typeof expiresAt !== 'string') return null

    return {
      key:          IdempotencyKey.of(key),
      status,
      statusCode:   statusCode ?? null,
      responseBody: responseBody ?? null,
      createdAt:    new Date(createdAt),
      expiresAt:    new Date(expiresAt),
    }
  } catch {
    return null
  }
}

function toSerializedRecord(record: IdempotencyRecord): string {
  const serialized: SerializedRecord = {
    key:          record.key,
    status:       record.status,
    statusCode:   record.statusCode,
    responseBody: record.responseBody,
    createdAt:    record.createdAt.toISOString(),
    expiresAt:    record.expiresAt.toISOString(),
  }
  return JSON.stringify(serialized)
}

// ─── Implementação ────────────────────────────────────────────────────────────

export class RedisPostgresIdempotencyStore implements IIdempotencyStore {
  private readonly ttlSeconds: number

  constructor(
    private readonly db:    Knex,
    private readonly redis: Redis,
    ttlSeconds = DEFAULT_TTL_SECONDS,
  ) {
    this.ttlSeconds = ttlSeconds
  }

  async tryAcquire(key: IdempotencyKey): Promise<
    | { isNew: true }
    | { isNew: false; record: IdempotencyRecord }
  > {
    // 1. Camada 1 — Redis (caminho rápido, < 1ms para duplicatas)
    const cached = await this.redis.get(`${REDIS_PREFIX}${key}`)
    if (cached !== null) {
      const record = parseSerializedRecord(cached)
      if (record !== null) {
        return { isNew: false, record }
      }
      // JSON corrompido → cai para PostgreSQL
    }

    // 2. Camada 2 — PostgreSQL: INSERT atômico resolve race condition via UNIQUE
    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000)
    try {
      await this.db<IdempotencyRow>('idempotency_keys').insert({ key, expires_at: expiresAt })
      return { isNew: true }
    } catch (err: unknown) {
      if (!isUniqueViolationError(err)) throw err
    }

    // 3. Conflito: chave já existe — SELECT para obter o registro
    const row = await this.db<IdempotencyRow>('idempotency_keys')
      .where({ key })
      .first()

    if (row === undefined) {
      // Linha deletada entre o conflito e o SELECT (raro) — trata como nova
      return { isNew: true }
    }

    const record = rowToRecord(row)

    // Repopula Redis para COMPLETED: evita roundtrip ao banco na próxima requisição
    // Cobre o cenário de chave expirada do Redis mas ainda presente no PostgreSQL (ADR-002 passo 4)
    if (record.status === 'COMPLETED') {
      await this.redis.setex(
        `${REDIS_PREFIX}${key}`,
        this.ttlSeconds,
        toSerializedRecord(record),
      )
    }

    return { isNew: false, record }
  }

  async complete(key: IdempotencyKey, statusCode: number, responseBody: unknown): Promise<void> {
    // Persiste no PostgreSQL
    await this.db<IdempotencyRow>('idempotency_keys')
      .where({ key })
      .update({ status_code: statusCode, response_body: responseBody })

    // Popula Redis — futuras requisições com a mesma chave retornam em < 1ms
    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000)
    const record: IdempotencyRecord = {
      key,
      status:       'COMPLETED',
      statusCode,
      responseBody,
      createdAt:    new Date(),
      expiresAt,
    }
    await this.redis.setex(
      `${REDIS_PREFIX}${key}`,
      this.ttlSeconds,
      toSerializedRecord(record),
    )
  }

  async fail(key: IdempotencyKey): Promise<void> {
    // Remove do PostgreSQL: libera a chave para que o cliente possa retentar (ADR-002)
    await this.db<IdempotencyRow>('idempotency_keys').where({ key }).delete()
    // Redis não é atualizado: registros PROCESSING nunca foram cacheados
  }
}
