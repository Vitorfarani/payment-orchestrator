import type { Request, Response, NextFunction } from 'express'
import type { Logger } from 'pino'
import type { IIdempotencyStore } from '../../../src/application/shared/IIdempotencyStore'
import { errorHandlerMiddleware } from '../../../src/web/middlewares/ErrorHandlerMiddleware'
import {
  ValidationError,
  BusinessRuleError,
  NotFoundError,
  ConflictError,
  GatewayError,
  DomainError,
} from '../../../src/domain/shared/errors'
import { IdempotencyKey } from '../../../src/domain/shared/types'

function makeLogger(): jest.Mocked<Logger> {
  return {
    error: jest.fn(),
    warn:  jest.fn(),
    info:  jest.fn(),
  } as unknown as jest.Mocked<Logger>
}

function makeRes(locals: Record<string, unknown> = {}): jest.Mocked<Response> {
  const res = {
    locals,
    status: jest.fn().mockReturnThis(),
    json:   jest.fn().mockReturnThis(),
  } as unknown as jest.Mocked<Response>
  return res
}

function makeReq(requestId = 'test-request-id'): Partial<Request> {
  return { headers: {} }
}

function makeStore(): jest.Mocked<IIdempotencyStore> {
  return {
    tryAcquire: jest.fn(),
    complete:   jest.fn(),
    fail:       jest.fn().mockResolvedValue(undefined),
  }
}

describe('errorHandlerMiddleware', () => {
  const next: NextFunction = jest.fn()

  describe('HTTP status mapping', () => {
    const cases: Array<[string, Error, number]> = [
      ['ValidationError',   new ValidationError('bad input'),        422],
      ['BusinessRuleError', new BusinessRuleError('rule violated'),   409],
      ['NotFoundError',     new NotFoundError('Payment', 'abc'),      404],
      ['ConflictError',     new ConflictError('already exists'),      409],
      ['GatewayError',      new GatewayError('stripe timeout'),       502],
      ['DomainError',       new DomainError('generic domain'),        400],
      ['unknown Error',     new Error('unexpected'),                  500],
    ]

    test.each(cases)('%s → %i', async (_, error, expectedStatus) => {
      const logger = makeLogger()
      const res    = makeRes({ requestId: 'req-1' })
      const middleware = errorHandlerMiddleware(logger)

      await middleware(error, makeReq() as Request, res, next)

      expect(res.status).toHaveBeenCalledWith(expectedStatus)
      expect(res.json).toHaveBeenCalled()
    })
  })

  it('logs error for 5xx', async () => {
    const logger     = makeLogger()
    const res        = makeRes({ requestId: 'req-1' })
    const middleware = errorHandlerMiddleware(logger)

    await middleware(new Error('boom'), makeReq() as Request, res, next)

    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('logs warn for 4xx', async () => {
    const logger     = makeLogger()
    const res        = makeRes({ requestId: 'req-1' })
    const middleware = errorHandlerMiddleware(logger)

    await middleware(new NotFoundError('Payment', 'abc'), makeReq() as Request, res, next)

    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('never exposes stack trace in response body', async () => {
    const logger     = makeLogger()
    const res        = makeRes({ requestId: 'req-1' })
    const middleware = errorHandlerMiddleware(logger)

    await middleware(new Error('internal'), makeReq() as Request, res, next)

    const body = (res.json as jest.Mock).mock.calls[0][0] as Record<string, unknown>
    expect(body).not.toHaveProperty('stack')
  })

  it('calls store.fail when 5xx and idempotencyKey present', async () => {
    const logger     = makeLogger()
    const store      = makeStore()
    const key        = IdempotencyKey.generate()
    const res        = makeRes({ requestId: 'req-1', idempotencyKey: key })
    const middleware = errorHandlerMiddleware(logger, store)

    await middleware(new Error('internal'), makeReq() as Request, res, next)

    expect(store.fail).toHaveBeenCalledWith(key)
  })

  it('does NOT call store.fail for 4xx errors', async () => {
    const logger     = makeLogger()
    const store      = makeStore()
    const key        = IdempotencyKey.generate()
    const res        = makeRes({ requestId: 'req-1', idempotencyKey: key })
    const middleware = errorHandlerMiddleware(logger, store)

    await middleware(new ValidationError('bad'), makeReq() as Request, res, next)

    expect(store.fail).not.toHaveBeenCalled()
  })

  it('includes requestId in response body', async () => {
    const logger     = makeLogger()
    const res        = makeRes({ requestId: 'my-request-id' })
    const middleware = errorHandlerMiddleware(logger)

    await middleware(new NotFoundError('Payment', 'abc'), makeReq() as Request, res, next)

    const body = (res.json as jest.Mock).mock.calls[0][0] as Record<string, unknown>
    expect(body['requestId']).toBe('my-request-id')
  })

  it('includes error code in response body', async () => {
    const logger     = makeLogger()
    const res        = makeRes({ requestId: 'req-1' })
    const middleware = errorHandlerMiddleware(logger)

    await middleware(new ValidationError('bad'), makeReq() as Request, res, next)

    const body = (res.json as jest.Mock).mock.calls[0][0] as Record<string, unknown>
    expect(body['code']).toBe('VALIDATION_ERROR')
  })
})
