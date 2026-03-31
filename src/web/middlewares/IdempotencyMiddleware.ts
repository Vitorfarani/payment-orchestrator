import type { Request, Response, NextFunction, RequestHandler } from 'express'
import type { IIdempotencyStore } from '../../application/shared/IIdempotencyStore'
import { IdempotencyKey } from '../../domain/shared/types'

/**
 * Implementa idempotência transparente para rotas que enviam x-idempotency-key (ADR-002).
 *
 * Rotas sem o header passam livre — controllers não sabem que este middleware existe.
 * A chave é prefixada com merchantId para prevenir colisões entre merchants.
 *
 * Ciclo de vida:
 *   isNew         → processa e intercepta res.json para chamar store.complete
 *   PROCESSING    → 409 IDEMPOTENCY_CONFLICT
 *   COMPLETED     → replay da resposta original sem chamar next()
 *
 * store.fail() é chamado pelo ErrorHandlerMiddleware em caso de 5xx.
 */
export function idempotencyMiddleware(store: IIdempotencyStore): RequestHandler {
  const inner = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const rawKeyHeader = req.headers['x-idempotency-key']
    const rawKey       = typeof rawKeyHeader === 'string' ? rawKeyHeader : undefined

    if (rawKey === undefined || rawKey === '') {
      next()
      return
    }

    const merchantId = typeof res.locals['merchantId'] === 'string'
      ? res.locals['merchantId']
      : 'anonymous'

    const prefixedKey = IdempotencyKey.of(`${merchantId}:${rawKey}`)

    const result = await store.tryAcquire(prefixedKey)

    if (!result.isNew) {
      const { record } = result

      if (record.status === 'PROCESSING') {
        res.status(409).json({
          error: 'A request with this idempotency key is already being processed',
          code:  'IDEMPOTENCY_CONFLICT',
        })
        return
      }

      // COMPLETED — replay
      res.status(record.statusCode ?? 200).json(record.responseBody)
      return
    }

    // First request — store key in locals so ErrorHandlerMiddleware can call store.fail
    res.locals['idempotencyKey'] = prefixedKey

    // Intercept res.json to persist the response for future replays
    const originalJson: (body: unknown) => Response = res.json.bind(res)
    res.json = function (body: unknown): Response {
      void store.complete(prefixedKey, res.statusCode, body).catch(() => {
        // Non-fatal — the next request will re-process if store.complete failed
      })
      return originalJson(body)
    }

    next()
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    inner(req, res, next).catch(next)
  }
}
