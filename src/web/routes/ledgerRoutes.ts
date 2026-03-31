import { Router } from 'express'
import type { Redis } from 'ioredis'
import { authMiddleware } from '../middlewares/AuthMiddleware'
import { rateLimitMiddleware } from '../middlewares/RateLimitMiddleware'
import type { LedgerController } from '../controllers/LedgerController'

/**
 * Monta as rotas do ledger (CQRS read model — ADR-007).
 *
 * GET /summary → auth → rateLimit(60, ledger-summary) → ctrl.getSummary
 */
export function ledgerRoutes(controller: LedgerController, redis: Redis): Router {
  const router = Router()

  router.get(
    '/summary',
    authMiddleware(),
    rateLimitMiddleware(redis, 60, 'ledger-summary'),
    (req, res, next) => void controller.getSummary(req, res, next),
  )

  return router
}
