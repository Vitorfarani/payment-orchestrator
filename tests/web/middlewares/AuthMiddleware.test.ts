import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { authMiddleware } from '../../../src/web/middlewares/AuthMiddleware'

const SECRET = 'test-secret-key-long-enough'

function makeRes(): jest.Mocked<Response> {
  return {
    locals: {} as Record<string, unknown>,
    status: jest.fn().mockReturnThis(),
    json:   jest.fn().mockReturnThis(),
  } as unknown as jest.Mocked<Response>
}

function makeReq(authorization?: string): Partial<Request> {
  const headers: Record<string, string> = {}
  if (authorization !== undefined) headers['authorization'] = authorization
  return { headers }
}

function signToken(payload: object): string {
  return jwt.sign(payload, SECRET, { expiresIn: '1h' })
}

describe('authMiddleware', () => {
  const next: NextFunction = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
    process.env['JWT_SECRET'] = SECRET
  })

  afterEach(() => {
    delete process.env['JWT_SECRET']
  })

  it('returns 401 AUTH_MISSING when no Authorization header', () => {
    const res        = makeRes()
    const middleware = authMiddleware()

    middleware(makeReq() as Request, res, next)

    expect(res.status).toHaveBeenCalledWith(401)
    const body = (res.json as jest.Mock).mock.calls[0][0] as Record<string, unknown>
    expect(body['code']).toBe('AUTH_MISSING')
    expect(next).not.toHaveBeenCalled()
  })

  it('returns 401 AUTH_INVALID_FORMAT when Authorization is not Bearer', () => {
    const res        = makeRes()
    const middleware = authMiddleware()

    middleware(makeReq('Basic sometoken') as Request, res, next)

    expect(res.status).toHaveBeenCalledWith(401)
    const body = (res.json as jest.Mock).mock.calls[0][0] as Record<string, unknown>
    expect(body['code']).toBe('AUTH_INVALID_FORMAT')
    expect(next).not.toHaveBeenCalled()
  })

  it('returns 401 AUTH_INVALID_FORMAT when Bearer token is missing', () => {
    const res        = makeRes()
    const middleware = authMiddleware()

    middleware(makeReq('Bearer ') as Request, res, next)

    expect(res.status).toHaveBeenCalledWith(401)
    const body = (res.json as jest.Mock).mock.calls[0][0] as Record<string, unknown>
    expect(body['code']).toBe('AUTH_INVALID_FORMAT')
  })

  it('returns 401 AUTH_INVALID when token verification fails', () => {
    const res        = makeRes()
    const middleware = authMiddleware()
    const badToken   = jwt.sign({ merchantId: 'm1', role: 'merchant' }, 'wrong-secret')

    middleware(makeReq(`Bearer ${badToken}`) as Request, res, next)

    expect(res.status).toHaveBeenCalledWith(401)
    const body = (res.json as jest.Mock).mock.calls[0][0] as Record<string, unknown>
    expect(body['code']).toBe('AUTH_INVALID')
    expect(next).not.toHaveBeenCalled()
  })

  it('returns 401 AUTH_INVALID for an expired token', () => {
    const res        = makeRes()
    const middleware = authMiddleware()
    const expired    = jwt.sign({ merchantId: 'm1', role: 'merchant' }, SECRET, { expiresIn: -1 })

    middleware(makeReq(`Bearer ${expired}`) as Request, res, next)

    expect(res.status).toHaveBeenCalledWith(401)
    const body = (res.json as jest.Mock).mock.calls[0][0] as Record<string, unknown>
    expect(body['code']).toBe('AUTH_INVALID')
  })

  it('stores merchantId, role in res.locals and calls next on valid token', () => {
    const res        = makeRes()
    const middleware = authMiddleware()
    const token      = signToken({ merchantId: 'merchant-123', role: 'merchant' })

    middleware(makeReq(`Bearer ${token}`) as Request, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(res.locals['merchantId']).toBe('merchant-123')
    expect(res.locals['role']).toBe('merchant')
  })

  it('stores optional sellerId in res.locals when present in token', () => {
    const res        = makeRes()
    const middleware = authMiddleware()
    const token      = signToken({ merchantId: 'merchant-123', sellerId: 'seller-456', role: 'admin' })

    middleware(makeReq(`Bearer ${token}`) as Request, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(res.locals['sellerId']).toBe('seller-456')
  })

  it('does not set sellerId in res.locals when absent from token', () => {
    const res        = makeRes()
    const middleware = authMiddleware()
    const token      = signToken({ merchantId: 'merchant-123', role: 'merchant' })

    middleware(makeReq(`Bearer ${token}`) as Request, res, next)

    expect(res.locals['sellerId']).toBeUndefined()
  })
})
