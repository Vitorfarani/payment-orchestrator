import { GenericContainer, Wait } from 'testcontainers'
import type { StartedTestContainer } from 'testcontainers'
import Knex from 'knex'
import type { Knex as KnexType } from 'knex'
import Redis from 'ioredis'
import path from 'path'
import { RedisPostgresIdempotencyStore } from '../../../src/infrastructure/idempotency/IdempotencyStore'
import { IdempotencyKey } from '../../../src/domain/shared/types'

// ──────────────────────────────────────────────────────────────────────────────
// Integration tests — RedisPostgresIdempotencyStore com Redis e PostgreSQL reais
//
// O que testamos:
//   1. tryAcquire() primeira vez  — INSERT ok, Redis vazio (PROCESSING não cacheado)
//   2. complete()                 — persiste no PG e popula Redis
//   3. tryAcquire() Redis HIT     — responde do cache mesmo sem linha no PG
//   4. fail()                     — remove do PG, libera retry
//   5. race condition COMPLETED   — UNIQUE violation → repopula Redis (ADR-002 passo 4)
//   6. race condition PROCESSING  — UNIQUE violation → NÃO popula Redis
//   7. Redis TTL expiry           — chave expirada cai para PG e repopula cache
//
// Para rodar: npm run test:int
// ──────────────────────────────────────────────────────────────────────────────

const PG_USER = 'test_user'
const PG_PASS = 'test_pass'
const PG_DB   = 'test_db'

const REDIS_PREFIX = 'idempotency:'

let pgContainer:    StartedTestContainer
let redisContainer: StartedTestContainer
let db:             KnexType
let redisClient:    Redis

