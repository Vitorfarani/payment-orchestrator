import type { Request, Response, NextFunction, RequestHandler } from 'express'
import type { Redis } from 'ioredis'

/**
 * Sliding window rate limiter por merchantId usando Redis INCR/EXPIRE (ADR-003).
 *
 * Janela de 1 minuto: a chave é composta por endpoint + merchantId + minuto atual.
 * Sem pacote extra — usa os comandos nativos do Redis já presente no projeto.
 *
 * Headers emitidos:
 *   X-RateLimit-Limit     — limite configurado
 *   X-RateLimit-Remaining — requisições restantes na janela (mínimo 0)
 *   X-RateLimit-Reset     — Unix timestamp (segundos) do fim da janela atual
 */
export function rateLimitMiddleware(
  redis: Redis,
  limit: number,
  endpoint: string,
): RequestHandler {
  const inner = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const merchantId  = typeof res.locals['merchantId'] === 'string'
      ? res.locals['merchantId']
      : 'anonymous'

    const now         = Date.now()
    const windowSlot  = Math.floor(now / 60_000)
    const windowStart = windowSlot * 60_000
    const resetTs     = Math.floor((windowStart + 60_000) / 1000)

    const key   = `ratelimit:${endpoint}:${merchantId}:${windowSlot}`
    const count = await redis.incr(key)

    if (count === 1) {
      void redis.expire(key, 60)
    }

    const remaining = Math.max(0, limit - count)

    res.setHeader('X-RateLimit-Limit',     limit)
    res.setHeader('X-RateLimit-Remaining', remaining)
    res.setHeader('X-RateLimit-Reset',     resetTs)

    if (count > limit) {
      res.status(429).json({
        error: 'Too many requests — please retry after the rate limit window resets',
        code:  'RATE_LIMIT_EXCEEDED',
      })
      return
    }

    next()
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    inner(req, res, next).catch(next)
  }
}
