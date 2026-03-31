import type { Request, Response, NextFunction, RequestHandler } from 'express'
import jwt from 'jsonwebtoken'

interface JwtPayload {
  merchantId: string
  sellerId?:  string
  role:       'merchant' | 'admin'
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function isJwtPayload(v: unknown): v is JwtPayload {
  if (!isRecord(v)) return false
  return (
    typeof v['merchantId'] === 'string' &&
    (v['role'] === 'merchant' || v['role'] === 'admin')
  )
}

/**
 * Valida JWT Bearer e injeta identidade do merchant em res.locals (ADR-018).
 *
 * JWT_SECRET lido de process.env — index.ts faz o fail-fast antes de subir o servidor.
 */
export function authMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers['authorization']

    if (authHeader === undefined || authHeader === '') {
      res.status(401).json({ error: 'Missing Authorization header', code: 'AUTH_MISSING' })
      return
    }

    if (!authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authorization must be Bearer <token>', code: 'AUTH_INVALID_FORMAT' })
      return
    }

    const token = authHeader.slice('Bearer '.length).trim()

    if (token === '') {
      res.status(401).json({ error: 'Authorization must be Bearer <token>', code: 'AUTH_INVALID_FORMAT' })
      return
    }

    const secret = process.env['JWT_SECRET'] ?? ''

    let payload: unknown
    try {
      payload = jwt.verify(token, secret)
    } catch {
      res.status(401).json({ error: 'Invalid or expired token', code: 'AUTH_INVALID' })
      return
    }

    if (!isJwtPayload(payload)) {
      res.status(401).json({ error: 'Invalid token payload', code: 'AUTH_INVALID' })
      return
    }

    res.locals['merchantId'] = payload.merchantId
    res.locals['role']       = payload.role
    if (payload.sellerId !== undefined) {
      res.locals['sellerId'] = payload.sellerId
    }

    next()
  }
}
