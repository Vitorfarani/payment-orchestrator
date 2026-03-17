import { Cents, CommissionRate } from '../../../src/domain/shared/types'
import { SplitCalculator } from '../../../src/domain/split/SplitCalculator'

// ─── calculate() ─────────────────────────────────────────────────────────────

describe('SplitCalculator.calculate()', () => {
  it('caso base: R$ 100 com 8% — sem fração', () => {
    const result = SplitCalculator.calculate(Cents.of(10000), CommissionRate.of(0.08))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.platform).toBe(800)
    expect(result.value.seller).toBe(9200)
  })

  it('edge case de arredondamento: R$ 10,01 com 8% → floor para plataforma', () => {
    // 1001 × 0.08 = 80.08 → floor = 80, vendedor recebe o centavo extra
    const result = SplitCalculator.calculate(Cents.of(1001), CommissionRate.of(0.08))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.platform).toBe(80)   // floor(80.08)
    expect(result.value.seller).toBe(921)    // 1001 - 80
  })

  it('invariante platform + seller === total é sempre verdadeiro', () => {
    const cases = [
      [10000, 0.08],
      [1001,  0.08],
      [9999,  0.15],
      [1,     0.5 ],
      [1000,  0.333],
    ] as const

    for (const [total, rate] of cases) {
      const result = SplitCalculator.calculate(Cents.of(total), CommissionRate.of(rate))
      if (!result.ok) continue
      expect(result.value.platform + result.value.seller).toBe(total)
    }
  })

  it('taxa zero: tudo vai para o vendedor', () => {
    const result = SplitCalculator.calculate(Cents.of(5000), CommissionRate.of(0))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.platform).toBe(0)
    expect(result.value.seller).toBe(5000)
  })

  it('taxa 100%: tudo vai para a plataforma', () => {
    const result = SplitCalculator.calculate(Cents.of(5000), CommissionRate.of(1))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.platform).toBe(5000)
    expect(result.value.seller).toBe(0)
  })

  it('retorna erro se total for zero', () => {
    const result = SplitCalculator.calculate(Cents.of(0), CommissionRate.of(0.08))
    expect(result.ok).toBe(false)
  })

  it('expõe total e rate no resultado', () => {
    const result = SplitCalculator.calculate(Cents.of(10000), CommissionRate.of(0.08))
    if (!result.ok) return
    expect(result.value.total).toBe(10000)
    expect(result.value.rate).toBe(0.08)
  })
})

// ─── calculateMulti() ────────────────────────────────────────────────────────

describe('SplitCalculator.calculateMulti()', () => {
  it('3 partes iguais de 1000: remainder vai para o último', () => {
    // floor(1000 × 0.3333) = 333 cada → soma = 999 → último recebe +1
    const result = SplitCalculator.calculateMulti(Cents.of(1000), [
      { recipientId: 'A', rate: CommissionRate.of(0.3333) },
      { recipientId: 'B', rate: CommissionRate.of(0.3333) },
      { recipientId: 'C', rate: CommissionRate.of(0.3334) },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.parts[0]!.amount).toBe(333)
    expect(result.value.parts[1]!.amount).toBe(333)
    expect(result.value.parts[2]!.amount).toBe(334) // absorve o remainder
  })

  it('invariante: soma das partes === total sempre', () => {
    const result = SplitCalculator.calculateMulti(Cents.of(1000), [
      { recipientId: 'A', rate: CommissionRate.of(0.3333) },
      { recipientId: 'B', rate: CommissionRate.of(0.3333) },
      { recipientId: 'C', rate: CommissionRate.of(0.3334) },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const sum = result.value.parts.reduce((s, p) => s + p.amount, 0)
    expect(sum).toBe(1000)
  })

  it('2 partes: mantém recipientId correto', () => {
    const result = SplitCalculator.calculateMulti(Cents.of(10000), [
      { recipientId: 'platform', rate: CommissionRate.of(0.08) },
      { recipientId: 'seller',   rate: CommissionRate.of(0.92) },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.parts[0]!.recipientId).toBe('platform')
    expect(result.value.parts[1]!.recipientId).toBe('seller')
  })

  it('retorna erro se lista de partes estiver vazia', () => {
    const result = SplitCalculator.calculateMulti(Cents.of(10000), [])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('pelo menos uma parte')
  })

  it('retorna erro se rates somarem mais de 100%', () => {
    const result = SplitCalculator.calculateMulti(Cents.of(10000), [
      { recipientId: 'A', rate: CommissionRate.of(0.6) },
      { recipientId: 'B', rate: CommissionRate.of(0.6) }, // 1.2 > 1.0
    ])
    expect(result.ok).toBe(false)
  })
})
