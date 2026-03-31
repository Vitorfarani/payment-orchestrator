import type { Request, Response, NextFunction } from 'express'
import type { Redis } from 'ioredis'
import { rateLimitMiddleware } from '../../../src/web/middlewares/RateLimitMiddleware'

function makeRedis(incrValue: number): jest.Mocked<Redis> {
  return {
    incr:   jest.fn().mockResolvedValue(incrValue),
    expire: jest.fn().mockResolvedValue(1),
  } as unknown as jest.Mocked<Redis>
}

function makeRes(merchantId = 'merchant-123'): jest.Mocked<Response> {
  return {
    locals:     { merchantId } as Record<string, unknown>,
    status:     jest.fn().mockReturnThis(),
    json:       jest.fn().mockReturnThis(),
    setHeader:  jest.fn(),
  } as unknown as jest.Mocked<Response>
}

function makeReq(): Partial<Request> {
  return { headers: {} }
}

describe('rateLimitMiddleware', () => {
  let next: jest.Mock

  beforeEach(() => {
    next = jest.fn()
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2024-01-01T00:00:00.000Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('calls next when under the limit', async () => {
    const redis      = makeRedis(1)
    const res        = makeRes()
    const middleware = rateLimitMiddleware(redis, 30, 'POST /payments')

    await middleware(makeReq() as Request, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(res.status).not.toHaveBeenCalled()
  })

  it('calls next when exactly at the limit', async () => {
    const redis      = makeRedis(30)
    const res        = makeRes()
    const middleware = rateLimitMiddleware(redis, 30, 'POST /payments')

    await middleware(makeReq() as Request, res, next)

    expect(next).toHaveBeenCalledTimes(1)
  })

  it('returns 429 when over the limit', async () => {
    const redis      = makeRedis(31)
    const res        = makeRes()
    const middleware = rateLimitMiddleware(redis, 30, 'POST /payments')

    await middleware(makeReq() as Request, res, next)

    expect(res.status).toHaveBeenCalledWith(429)
    expect(next).not.toHaveBeenCalled()
  })

  it('calls expire with 60 when count === 1 (first request in window)', async () => {
    const redis      = makeRedis(1)
    const res        = makeRes()
    const middleware = rateLimitMiddleware(redis, 30, 'POST /payments')

    await middleware(makeReq() as Request, res, next)

    expect(redis.expire).toHaveBeenCalledWith(expect.any(String), 60)
  })

  it('does NOT call expire when count > 1', async () => {
    const redis      = makeRedis(5)
    const res        = makeRes()
    const middleware = rateLimitMiddleware(redis, 30, 'POST /payments')

    await middleware(makeReq() as Request, res, next)

    expect(redis.expire).not.toHaveBeenCalled()
  })

  it('sets X-RateLimit-Limit header', async () => {
    const redis      = makeRedis(1)
    const res        = makeRes()
    const middleware = rateLimitMiddleware(redis, 30, 'POST /payments')

    await middleware(makeReq() as Request, res, next)

    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', 30)
  })

  it('sets X-RateLimit-Remaining header (limit - count, floored at 0)', async () => {
    const redis      = makeRedis(10)
    const res        = makeRes()
    const middleware = rateLimitMiddleware(redis, 30, 'POST /payments')

    await middleware(makeReq() as Request, res, next)

    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', 20)
  })

  it('sets X-RateLimit-Remaining to 0 when over limit', async () => {
    const redis      = makeRedis(50)
    const res        = makeRes()
    const middleware = rateLimitMiddleware(redis, 30, 'POST /payments')

    await middleware(makeReq() as Request, res, next)

    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', 0)
  })

  it('sets X-RateLimit-Reset header as Unix timestamp of window end', async () => {
    const redis      = makeRedis(1)
    const res        = makeRes()
    const middleware = rateLimitMiddleware(redis, 30, 'POST /payments')

    await middleware(makeReq() as Request, res, next)

    // Window: Math.floor(Date.now() / 60_000) * 60_000 + 60_000
    const now         = Date.now()
    const windowStart = Math.floor(now / 60_000) * 60_000
    const resetTs     = Math.floor((windowStart + 60_000) / 1000)

    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Reset', resetTs)
  })

  it('uses merchantId in Redis key for isolation', async () => {
    const redis      = makeRedis(1)
    const res        = makeRes('merchant-xyz')
    const middleware = rateLimitMiddleware(redis, 30, 'POST /payments')

    await middleware(makeReq() as Request, res, next)

    const redisKey = (redis.incr as jest.Mock).mock.calls[0][0] as string
    expect(redisKey).toContain('merchant-xyz')
  })

  it('uses endpoint in Redis key for isolation', async () => {
    const redis      = makeRedis(1)
    const res        = makeRes()
    const middleware = rateLimitMiddleware(redis, 30, 'GET /payments/:id')

    await middleware(makeReq() as Request, res, next)

    const redisKey = (redis.incr as jest.Mock).mock.calls[0][0] as string
    expect(redisKey).toContain('GET /payments/:id')
  })
})
