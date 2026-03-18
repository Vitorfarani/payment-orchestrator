import type { Knex } from 'knex'
import type { Redis } from 'ioredis'
import {
  RedisPostgresIdempotencyStore,
} from '../../../src/infrastructure/idempotency/IdempotencyStore'
import type { IdempotencyRecord } from '../../../src/infrastructure/idempotency/IdempotencyStore'
import { IdempotencyKey } from '../../../src/domain/shared/types'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TEST_KEY   = IdempotencyKey.of('merchant-test:idempotency-key-abc')
const TEST_TTL   = 3600  // 1 hora — curto para garantir isolamento de testes

const REDIS_PREFIX = 'idempotency:'

interface MockRow {
  key:           string
  response_body: Record<string, unknown> | null
  status_code:   number | null
  created_at:    Date
  expires_at:    Date
}

function makeProcessingRow(): MockRow {
  return {
    key:           TEST_KEY as string,
    response_body: null,
    status_code:   null,
    created_at:    new Date('2024-01-01T00:00:00Z'),
    expires_at:    new Date('2024-01-02T00:00:00Z'),
  }
}

function makeCompletedRow(): MockRow {
  return {
    key:           TEST_KEY as string,
    response_body: { paymentId: 'pay_test_123' },
    status_code:   201,
    created_at:    new Date('2024-01-01T00:00:00Z'),
    expires_at:    new Date('2024-01-02T00:00:00Z'),
  }
}

function buildCachedJson(record: Partial<{
  key:          string
  status:       string
  statusCode:   number | null
  responseBody: unknown
  createdAt:    string
  expiresAt:    string
}>): string {
  return JSON.stringify({
    key:          TEST_KEY as string,
    status:       'COMPLETED',
    statusCode:   200,
    responseBody: { id: 'pay_001' },
    createdAt:    '2024-01-01T00:00:00.000Z',
    expiresAt:    '2024-01-02T00:00:00.000Z',
    ...record,
  })
}

// ─── Setup de mocks ──────────────────────────────────────────────────────────

