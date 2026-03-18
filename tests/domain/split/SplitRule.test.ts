import { SplitRule } from '../../../src/domain/split/SplitRule'
import { SplitRuleId, SellerId, CommissionRate } from '../../../src/domain/shared/types'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const RULE_ID   = SplitRuleId.create()
const SELLER_ID = SellerId.create()
const RATE_10   = CommissionRate.of(0.10)
const RATE_0    = CommissionRate.of(0)
const RATE_100  = CommissionRate.of(1)

function makeInput(overrides: Partial<Parameters<typeof SplitRule.create>[0]> = {}) {
  return {
    id:             RULE_ID,
    sellerId:       SELLER_ID,
    commissionRate: RATE_10,
    ...overrides,
  }
}

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('SplitRule.create()', () => {
  it('cria regra com os campos informados', () => {
    const rule = SplitRule.create(makeInput())

    expect(rule.id).toBe(RULE_ID)
    expect(rule.sellerId).toBe(SELLER_ID)
    expect(rule.commissionRate).toBe(RATE_10)
  })

  it('active é true por padrão', () => {
    const rule = SplitRule.create(makeInput())

    expect(rule.active).toBe(true)
  })

  it('aceita active: false explícito', () => {
    const rule = SplitRule.create(makeInput({ active: false }))

    expect(rule.active).toBe(false)
  })

  it('gera createdAt e updatedAt na criação', () => {
    const before = new Date()
    const rule   = SplitRule.create(makeInput())
    const after  = new Date()

    expect(rule.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
    expect(rule.createdAt.getTime()).toBeLessThanOrEqual(after.getTime())
    expect(rule.updatedAt.getTime()).toBe(rule.createdAt.getTime())
  })

  it('aceita commission_rate zero (plataforma não cobra comissão)', () => {
    const rule = SplitRule.create(makeInput({ commissionRate: RATE_0 }))

    expect(rule.commissionRate).toBe(RATE_0)
  })

  it('aceita commission_rate 100% (plataforma retém tudo)', () => {
    const rule = SplitRule.create(makeInput({ commissionRate: RATE_100 }))

    expect(rule.commissionRate).toBe(RATE_100)
  })
})

describe('SplitRule.reconstitute()', () => {
  it('rehidrata todos os campos sem gerar timestamps novos', () => {
    const createdAt = new Date('2024-01-01T00:00:00.000Z')
    const updatedAt = new Date('2024-06-01T12:00:00.000Z')

    const rule = SplitRule.reconstitute({
      id:             RULE_ID,
      sellerId:       SELLER_ID,
      commissionRate: RATE_10,
      active:         false,
      createdAt,
      updatedAt,
    })

    expect(rule.id).toBe(RULE_ID)
    expect(rule.sellerId).toBe(SELLER_ID)
    expect(rule.commissionRate).toBe(RATE_10)
    expect(rule.active).toBe(false)
    expect(rule.createdAt).toBe(createdAt)
    expect(rule.updatedAt).toBe(updatedAt)
  })

  it('não altera os timestamps ao reconstituir', () => {
    const createdAt = new Date('2024-01-01T00:00:00.000Z')

    const rule = SplitRule.reconstitute({
      id:             RULE_ID,
      sellerId:       SELLER_ID,
      commissionRate: RATE_10,
      active:         true,
      createdAt,
      updatedAt:      createdAt,
    })

    expect(rule.createdAt).toStrictEqual(new Date('2024-01-01T00:00:00.000Z'))
  })
})