beforeAll(async () => {
  // Inicia ambos os containers em paralelo para reduzir tempo de setup
  const containers = await Promise.all([
    new GenericContainer('postgres:16-alpine')
      .withEnvironment({
        POSTGRES_DB:       PG_DB,
        POSTGRES_USER:     PG_USER,
        POSTGRES_PASSWORD: PG_PASS,
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage('database system is ready to accept connections', 2),
      )
      .start(),

    new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start(),
  ] as const)

  pgContainer    = containers[0]
  redisContainer = containers[1]

  const pgPort    = pgContainer.getMappedPort(5432)
  const redisPort = redisContainer.getMappedPort(6379)

  db = Knex({
    client: 'pg',
    connection: `postgresql://${PG_USER}:${PG_PASS}@localhost:${pgPort}/${PG_DB}`,
    pool: { min: 2, max: 5 },
    migrations: {
      directory: path.resolve(__dirname, '../../../src/infrastructure/database/migrations'),
      loadExtensions: ['.ts'],
    },
  })

  await db.migrate.latest()

  redisClient = new Redis({ host: 'localhost', port: redisPort })
}, 120_000)

afterAll(async () => {
  await redisClient.quit()
  await db.destroy()
  await Promise.all([pgContainer.stop(), redisContainer.stop()])
})

// ── Helpers ───────────────────────────────────────────────────────────────────

let keyCounter = 0

function makeKey(): IdempotencyKey {
  keyCounter++
  return IdempotencyKey.of(`integration-test:key-${Date.now()}-${keyCounter}`)
}

async function pgRow(key: IdempotencyKey): Promise<Record<string, unknown> | undefined> {
  const row = await db('idempotency_keys').where({ key }).first() as Record<string, unknown> | undefined
  return row
}

async function redisValue(key: IdempotencyKey): Promise<string | null> {
  return redisClient.get(`${REDIS_PREFIX}${key}`)
}

// ── Testes ────────────────────────────────────────────────────────────────────

describe('RedisPostgresIdempotencyStore (integration)', () => {

  // ── 1. tryAcquire() — primeira requisição ─────────────────────────────────

  describe('tryAcquire() — primeira requisição', () => {
    it('retorna { isNew: true } quando a chave não existe', async () => {
      const store = new RedisPostgresIdempotencyStore(db, redisClient)
      const key   = makeKey()

      const result = await store.tryAcquire(key)

      expect(result.isNew).toBe(true)
    })

    it('persiste a linha no PostgreSQL com expires_at no futuro', async () => {
      const store = new RedisPostgresIdempotencyStore(db, redisClient)
      const key   = makeKey()

      await store.tryAcquire(key)

      const row = await pgRow(key)
      expect(row).toBeDefined()
      expect((row?.['expires_at'] as Date).getTime()).toBeGreaterThan(Date.now())
    })

    it('NÃO popula o Redis para status PROCESSING', async () => {
      const store = new RedisPostgresIdempotencyStore(db, redisClient)
      const key   = makeKey()

      await store.tryAcquire(key)

      const cached = await redisValue(key)
      expect(cached).toBeNull()
    })

    it('retorna { isNew: false } em chamadas subsequentes', async () => {
      const store = new RedisPostgresIdempotencyStore(db, redisClient)
      const key   = makeKey()

      await store.tryAcquire(key)
      const second = await store.tryAcquire(key)

      expect(second.isNew).toBe(false)
    })
  })

  // ── 2. complete() ─────────────────────────────────────────────────────────

  describe('complete()', () => {
    it('persiste statusCode e responseBody no PostgreSQL', async () => {
      const store = new RedisPostgresIdempotencyStore(db, redisClient)
      const key   = makeKey()
      await store.tryAcquire(key)

      await store.complete(key, 201, { paymentId: 'pay-abc' })

      const row = await pgRow(key)
      expect(row?.['status_code']).toBe(201)
      expect(row?.['response_body']).toEqual({ paymentId: 'pay-abc' })
    })

    it('popula o Redis com JSON contendo status COMPLETED', async () => {
      const store = new RedisPostgresIdempotencyStore(db, redisClient)
      const key   = makeKey()
      await store.tryAcquire(key)

      await store.complete(key, 200, { ok: true })

      const cached = await redisValue(key)
      expect(cached).not.toBeNull()

      const parsed = JSON.parse(cached ?? '') as { status: string; statusCode: number }
      expect(parsed.status).toBe('COMPLETED')
      expect(parsed.statusCode).toBe(200)
    })
  })

  // ── 3. tryAcquire() — Redis HIT (cache-first) ─────────────────────────────

  describe('tryAcquire() — Redis HIT', () => {
    it('serve do Redis mesmo após a linha ser deletada do PostgreSQL', async () => {
      // Prova que o Redis é consultado ANTES do PostgreSQL
      const store = new RedisPostgresIdempotencyStore(db, redisClient)
      const key   = makeKey()

      await store.tryAcquire(key)
      await store.complete(key, 200, { cached: true })

      // Deleta a linha do PG para forçar o teste a depender do Redis
      await db('idempotency_keys').where({ key }).delete()

      const result = await store.tryAcquire(key)

      expect(result.isNew).toBe(false)
      if (!result.isNew) {
        expect(result.record.status).toBe('COMPLETED')
        expect(result.record.responseBody).toEqual({ cached: true })
      }
    })

    it('retorna record completo com statusCode e responseBody do cache', async () => {
      const store = new RedisPostgresIdempotencyStore(db, redisClient)
      const key   = makeKey()

      await store.tryAcquire(key)
      await store.complete(key, 202, { orderId: 'ord-999' })

      const result = await store.tryAcquire(key)

      expect(result.isNew).toBe(false)
      if (!result.isNew) {
        expect(result.record.statusCode).toBe(202)
        expect(result.record.responseBody).toEqual({ orderId: 'ord-999' })
      }
    })
  })

  // ── 4. fail() ─────────────────────────────────────────────────────────────

  describe('fail()', () => {
    it('remove a linha do PostgreSQL', async () => {
      const store = new RedisPostgresIdempotencyStore(db, redisClient)
      const key   = makeKey()
      await store.tryAcquire(key)

      await store.fail(key)

      const row = await pgRow(key)
      expect(row).toBeUndefined()
    })

    it('permite retry — próxima tryAcquire() retorna { isNew: true }', async () => {
      const store = new RedisPostgresIdempotencyStore(db, redisClient)
      const key   = makeKey()
      await store.tryAcquire(key)
      await store.fail(key)

      const retry = await store.tryAcquire(key)

      expect(retry.isNew).toBe(true)
    })

    it('NÃO escreve no Redis — próxima tentativa percorre o fluxo completo', async () => {
      const store = new RedisPostgresIdempotencyStore(db, redisClient)
      const key   = makeKey()
      await store.tryAcquire(key)
      await store.fail(key)

      const cached = await redisValue(key)
      expect(cached).toBeNull()
    })
  })

  // ── 5. Race condition — UNIQUE violation + COMPLETED → repopula Redis ──────
  //
  // Simula o cenário ADR-002 passo 4:
  // outra instância completou a operação, o cache Redis expirou,
  // mas o registro permanente no PostgreSQL ainda existe com COMPLETED.
  // tryAcquire() deve encontrá-lo, repoopular Redis e retornar { isNew: false }.

  describe('race condition — UNIQUE violation com COMPLETED no PG (ADR-002 passo 4)', () => {
    it('retorna { isNew: false, status: COMPLETED } e repopula Redis', async () => {
      const store = new RedisPostgresIdempotencyStore(db, redisClient)
      const key   = makeKey()

      // Simula que outra instância já inseriu e completou (Redis ainda vazio — cache expirou)
      await db('idempotency_keys').insert({
        key,
        response_body: { paymentId: 'pay-race-completed' },
        status_code:   201,
        expires_at:    new Date(Date.now() + 3_600_000),
      })

      // Redis vazio simula cache expirado — próxima chamada deve cair para PG
      const cachedBefore = await redisValue(key)
      expect(cachedBefore).toBeNull()

      const result = await store.tryAcquire(key)

      expect(result.isNew).toBe(false)
      if (!result.isNew) {
        expect(result.record.status).toBe('COMPLETED')
        expect(result.record.statusCode).toBe(201)
        expect(result.record.responseBody).toEqual({ paymentId: 'pay-race-completed' })
      }

      // Redis deve ter sido repopulado
      const cachedAfter = await redisValue(key)
      expect(cachedAfter).not.toBeNull()
      const parsed = JSON.parse(cachedAfter ?? '') as { status: string }
      expect(parsed.status).toBe('COMPLETED')
    })
  })

  // ── 6. Race condition — UNIQUE violation com PROCESSING no PG ─────────────

  describe('race condition — UNIQUE violation com PROCESSING no PG', () => {
    it('retorna { isNew: false, status: PROCESSING } e NÃO popula Redis', async () => {
      const store = new RedisPostgresIdempotencyStore(db, redisClient)
      const key   = makeKey()

      // Outra instância está processando — response_body null = PROCESSING
      await db('idempotency_keys').insert({
        key,
        response_body: null,
        status_code:   null,
        expires_at:    new Date(Date.now() + 3_600_000),
      })

      const result = await store.tryAcquire(key)

      expect(result.isNew).toBe(false)
      if (!result.isNew) {
        expect(result.record.status).toBe('PROCESSING')
        expect(result.record.statusCode).toBeNull()
      }

      // Redis deve continuar vazio — PROCESSING nunca é cacheado
      const cached = await redisValue(key)
      expect(cached).toBeNull()
    })
  })

  // ── 7. Redis TTL expiry — chave expirada cai para PG e repopula Redis ──────
  //
  // Usa TTL de 2s para tornar o teste viável sem espera longa.
  // Verifica o cenário real de cache miss por expiração (não só por race condition).

  it('após Redis TTL expirar, tryAcquire() encontra COMPLETED no PG e repopula cache', async () => {
    const SHORT_TTL = 2  // 2 segundos
    const store     = new RedisPostgresIdempotencyStore(db, redisClient, SHORT_TTL)
    const key       = makeKey()

    await store.tryAcquire(key)
    await store.complete(key, 200, { settled: true })

    // Redis deve ter a chave agora
    const cachedBefore = await redisValue(key)
    expect(cachedBefore).not.toBeNull()

    // Aguarda o TTL expirar
    await new Promise<void>(resolve => setTimeout(resolve, SHORT_TTL * 1000 + 200))

    // Redis expirou
    const cachedExpired = await redisValue(key)
    expect(cachedExpired).toBeNull()

    // tryAcquire cai para PG, encontra COMPLETED e repopula Redis
    const result = await store.tryAcquire(key)

    expect(result.isNew).toBe(false)
    if (!result.isNew) {
      expect(result.record.status).toBe('COMPLETED')
      expect(result.record.responseBody).toEqual({ settled: true })
    }

    // Redis repopulado
    const cachedAfter = await redisValue(key)
    expect(cachedAfter).not.toBeNull()
  }, 15_000)

})
