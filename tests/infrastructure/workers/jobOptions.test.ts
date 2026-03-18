import {
  DEFAULT_JOB_OPTIONS,
  LEDGER_JOB_OPTIONS,
  SETTLEMENT_JOB_OPTIONS,
  defaultBackoffStrategy,
  ledgerBackoffStrategy,
  settlementBackoffStrategy,
} from '../../../src/infrastructure/workers/jobOptions'

describe('jobOptions', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  // ─── DEFAULT_JOB_OPTIONS ───────────────────────────────────────────────────

  describe('DEFAULT_JOB_OPTIONS', () => {
    it('has 5 attempts', () => {
      expect(DEFAULT_JOB_OPTIONS.attempts).toBe(5)
    })

    it('has removeOnFail false — failed jobs never auto-deleted (ADR-012)', () => {
      expect(DEFAULT_JOB_OPTIONS.removeOnFail).toBe(false)
    })

    it('keeps the last 100 completed jobs for auditing', () => {
      expect(DEFAULT_JOB_OPTIONS.removeOnComplete).toEqual({ count: 100 })
    })

    it('uses custom backoff type to enable jitter strategy', () => {
      expect(DEFAULT_JOB_OPTIONS.backoff).toMatchObject({ type: 'custom' })
    })
  })

  // ─── LEDGER_JOB_OPTIONS ───────────────────────────────────────────────────

  describe('LEDGER_JOB_OPTIONS', () => {
    it('has 8 attempts — critical worker retries more before DLQ', () => {
      expect(LEDGER_JOB_OPTIONS.attempts).toBe(8)
    })

    it('has removeOnFail false', () => {
      expect(LEDGER_JOB_OPTIONS.removeOnFail).toBe(false)
    })

    it('keeps the last 100 completed jobs', () => {
      expect(LEDGER_JOB_OPTIONS.removeOnComplete).toEqual({ count: 100 })
    })
  })

  // ─── SETTLEMENT_JOB_OPTIONS ───────────────────────────────────────────────

  describe('SETTLEMENT_JOB_OPTIONS', () => {
    it('has 3 attempts — payouts are not aggressive (ADR-012)', () => {
      expect(SETTLEMENT_JOB_OPTIONS.attempts).toBe(3)
    })

    it('has removeOnFail false', () => {
      expect(SETTLEMENT_JOB_OPTIONS.removeOnFail).toBe(false)
    })

    it('keeps the last 100 completed jobs', () => {
      expect(SETTLEMENT_JOB_OPTIONS.removeOnComplete).toEqual({ count: 100 })
    })
  })

  // ─── defaultBackoffStrategy ───────────────────────────────────────────────

  describe('defaultBackoffStrategy', () => {
    it('always returns a value between 0 and 60000ms', () => {
      for (let attempt = 1; attempt <= 10; attempt++) {
        const delay = defaultBackoffStrategy(attempt)
        expect(delay).toBeGreaterThanOrEqual(0)
        expect(delay).toBeLessThanOrEqual(60_000)
      }
    })

    it('caps at 60000ms for very high attempt counts', () => {
      const delay = defaultBackoffStrategy(30) // 2000 * 2^29 would be enormous
      expect(delay).toBeLessThanOrEqual(60_000)
    })

    it('increases with higher attempt numbers at midpoint jitter', () => {
      jest.spyOn(Math, 'random').mockReturnValue(0.5) // jitter factor = 1.0
      const delay1 = defaultBackoffStrategy(1) // 2000 * 2^0 * 1.0 = 2000
      const delay3 = defaultBackoffStrategy(3) // 2000 * 2^2 * 1.0 = 8000
      expect(delay3).toBeGreaterThan(delay1)
    })

    it('returns an integer — no fractional milliseconds', () => {
      for (let attempt = 1; attempt <= 5; attempt++) {
        expect(Number.isInteger(defaultBackoffStrategy(attempt))).toBe(true)
      }
    })
  })

  // ─── ledgerBackoffStrategy ────────────────────────────────────────────────

  describe('ledgerBackoffStrategy', () => {
    it('always returns a value between 0 and 30000ms', () => {
      for (let attempt = 1; attempt <= 10; attempt++) {
        const delay = ledgerBackoffStrategy(attempt)
        expect(delay).toBeGreaterThanOrEqual(0)
        expect(delay).toBeLessThanOrEqual(30_000)
      }
    })

    it('caps at 30000ms for very high attempt counts', () => {
      const delay = ledgerBackoffStrategy(30)
      expect(delay).toBeLessThanOrEqual(30_000)
    })

    it('has a lower base delay than defaultBackoffStrategy at attempt 1', () => {
      jest.spyOn(Math, 'random').mockReturnValue(0.5)
      const ledger  = ledgerBackoffStrategy(1)   // 1000 * 2^0 * 1.0 = 1000
      const deflt   = defaultBackoffStrategy(1)  // 2000 * 2^0 * 1.0 = 2000
      expect(ledger).toBeLessThan(deflt)
    })

    it('returns an integer', () => {
      expect(Number.isInteger(ledgerBackoffStrategy(1))).toBe(true)
    })
  })

  // ─── settlementBackoffStrategy ────────────────────────────────────────────

  describe('settlementBackoffStrategy', () => {
    it('always returns between 30000ms and 40000ms inclusive/exclusive', () => {
      for (let i = 0; i < 20; i++) {
        const delay = settlementBackoffStrategy()
        expect(delay).toBeGreaterThanOrEqual(30_000)
        expect(delay).toBeLessThan(40_000)
      }
    })

    it('returns an integer', () => {
      expect(Number.isInteger(settlementBackoffStrategy())).toBe(true)
    })
  })
})
