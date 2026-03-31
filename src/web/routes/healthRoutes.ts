import { Router } from 'express'
import { metricsHandler } from '../../infrastructure/metrics/metrics'
import type { HealthController } from '../controllers/HealthController'

/**
 * Monta as rotas de saúde e métricas.
 *
 * GET /health/live  → sem auth — liveness probe para o orchestrador de containers
 * GET /health/ready → sem auth — readiness probe (verifica PostgreSQL + Redis)
 * GET /metrics      → sem auth — endpoint Prometheus (scrapeable internamente)
 */
export function healthRoutes(controller: HealthController): Router {
  const router = Router()

  router.get('/health/live',  (req, res, next) => void controller.live(req, res, next))
  router.get('/health/ready', (req, res, next) => void controller.ready(req, res, next))
  router.get('/metrics',      metricsHandler())

  return router
}