describe('RedisPostgresIdempotencyStore', () => {
  let store: RedisPostgresIdempotencyStore

  let mockInsert:   jest.Mock
  let mockFirst:    jest.Mock
  let mockUpdate:   jest.Mock
  let mockDelete:   jest.Mock
  let mockWhere:    jest.Mock
  let mockDb:       jest.Mock

  let mockRedisGet:   jest.Mock
  let mockRedisSetex: jest.Mock
  let mockRedis:      Redis

  beforeEach(() => {
    mockInsert  = jest.fn().mockResolvedValue(undefined)
    mockFirst   = jest.fn().mockResolvedValue(undefined)
    mockUpdate  = jest.fn().mockResolvedValue(1)
    mockDelete  = jest.fn().mockResolvedValue(1)
    mockWhere   = jest.fn().mockReturnValue({
      first:  mockFirst,
      update: mockUpdate,
      delete: mockDelete,
    })
    mockDb = jest.fn().mockReturnValue({
      insert: mockInsert,
      where:  mockWhere,
    })

    mockRedisGet   = jest.fn().mockResolvedValue(null)
    mockRedisSetex = jest.fn().mockResolvedValue('OK')
    mockRedis      = { get: mockRedisGet, setex: mockRedisSetex } as unknown as Redis

    store = new RedisPostgresIdempotencyStore(
      mockDb as unknown as Knex,
      mockRedis,
      TEST_TTL,
    )
  })

  // ─── tryAcquire ──────────────────────────────────────────────────────────

  describe('tryAcquire()', () => {

    describe('Redis HIT — retorna resultado cacheado sem tocar no PostgreSQL', () => {

      it('retorna { isNew: false, record } quando cache contém COMPLETED', async () => {
        mockRedisGet.mockResolvedValue(buildCachedJson({ status: 'COMPLETED', statusCode: 201 }))

        const result = await store.tryAcquire(TEST_KEY)

        expect(result.isNew).toBe(false)
        if (!result.isNew) {
          expect(result.record.status).toBe('COMPLETED')
          expect(result.record.statusCode).toBe(201)
        }
        expect(mockDb).not.toHaveBeenCalled()
      })

      it('retorna { isNew: false, record } quando cache contém PROCESSING', async () => {
        mockRedisGet.mockResolvedValue(buildCachedJson({ status: 'PROCESSING', statusCode: null }))

        const result = await store.tryAcquire(TEST_KEY)

        expect(result.isNew).toBe(false)
        if (!result.isNew) {
          expect(result.record.status).toBe('PROCESSING')
        }
        expect(mockDb).not.toHaveBeenCalled()
      })

      it('consulta o Redis com o prefixo correto', async () => {
        mockRedisGet.mockResolvedValue(buildCachedJson({}))

        await store.tryAcquire(TEST_KEY)

        expect(mockRedisGet).toHaveBeenCalledWith(`${REDIS_PREFIX}${TEST_KEY}`)
      })

    })

    describe('Redis HIT com JSON inválido — cai para PostgreSQL', () => {

      it('tenta INSERT no PostgreSQL quando o cache Redis está corrompido', async () => {
        mockRedisGet.mockResolvedValue('{ invalid json }}}')

        await store.tryAcquire(TEST_KEY)

        expect(mockDb).toHaveBeenCalledWith('idempotency_keys')
      })

    })

    describe('Redis MISS — primeira requisição', () => {

      it('retorna { isNew: true } quando INSERT no PostgreSQL tem sucesso', async () => {
        mockRedisGet.mockResolvedValue(null)
        mockInsert.mockResolvedValue(undefined)

        const result = await store.tryAcquire(TEST_KEY)

        expect(result.isNew).toBe(true)
      })

      it('insere a chave com expires_at calculado a partir do TTL configurado', async () => {
        const before = Date.now()
        await store.tryAcquire(TEST_KEY)
        const after = Date.now()

        const [insertData] = mockInsert.mock.calls[0] as [{ key: string; expires_at: Date }]
        const expiresMs = insertData.expires_at.getTime()

        expect(expiresMs).toBeGreaterThanOrEqual(before + TEST_TTL * 1000)
        expect(expiresMs).toBeLessThanOrEqual(after  + TEST_TTL * 1000)
      })

    })

    describe('Redis MISS — race condition (violação de unicidade no INSERT)', () => {

      const uniqueViolationError = Object.assign(new Error('duplicate key'), { code: '23505' })

      beforeEach(() => {
        mockInsert.mockRejectedValue(uniqueViolationError)
      })

      it('retorna { isNew: false, record } com status PROCESSING quando SELECT encontra linha em processamento', async () => {
        mockFirst.mockResolvedValue(makeProcessingRow())

        const result = await store.tryAcquire(TEST_KEY)

        expect(result.isNew).toBe(false)
        if (!result.isNew) {
          expect(result.record.status).toBe('PROCESSING')
          expect(result.record.statusCode).toBeNull()
        }
      })

      it('NÃO popula o Redis para registros PROCESSING', async () => {
        mockFirst.mockResolvedValue(makeProcessingRow())

        await store.tryAcquire(TEST_KEY)

        expect(mockRedisSetex).not.toHaveBeenCalled()
      })

      it('retorna { isNew: false, record } com status COMPLETED quando SELECT encontra linha concluída', async () => {
        mockFirst.mockResolvedValue(makeCompletedRow())

        const result = await store.tryAcquire(TEST_KEY)

        expect(result.isNew).toBe(false)
        if (!result.isNew) {
          expect(result.record.status).toBe('COMPLETED')
          expect(result.record.statusCode).toBe(201)
          expect(result.record.responseBody).toEqual({ paymentId: 'pay_test_123' })
        }
      })

      it('recarrega o Redis ao encontrar registro COMPLETED expirado do cache (ADR-002, passo 4)', async () => {
        mockFirst.mockResolvedValue(makeCompletedRow())

        await store.tryAcquire(TEST_KEY)

        expect(mockRedisSetex).toHaveBeenCalledWith(
          `${REDIS_PREFIX}${TEST_KEY}`,
          TEST_TTL,
          expect.any(String),
        )
        const serialized = JSON.parse(mockRedisSetex.mock.calls[0][2] as string) as { status: string }
        expect(serialized.status).toBe('COMPLETED')
      })

      it('retorna { isNew: true } quando SELECT não encontra a linha (deleção entre conflito e fetch)', async () => {
        mockFirst.mockResolvedValue(undefined)

        const result = await store.tryAcquire(TEST_KEY)

        expect(result.isNew).toBe(true)
      })

    })

    describe('Redis MISS — erro de infraestrutura no INSERT', () => {

      it('propaga o erro quando não é violação de unicidade', async () => {
        const infraError = new Error('connection refused')
        mockInsert.mockRejectedValue(infraError)

        await expect(store.tryAcquire(TEST_KEY)).rejects.toThrow('connection refused')
      })

    })

  })

  // ─── complete ─────────────────────────────────────────────────────────────

  describe('complete()', () => {

    it('atualiza o PostgreSQL com statusCode e responseBody', async () => {
      const responseBody = { orderId: 'ord_001', status: 'paid' }

      await store.complete(TEST_KEY, 201, responseBody)

      expect(mockWhere).toHaveBeenCalledWith({ key: TEST_KEY })
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ status_code: 201, response_body: responseBody }),
      )
    })

    it('salva o registro COMPLETED no Redis com o TTL configurado', async () => {
      const responseBody = { orderId: 'ord_001' }

      await store.complete(TEST_KEY, 200, responseBody)

      expect(mockRedisSetex).toHaveBeenCalledWith(
        `${REDIS_PREFIX}${TEST_KEY}`,
        TEST_TTL,
        expect.any(String),
      )
    })

    it('o JSON salvo no Redis contém status COMPLETED, statusCode e responseBody', async () => {
      const responseBody = { amount: 5000 }

      await store.complete(TEST_KEY, 202, responseBody)

      const serializedArg = mockRedisSetex.mock.calls[0][2] as string
      const parsed = JSON.parse(serializedArg) as IdempotencyRecord
      expect(parsed.status).toBe('COMPLETED')
      expect(parsed.statusCode).toBe(202)
      expect(parsed.responseBody).toEqual({ amount: 5000 })
    })

  })

  // ─── fail ─────────────────────────────────────────────────────────────────

  describe('fail()', () => {

    it('deleta a linha do PostgreSQL para liberar o retry', async () => {
      await store.fail(TEST_KEY)

      expect(mockWhere).toHaveBeenCalledWith({ key: TEST_KEY })
      expect(mockDelete).toHaveBeenCalled()
    })

    it('NÃO escreve no Redis — próxima tentativa deve percorrer o fluxo normal', async () => {
      await store.fail(TEST_KEY)

      expect(mockRedisSetex).not.toHaveBeenCalled()
    })

  })

})
