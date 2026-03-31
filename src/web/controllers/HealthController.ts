import type { Request, Response, NextFunction } from 'express'

// Structural interfaces — compatíveis com Knex e ioredis sem importá-los diretamente
interface IDb {
  raw(sql: string): Promise<unknown>
}

interface IRedis {
  ping(): Promise<string>
}

export interface HealthControllerDeps {
  db:    IDb
  redis: IRedis
}

export class HealthController {
  constructor(private readonly deps: HealthControllerDeps) {}

  // -------------------------------------------------------------------------
  // GET /health/live
  // Liveness probe — apenas confirma que o processo está vivo. Nunca falha.
  // -------------------------------------------------------------------------
  live = (_req: Request, res: Response, _next: NextFunction): void => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() })
  }

  // -------------------------------------------------------------------------
  // GET /health/ready
  // Readiness probe — verifica dependências. 503 se qualquer check falhar.
  // -------------------------------------------------------------------------
  ready = async (_req: Request, res: Response, _next: NextFunction): Promise<void> => {
    const [dbResult, redisResult] = await Promise.allSettled([
      this.deps.db.raw('SELECT 1'),
      this.deps.redis.ping(),
    ])

    const checks = {
      postgres: dbResult.status    === 'fulfilled' ? 'ok' : 'error',
      redis:    redisResult.status === 'fulfilled' ? 'ok' : 'error',
    }

    const allOk  = checks.postgres === 'ok' && checks.redis === 'ok'
    const status = allOk ? 'ok' : 'error'

    res.status(allOk ? 200 : 503).json({ status, checks, timestamp: new Date().toISOString() })
  }
}
