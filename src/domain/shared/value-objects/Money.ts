import { Cents } from '../types'

export type Currency = 'BRL' | 'USD'

export interface MoneyProps {
  readonly amount: Cents
  readonly currency: Currency
}

export class Money {
  readonly amount: Cents
  readonly currency: Currency

  private constructor(props: MoneyProps) {
    this.amount  = props.amount
    this.currency = props.currency
  }

  static of(amount: Cents, currency: Currency = 'BRL'): Money {
    return new Money({ amount, currency })
  }

  add(other: Money): Money {
    this.assertSameCurrency(other)
    return Money.of(Cents.of(this.amount + other.amount), this.currency)
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other)
    const result = this.amount - other.amount
    return Money.of(Cents.of(result), this.currency)
  }

  // Multiplica por uma taxa (ex: 0.08 pra 8%)
  // Retorna o resultado com Math.floor e o remainder separado
  multiply(rate: number): { result: Money; remainder: Money } {
    const raw    = Math.floor(this.amount * rate)
    const result   = Money.of(Cents.of(raw), this.currency)
    const remainder = Money.of(Cents.of(this.amount - raw), this.currency)
    return { result, remainder }
  }

  equals(other: Money): boolean {
    return this.amount === other.amount && this.currency === other.currency
  }

  toDisplay(): string {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: this.currency,
    }).format(this.amount / 100)
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error(`Currency mismatch: ${this.currency} vs ${other.currency}`)
    }
  }
}