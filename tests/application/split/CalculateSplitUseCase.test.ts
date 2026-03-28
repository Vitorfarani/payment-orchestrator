import { CalculateSplitUseCase }       from '../../../src/application/split/CalculateSplitUseCase'
import { InMemorySplitRuleRepository } from '../fakes/InMemorySplitRuleRepository'
import { SplitRule }                   from '../../../src/domain/split/SplitRule'
import { SellerId, Cents, SplitRuleId, CommissionRate } from '../../../src/domain/shared/types'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SELLER_ID = '22222222-2222-4222-8222-222222222222'
const RULE_ID   = '33333333-3333-4333-8333-333333333333'

function makeSplitRule(rate = 0.10) {
  return SplitRule.create({
    id:             SplitRuleId.of(RULE_ID),
    sellerId:       SellerId.of(SELLER_ID),
    commissionRate: CommissionRate.of(rate),
  })
}

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('CalculateSplitUseCase', () => {
  it('retorna platform e seller corretos para taxa de 10%', async () => {
    const repo    = new InMemorySplitRuleRepository()
    const useCase = new CalculateSplitUseCase(repo)
    await repo.save(makeSplitRule(0.10))

    const result = await useCase.execute({
      sellerId:    SellerId.of(SELLER_ID),
      amountCents: Cents.of(10_000),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.platformAmountCents).toBe(Cents.of(1_000))
    expect(result.value.sellerAmountCents).toBe(Cents.of(9_000))
    expect(result.value.totalCents).toBe(Cents.of(10_000))
  })

  it('platform é Math.floor, seller recebe o remainder (invariante ADR-005)', async () => {
    const repo    = new InMemorySplitRuleRepository()
    const useCase = new CalculateSplitUseCase(repo)
    await repo.save(makeSplitRule(0.10))

    const result = await useCase.execute({
      sellerId:    SellerId.of(SELLER_ID),
      amountCents: Cents.of(3_333),  // 333.3 → floor = 333
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.platformAmountCents).toBe(Cents.of(333))
    expect(result.value.sellerAmountCents).toBe(Cents.of(3_000))
    // Invariante: platform + seller === total
    expect(result.value.platformAmountCents + result.value.sellerAmountCents).toBe(Cents.of(3_333))
  })

  it('funciona com taxa de 0% (plataforma não cobra comissão)', async () => {
    const repo    = new InMemorySplitRuleRepository()
    const useCase = new CalculateSplitUseCase(repo)
    await repo.save(makeSplitRule(0))

    const result = await useCase.execute({
      sellerId:    SellerId.of(SELLER_ID),
      amountCents: Cents.of(5_000),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.platformAmountCents).toBe(Cents.of(0))
    expect(result.value.sellerAmountCents).toBe(Cents.of(5_000))
  })

  it('retorna BusinessRuleError se não há split rule ativa para o seller', async () => {
    const repo    = new InMemorySplitRuleRepository()  // vazio
    const useCase = new CalculateSplitUseCase(repo)

    const result = await useCase.execute({
      sellerId:    SellerId.of(SELLER_ID),
      amountCents: Cents.of(10_000),
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('BUSINESS_RULE_ERROR')
  })

  it('retorna BusinessRuleError para split rule inativa', async () => {
    const repo    = new InMemorySplitRuleRepository()
    const useCase = new CalculateSplitUseCase(repo)

    const inactiveRule = SplitRule.reconstitute({
      id:             SplitRuleId.of(RULE_ID),
      sellerId:       SellerId.of(SELLER_ID),
      commissionRate: CommissionRate.of(0.10),
      active:         false,
      createdAt:      new Date(),
      updatedAt:      new Date(),
    })
    await repo.save(inactiveRule)

    const result = await useCase.execute({
      sellerId:    SellerId.of(SELLER_ID),
      amountCents: Cents.of(10_000),
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('BUSINESS_RULE_ERROR')
  })
})
