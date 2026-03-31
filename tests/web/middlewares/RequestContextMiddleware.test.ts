import type { Request, Response, NextFunction } from 'express'
import type { Logger } from 'pino'
import { requestContextMiddleware } from '../../../src/web/middlewares/RequestContextMiddleware'

const VALID_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function makeLogger(): jest.Mocked<Logger> {
  const child = jest.fn().mockReturnThis()
  return {
    child,
    info:  jest.fn(),
    error: jest.fn(),
    warn:  jest.fn(),
  } as unknown as jest.Mocked<Logger>
}

function makeRes(): {
  res: jest.Mocked<Response>
  setHeader: jest.Mock
} {
  const setHeader = jest.fn()
  const res = {
    locals:    {} as Record<string, unknown>,
    setHeader,
  } as unknown as jest.Mocked<Response>
  return { res, setHeader }
}

function makeReq(requestId?: string): Partial<Request> {
  const headers: Record<string, string> = {}
  if (requestId !== undefined) headers['x-request-id'] = requestId
  return { headers }
}

describe('requestContextMiddleware', () => {
  const next: NextFunction = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('uses X-Request-ID from header when present', () => {
    const logger     = makeLogger()
    const { res }    = makeRes()
    const middleware = requestContextMiddleware(logger)
    const customId   = '12345678-1234-4234-8234-123456789012'

    middleware(makeReq(customId) as Request, res, next)

    expect(res.locals['requestId']).toBe(customId)
  })

  it('generates a UUID when X-Request-ID header is absent', () => {
    const logger     = makeLogger()
    const { res }    = makeRes()
    const middleware = requestContextMiddleware(logger)

    middleware(makeReq() as Request, res, next)

    expect(typeof res.locals['requestId']).toBe('string')
    expect(VALID_UUID_RE.test(res.locals['requestId'] as string)).toBe(true)
  })

  it('sets X-Request-ID on the response header', () => {
    const logger        = makeLogger()
    const { res, setHeader } = makeRes()
    const middleware    = requestContextMiddleware(logger)

    middleware(makeReq() as Request, res, next)

    expect(setHeader).toHaveBeenCalledWith('X-Request-ID', res.locals['requestId'])
  })

  it('creates a child logger with requestId binding', () => {
    const logger     = makeLogger()
    const { res }    = makeRes()
    const middleware = requestContextMiddleware(logger)

    middleware(makeReq() as Request, res, next)

    expect(logger.child).toHaveBeenCalledWith(
      expect.objectContaining({ request_id: res.locals['requestId'] }),
    )
    expect(res.locals['logger']).toBeDefined()
  })

  it('stores traceId in res.locals (undefined when no active span)', () => {
    const logger     = makeLogger()
    const { res }    = makeRes()
    const middleware = requestContextMiddleware(logger)

    middleware(makeReq() as Request, res, next)

    // traceId may be undefined when no OTel span is active — key still set
    expect('traceId' in res.locals).toBe(true)
  })

  it('calls next()', () => {
    const logger     = makeLogger()
    const { res }    = makeRes()
    const middleware = requestContextMiddleware(logger)
    const nextFn     = jest.fn()

    middleware(makeReq() as Request, res, nextFn)

    expect(nextFn).toHaveBeenCalledTimes(1)
  })
})
