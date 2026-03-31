import request from 'supertest'
import express from 'express'
import type { Express } from 'express'
import { HealthController } from '../../../src/web/controllers/HealthController'

function makeApp(controller: HealthController): Express {
  const app = express()
  app.get('/health/live',  (req, res, next) => controller.live(req, res, next))
  app.get('/health/ready', (req, res, next) => void controller.ready(req, res, next))
  return app
}

describe('HealthController', () => {
  // -------------------------------------------------------------------------
  // GET /health/live
  // -------------------------------------------------------------------------
  describe('live', () => {
    it('returns 200 with status ok', async () => {
      const controller = new HealthController({
        db:    { raw: jest.fn().mockResolvedValue({}) },
        redis: { ping: jest.fn().mockResolvedValue('PONG') },
      })
      const app = makeApp(controller)

      const res = await request(app).get('/health/live')

      expect(res.status).toBe(200)
      expect(res.body['status']).toBe('ok')
      expect(res.body['timestamp']).toBeDefined()
    })
  })

  // -------------------------------------------------------------------------
  // GET /health/ready
  // -------------------------------------------------------------------------
  describe('ready', () => {
    it('returns 200 when both postgres and redis are healthy', async () => {
      const controller = new HealthController({
        db:    { raw: jest.fn().mockResolvedValue({}) },
        redis: { ping: jest.fn().mockResolvedValue('PONG') },
      })
      const app = makeApp(controller)

      const res = await request(app).get('/health/ready')

      expect(res.status).toBe(200)
      expect(res.body['status']).toBe('ok')
      expect(res.body['checks']['postgres']).toBe('ok')
      expect(res.body['checks']['redis']).toBe('ok')
    })

    it('returns 503 when postgres is down', async () => {
      const controller = new HealthController({
        db:    { raw: jest.fn().mockRejectedValue(new Error('connection refused')) },
        redis: { ping: jest.fn().mockResolvedValue('PONG') },
      })
      const app = makeApp(controller)

      const res = await request(app).get('/health/ready')

      expect(res.status).toBe(503)
      expect(res.body['status']).toBe('error')
      expect(res.body['checks']['postgres']).toBe('error')
      expect(res.body['checks']['redis']).toBe('ok')
    })

    it('returns 503 when redis is down', async () => {
      const controller = new HealthController({
        db:    { raw: jest.fn().mockResolvedValue({}) },
        redis: { ping: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) },
      })
      const app = makeApp(controller)

      const res = await request(app).get('/health/ready')

      expect(res.status).toBe(503)
      expect(res.body['status']).toBe('error')
      expect(res.body['checks']['postgres']).toBe('ok')
      expect(res.body['checks']['redis']).toBe('error')
    })

    it('returns 503 when both postgres and redis are down', async () => {
      const controller = new HealthController({
        db:    { raw: jest.fn().mockRejectedValue(new Error('DB down')) },
        redis: { ping: jest.fn().mockRejectedValue(new Error('Redis down')) },
      })
      const app = makeApp(controller)

      const res = await request(app).get('/health/ready')

      expect(res.status).toBe(503)
      expect(res.body['status']).toBe('error')
      expect(res.body['checks']['postgres']).toBe('error')
      expect(res.body['checks']['redis']).toBe('error')
    })
  })
})
