import { Money } from '../../../../src/domain/shared/value-objects/Money'
import { Cents } from '../../../../src/domain/shared/types'

describe('Money', () => {
  describe('of()', () => {
    it('cria Money com valor e moeda', () => {
      const money = Money.of(Cents.of(1000), 'BRL')
      expect(money.amount).toBe(1000)
      expect(money.currency).toBe('BRL')
    })

    it('usa BRL como moeda padrão', () => {
      const money = Money.of(Cents.of(1000))
      expect(money.currency).toBe('BRL')
    })
  })

  describe('add()', () => {
    it('soma dois valores da mesma moeda', () => {
      const a = Money.of(Cents.of(1000), 'BRL')
      const b = Money.of(Cents.of(500), 'BRL')
      expect(a.add(b).amount).toBe(1500)
    })

    it('lança erro ao somar moedas diferentes', () => {
      const brl = Money.of(Cents.of(1000), 'BRL')
      const usd = Money.of(Cents.of(1000), 'USD')
      expect(() => brl.add(usd)).toThrow('Currency mismatch')
    })
  })

  describe('subtract()', () => {
    it('subtrai dois valores da mesma moeda', () => {
      const a = Money.of(Cents.of(1000), 'BRL')
      const b = Money.of(Cents.of(300), 'BRL')
      expect(a.subtract(b).amount).toBe(700)
    })
  })

  describe('multiply()', () => {
    it('aplica taxa com Math.floor para o resultado', () => {
      const money = Money.of(Cents.of(1001), 'BRL')
      const { result, remainder } = money.multiply(0.08)
      expect(result.amount).toBe(80)
      expect(remainder.amount).toBe(921)
    })

    it('resultado + remainder sempre iguala o total original', () => {
      const money = Money.of(Cents.of(1001), 'BRL')
      const { result, remainder } = money.multiply(0.08)
      expect(result.amount + remainder.amount).toBe(1001)
    })
  })

  describe('equals()', () => {
    it('retorna true para mesmo valor e moeda', () => {
      const a = Money.of(Cents.of(1000), 'BRL')
      const b = Money.of(Cents.of(1000), 'BRL')
      expect(a.equals(b)).toBe(true)
    })

    it('retorna false para valores diferentes', () => {
      const a = Money.of(Cents.of(1000), 'BRL')
      const b = Money.of(Cents.of(999), 'BRL')
      expect(a.equals(b)).toBe(false)
    })
  })

  describe('toDisplay()', () => {
    it('formata em reais', () => {
      const money = Money.of(Cents.of(10010), 'BRL')
      expect(money.toDisplay()).toContain('100,10')
    })
  })
})