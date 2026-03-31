import type { Request, Response, NextFunction, ErrorRequestHandler } from 'express'
import type { Logger } from 'pino'
import type { IIdempotencyStore } from '../../application/shared/IIdempotencyStore'
import { IdempotencyKey } from '../../domain/shared/types'
import {
  DomainError,
  ValidationError,
  BusinessRuleError,
  NotFoundError,
  ConflictError,
  GatewayError,
} from '../../domain/shared/errors'

function resolveStatus(error: unknown): number {
  if (error instanceof ValidationError)   return 422
  if (error instanceof NotFoundError)     return 404
  if (error instanceof GatewayError)      return 502
  if (error instanceof BusinessRuleError) return 409
  if (error instanceof ConflictError)     return 409
  if (error instanceof DomainError)       return 400
  return 500
}

function resolveCode(error: unknown): string {
  if (error instanceof DomainError) return error.code
  return 'INTERNAL_ERROR'
}

function resolveMessage(error: unknown, isServerError: boolean): string {
  if (isServerError) return 'An internal error occurred'
  if (error instanceof Error) return error.message
  return 'An error occurred'
}

/**
 * Handler de erros do Express (4 argumentos — ADR-014).
 *
 * - 4xx → logger.warn
 * - 5xx → logger.error, nunca expõe stack em produção
 * - Se res.locals.idempotencyKey presente e erro 5xx → store.fail(key)
 */
export function errorHandlerMiddleware(
  logger: Logger,
  store?: IIdempotencyStore,
): ErrorRequestHandler {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (error: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const status        = resolveStatus(error)
    const code          = resolveCode(error)
    const isServerError = status >= 500
    const requestId     = typeof res.locals['requestId'] === 'string' ? res.locals['requestId'] : undefined

    if (isServerError) {
      logger.error({ error, requestId }, 'Internal server error')

      const rawKey: unknown = res.locals['idempotencyKey']
      if (store !== undefined && typeof rawKey === 'string') {
        void store.fail(IdempotencyKey.of(rawKey)).catch((err: unknown) => {
          logger.error({ error: err, requestId }, 'Failed to mark idempotency key as failed')
        })
      }
    } else {
      logger.warn({ code, requestId }, 'Client error')
    }

    res.status(status).json({
      error:     resolveMessage(error, isServerError),
      code,
      requestId: requestId ?? null,
    })
  }
}
