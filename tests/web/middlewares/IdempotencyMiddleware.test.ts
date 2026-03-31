import type { Request, Response, NextFunction } from 'express'
import { idempotencyMiddleware } from '../../../src/web/middlewares/IdempotencyMiddleware'
import { InMemoryIdempotencyStore } from '../../application/fakes/InMemoryIdempotencyStore'
import type { IdempotencyRecord } from '../../../src/application/shared/IIdempotencyStore'
import { IdempotencyKey } from '../../../src/domain/shared/types'

const MERCHANT_ID = 'merchant-abc'

function makeRes(): jest.Mocked<Response> & { _jsonIntercepted?: jest.Mock } {
  const res = {
    locals:     { merchantId: MERCHANT_ID } as Record<string, unknown>,
    status:     jest.fn().mockReturnThis(),
    json:       jest.fn().mockReturnThis(),
    statusCode: 200,
  } as unknown as jest.Mocked<Response> & { _jsonIntercepted?: jest.Mock }
  return res
}

function makeReq(idempotencyKey?: string): Partial<Request> {
  const headers: Record<string, string> = {}
  if (idempotencyKey !== undefined) headers['x-idempotency-key'] = idempotencyKey
  return { headers }
}

describe('idempotencyMiddleware', () => {
  let store: InMemoryIdempotencyStore
  let next: jest.Mock

  beforeEach(() => {
    store = new InMemoryIdempotencyStore()
    next  = jest.fn()
  })

  it('calls next without blocking when x-idempotency-key header is absent', async () => {
    const res        = makeRes()
    const middleware = idempotencyMiddleware(store)

    await middleware(makeReq() as Request, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(res.status).not.toHaveBeenCalled()
  })

  it('calls next and stores idempotencyKey in res.locals on first request', async () => {
    const res        = makeRes()
    const middleware = idempotencyMiddleware(store)

    await middleware(makeReq('unique-key-12345') as Request, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(res.locals['idempotencyKey']).toBeDefined()
  })

  it('prefixes key with merchantId to prevent collisions', async () => {
    const res        = makeRes()
    const middleware = idempotencyMiddleware(store)
    const rawKey     = 'my-key-99999'

    await middleware(makeReq(rawKey) as Request, res, next)

    const storedKey = res.locals['idempotencyKey'] as string
    expect(storedKey).toContain(MERCHANT_ID)
    expect(storedKey).toContain(rawKey)
  })

  it('returns 409 IDEMPOTENCY_CONFLICT when key is PROCESSING', async () => {
    const rawKey     = 'conflict-key-xyz'
    const prefixed   = IdempotencyKey.of(`${MERCHANT_ID}:${rawKey}`)
    // Acquire first to set PROCESSING state
    await store.tryAcquire(prefixed)

    const res        = makeRes()
    const middleware = idempotencyMiddleware(store)

    await middleware(makeReq(rawKey) as Request, res, next)

    expect(res.status).toHaveBeenCalledWith(409)
    const body = (res.json as jest.Mock).mock.calls[0][0] as Record<string, unknown>
    expect(body['code']).toBe('IDEMPOTENCY_CONFLICT')
    expect(next).not.toHaveBeenCalled()
  })

  it('replays completed response without calling next', async () => {
    const rawKey   = 'completed-key-abc'
    const prefixed = IdempotencyKey.of(`${MERCHANT_ID}:${rawKey}`)
    await store.tryAcquire(prefixed)
    await store.complete(prefixed, 201, { paymentId: 'pay-123' })

    const res        = makeRes()
    const middleware = idempotencyMiddleware(store)

    await middleware(makeReq(rawKey) as Request, res, next)

    expect(res.status).toHaveBeenCalledWith(201)
    expect(res.json).toHaveBeenCalledWith({ paymentId: 'pay-123' })
    expect(next).not.toHaveBeenCalled()
  })

  it('intercepts res.json to call store.complete on success', async () => {
    const res        = makeRes()
    const middleware = idempotencyMiddleware(store)
    const rawKey     = 'intercept-key-001'

    await middleware(makeReq(rawKey) as Request, res, next)

    // Simulate controller calling res.json
    const prefixed = IdempotencyKey.of(`${MERCHANT_ID}:${rawKey}`)
    const originalJson = res.json as jest.Mock

    // The middleware wraps res.json — get the wrapped version from locals context
    // We need to call through the patched res.json
    // Since jest.fn() was replaced by middleware, call it
    res.json({ result: 'ok' })

    // Give async store.complete time to run
    await Promise.resolve()

    const stored = store.get(prefixed)
    expect(stored?.status).toBe('COMPLETED')
    expect(stored?.responseBody).toEqual({ result: 'ok' })
  })
})
