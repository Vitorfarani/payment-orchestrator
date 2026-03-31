import { Router } from 'express'
import type { Redis } from 'ioredis'
import type { IIdempotencyStore } from '../../application/shared/IIdempotencyStore'
import { authMiddleware } from '../middlewares/AuthMiddleware'
import { idempotencyMiddleware } from '../middlewares/IdempotencyMiddleware'
import { rateLimitMiddleware } from '../middlewares/RateLimitMiddleware'
import type { PaymentController } from '../controllers/PaymentController'

/**
 * Monta as rotas de pagamento com o stack completo de middlewares por rota.
 *
 * POST /         → auth → idempotency → rateLimit(30, create-payment) → ctrl.create
 * GET  /:id      → auth → rateLimit(60, get-payment)                  → ctrl.getById
 * POST /:id/refund → auth → idempotency → rateLimit(10, refund-payment) → ctrl.refund
 */
export function paymentRoutes(
  controller:       PaymentController,
  idempotencyStore: IIdempotencyStore,
  redis:            Redis,
): Router {
  const router = Router()

  router.post(
    '/',
    authMiddleware(),
    idempotencyMiddleware(idempotencyStore),
    rateLimitMiddleware(redis, 30, 'create-payment'),
    (req, res, next) => void controller.create(req, res, next),
  )

  router.get(
    '/:id',
    authMiddleware(),
    rateLimitMiddleware(redis, 60, 'get-payment'),
    (req, res, next) => void controller.getById(req, res, next),
  )

  router.post(
    '/:id/refund',
    authMiddleware(),
    idempotencyMiddleware(idempotencyStore),
    rateLimitMiddleware(redis, 10, 'refund-payment'),
    (req, res, next) => void controller.refund(req, res, next),
  )

  return router
}
