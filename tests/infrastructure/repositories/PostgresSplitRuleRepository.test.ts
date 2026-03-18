import type { Knex } from 'knex'
import { SplitRule } from '../../../src/domain/split/SplitRule'
import { PostgresSplitRuleRepository } from '../../../src/infrastructure/database/repositories/PostgresSplitRuleRepository'
import { SplitRuleId, SellerId, CommissionRate } from '../../../src/domain/shared/types'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const RULE_ID   = '11111111-1111-4111-8111-111111111111'
const SELLER_ID = '22222222-2222-4222-8222-222222222222'
const RATE      = CommissionRate.of(0.15)

interface MockSplitRuleRow {
  id:              string
  seller_id:       string
  commission_rate: string   // pg retorna DECIMAL como string
  active:          boolean
  created_at:      Date
  updated_at:      Date
}

function makeRow(overrides: Partial<MockSplitRuleRow> = {}): MockSplitRuleRow {
  return {
    id:              RULE_ID,
    seller_id:       SELLER_ID,
    commission_rate: '0.1500',
    active:          true,
    created_at:      new Date('2024-01-01T00:00:00.000Z'),
    updated_at:      new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  }
}

// Mock do query builder do Knex com suporte a encadeamento
interface MockQb {
  insert: jest.Mock
  select: jest.Mock
  where:  jest.Mock
  first:  jest.Mock
}

function makeQb(firstResult: MockSplitRuleRow | undefined = undefined): MockQb {
  const qb = {
    insert: jest.fn().mockResolvedValue(undefined),
    select: jest.fn(),
    where:  jest.fn(),
    first:  jest.fn().mockResolvedValue(firstResult),
  }
  qb.select.mockReturnValue(qb)
  qb.where.mockReturnValue(qb)
  return qb
}

function makeDb(firstResult: MockSplitRuleRow | undefined = undefined): { db: Knex; qb: MockQb } {
  const qb = makeQb(firstResult)
  const db = jest.fn().mockReturnValue(qb) as unknown as Knex
  return { db, qb }
}

function makeRule(): SplitRule {
  return SplitRule.create({
    id:             SplitRuleId.of(RULE_ID),
    sellerId:       SellerId.of(SELLER_ID),
    commissionRate: RATE,
  })
}

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('PostgresSplitRuleRepository', () => {
  afterEach(() => jest.clearAllMocks())

  describe('save()', () => {
    it('insere na tabela split_rules com os campos corretos', async () => {
      const { db, qb } = makeDb()
      const repo = new PostgresSplitRuleRepository(db)
      const rule = makeRule()

      await repo.save(rule)

      expect(qb.insert).toHaveBeenCalledWith(expect.objectContaining({
        id:              RULE_ID,
        seller_id:       SELLER_ID,
        commission_rate: RATE,
        active:          true,
      }))
    })

    it('inclui created_at e updated_at no insert', async () => {
      const { db, qb } = makeDb()
      const repo = new PostgresSplitRuleRepository(db)
      const rule = makeRule()

      await repo.save(rule)

      const inserted = qb.insert.mock.calls[0]?.[0] as Record<string, unknown>
      expect(inserted).toHaveProperty('created_at')
      expect(inserted).toHaveProperty('updated_at')
    })
  })

  describe('findById()', () => {
    it('retorna SplitRule quando o id existe', async () => {
      const { db } = makeDb(makeRow())
      const repo   = new PostgresSplitRuleRepository(db)

      const result = await repo.findById(SplitRuleId.of(RULE_ID))

      expect(result).not.toBeNull()
      expect(result?.id).toBe(RULE_ID)
      expect(result?.sellerId).toBe(SELLER_ID)
    })

    it('retorna null quando o id não existe', async () => {
      const { db } = makeDb(undefined)
      const repo   = new PostgresSplitRuleRepository(db)

      const result = await repo.findById(SplitRuleId.of(RULE_ID))

      expect(result).toBeNull()
    })

    it('converte commission_rate de string para number ao reconstituir', async () => {
      const { db } = makeDb(makeRow({ commission_rate: '0.1500' }))
      const repo   = new PostgresSplitRuleRepository(db)

      const result = await repo.findById(SplitRuleId.of(RULE_ID))

      expect(result?.commissionRate).toBe(0.15)
    })

    it('preserva o campo active ao reconstituir', async () => {
      const { db } = makeDb(makeRow({ active: false }))
      const repo   = new PostgresSplitRuleRepository(db)

      const result = await repo.findById(SplitRuleId.of(RULE_ID))

      expect(result?.active).toBe(false)
    })

    it('filtra por id no where', async () => {
      const { db, qb } = makeDb(makeRow())
      const repo        = new PostgresSplitRuleRepository(db)
      const id          = SplitRuleId.of(RULE_ID)

      await repo.findById(id)

      expect(qb.where).toHaveBeenCalledWith('id', id)
    })
  })

  describe('findActiveBySellerId()', () => {
    it('retorna SplitRule quando seller tem regra ativa', async () => {
      const { db } = makeDb(makeRow({ active: true }))
      const repo   = new PostgresSplitRuleRepository(db)

      const result = await repo.findActiveBySellerId(SellerId.of(SELLER_ID))

      expect(result).not.toBeNull()
      expect(result?.active).toBe(true)
      expect(result?.sellerId).toBe(SELLER_ID)
    })

    it('retorna null quando seller não tem regra ativa', async () => {
      const { db } = makeDb(undefined)
      const repo   = new PostgresSplitRuleRepository(db)

      const result = await repo.findActiveBySellerId(SellerId.of(SELLER_ID))

      expect(result).toBeNull()
    })

    it('filtra por seller_id e active: true no where', async () => {
      const { db, qb } = makeDb(makeRow())
      const repo        = new PostgresSplitRuleRepository(db)
      const sellerId    = SellerId.of(SELLER_ID)

      await repo.findActiveBySellerId(sellerId)

      expect(qb.where).toHaveBeenCalledWith({ seller_id: sellerId, active: true })
    })

    it('converte commission_rate de string para number', async () => {
      const { db } = makeDb(makeRow({ commission_rate: '0.0800' }))
      const repo   = new PostgresSplitRuleRepository(db)

      const result = await repo.findActiveBySellerId(SellerId.of(SELLER_ID))

      expect(result?.commissionRate).toBe(0.08)
    })
  })
})
