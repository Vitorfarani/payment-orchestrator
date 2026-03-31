import request from 'supertest'
import express from 'express'
import type { Express, Request, Response, NextFunction } from 'express'
import { LedgerController } from '../../../src/web/controllers/LedgerController'

interface FakeLedgerRow {
  sellerId:     string
  date:         Date
  accountCode:  string
  accountType:  string
  totalDebits:  number
  totalCredits: number
  entryCount:   number
}

function makeRow(sellerId: string): FakeLedgerRow {
  return {
    sellerId,
    date:         new Date('2024-01-15T00:00:00Z'),
    accountCode:  '3001',
    accountType:  'REVENUE',
    totalDebits:  0,
    totalCredits: 10000,
    entryCount:   2,
  }
}

function makeApp(controller: LedgerController): Express {
  const app = express()
  app.use(express.json())
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.locals['merchantId'] = 'test-merchant'
    next()
  })
  app.get('/ledger/summary', (req, res, next) => void controller.getSummary(req, res, next))
  // Simple error handler for tests
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: String(err) })
  })
  return app
}

describe('LedgerController', () => {
  let queryRepo: { findBySeller: jest.Mock }
  let controller: LedgerController
  let app: Express

  beforeEach(() => {
    queryRepo  = { findBySeller: jest.fn() }
    controller = new LedgerController({ ledgerQueryRepo: queryRepo as any })
    app        = makeApp(controller)
  })

  describe('getSummary (GET /ledger/summary)', () => {
    it('returns 422 when sellerId is absent', async () => {
      const res = await request(app).get('/ledger/summary')
      expect(res.status).toBe(422)
      expect(queryRepo.findBySeller).not.toHaveBeenCalled()
    })

    it('returns 422 when sellerId is not a valid UUID', async () => {
      const res = await request(app)
        .get('/ledger/summary')
        .query({ sellerId: 'not-a-uuid' })

      expect(res.status).toBe(422)
      expect(queryRepo.findBySeller).not.toHaveBeenCalled()
    })

    it('returns 422 when from is not a valid ISO datetime', async () => {
      const res = await request(app)
        .get('/ledger/summary')
        .query({ sellerId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', from: 'not-a-date' })

      expect(res.status).toBe(422)
      expect(queryRepo.findBySeller).not.toHaveBeenCalled()
    })

    it('returns 422 when to is not a valid ISO datetime', async () => {
      const res = await request(app)
        .get('/ledger/summary')
        .query({ sellerId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', to: 'invalid' })

      expect(res.status).toBe(422)
    })

    it('returns 200 with { data, count } on happy path', async () => {
      const sellerId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
      queryRepo.findBySeller.mockResolvedValue([makeRow(sellerId)])

      const res = await request(app)
        .get('/ledger/summary')
        .query({ sellerId })

      expect(res.status).toBe(200)
      expect(res.body['count']).toBe(1)
      expect(Array.isArray(res.body['data'])).toBe(true)
      expect(res.body['data']).toHaveLength(1)

      const row = res.body['data'][0] as Record<string, unknown>
      expect(row['sellerId']).toBe(sellerId)
      expect(row['accountCode']).toBe('3001')
      expect(row['accountType']).toBe('REVENUE')
      expect(row['totalDebits']).toBe(0)
      expect(row['totalCredits']).toBe(10000)
      expect(row['entryCount']).toBe(2)
      // date serialized as string
      expect(typeof row['date']).toBe('string')
    })

    it('returns 200 with empty array when no ledger entries found', async () => {
      queryRepo.findBySeller.mockResolvedValue([])

      const res = await request(app)
        .get('/ledger/summary')
        .query({ sellerId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' })

      expect(res.status).toBe(200)
      expect(res.body['data']).toEqual([])
      expect(res.body['count']).toBe(0)
    })

    it('passes from and to as Date objects to the query repo', async () => {
      const sellerId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
      const from     = '2024-01-01T00:00:00.000Z'
      const to       = '2024-01-31T23:59:59.000Z'
      queryRepo.findBySeller.mockResolvedValue([])

      await request(app)
        .get('/ledger/summary')
        .query({ sellerId, from, to })

      expect(queryRepo.findBySeller).toHaveBeenCalledTimes(1)
      const [, passedFrom, passedTo] = queryRepo.findBySeller.mock.calls[0] as [unknown, Date, Date]
      expect(passedFrom).toBeInstanceOf(Date)
      expect(passedTo).toBeInstanceOf(Date)
      expect(passedFrom.toISOString()).toBe(from)
      expect(passedTo.toISOString()).toBe(to)
    })

    it('calls repo with undefined from/to when not provided', async () => {
      queryRepo.findBySeller.mockResolvedValue([])

      await request(app)
        .get('/ledger/summary')
        .query({ sellerId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' })

      const [, from, to] = queryRepo.findBySeller.mock.calls[0] as [unknown, unknown, unknown]
      expect(from).toBeUndefined()
      expect(to).toBeUndefined()
    })
  })
})
