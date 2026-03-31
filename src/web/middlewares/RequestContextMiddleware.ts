import { randomUUID } from 'crypto'
import type { Request, Response, NextFunction, RequestHandler } from 'express'
import type { Logger } from 'pino'
import { trace } from '@opentelemetry/api'
import { createRequestLogger } from '../../infrastructure/logger/logger'

/**
 * Injeta request_id e trace_id em todo ciclo de vida do request (ADR-017).
 *
 * Lê X-Request-ID do header ou gera um novo UUID v4.
 * Extrai trace_id do span OpenTelemetry ativo, se houver.
 * Armazena requestId, traceId e logger child em res.locals.
 */
export function requestContextMiddleware(baseLogger: Logger): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const rawRequestId = req.headers['x-request-id']
    const requestId    = typeof rawRequestId === 'string' ? rawRequestId : randomUUID()

    const activeSpan = trace.getActiveSpan()
    const traceId    = activeSpan?.spanContext().traceId

    const childLogger = createRequestLogger(baseLogger, requestId, traceId)

    res.locals['requestId'] = requestId
    res.locals['traceId']   = traceId
    res.locals['logger']    = childLogger

    res.setHeader('X-Request-ID', requestId)

    next()
  }
}
