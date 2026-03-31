import express, { Router } from 'express'
import type { WebhookController } from '../controllers/WebhookController'

/**
 * Monta as rotas de webhook por gateway.
 *
 * POST /stripe → express.raw (body como Buffer para verificação HMAC) → ctrl.handleStripe
 * POST /asaas  → express.json                                         → ctrl.handleAsaas
 */
export function webhookRoutes(controller: WebhookController): Router {
  const router = Router()

  // express.raw mantém o body como Buffer — necessário para verificar HMAC-SHA256 (ADR-002)
  router.post(
    '/stripe',
    express.raw({ type: 'application/json' }),
    (req, res, next) => void controller.handleStripe(req, res, next),
  )

  router.post(
    '/asaas',
    express.json(),
    (req, res, next) => void controller.handleAsaas(req, res, next),
  )

  return router
}
