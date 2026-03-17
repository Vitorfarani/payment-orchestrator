import { PaymentId, SellerId, AccountId, JournalEntryId, Cents, CommissionRate, IdempotencyKey } from '../../../src/domain/shared/types'

describe('PaymentId', () => {
  it('aceita um UUID válido', () => {
    const id = PaymentId.of('550e8400-e29b-41d4-a716-446655440000')
    expect(id).toBe('550e8400-e29b-41d4-a716-446655440000')
  })

  it('rejeita string que não é UUID', () => {
    expect(() => PaymentId.of('não-é-um-uuid')).toThrow('Invalid PaymentId format')
  })

  it('create() gera um UUID novo', () => {
    const id = PaymentId.create()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })
})

describe('Cents', () => {
  it('aceita inteiro positivo', () => {
    expect(Cents.of(1000)).toBe(1000)
  })

  it('aceita zero', () => {
    expect(Cents.of(0)).toBe(0)
  })

  it('rejeita número com decimal', () => {
    expect(() => Cents.of(10.5)).toThrow('Cents must be integer')
  })

  it('rejeita número negativo', () => {
    expect(() => Cents.of(-1)).toThrow('Cents cannot be negative')
  })
})

describe('CommissionRate', () => {
  it('aceita 0.08 (8%)', () => {
    expect(CommissionRate.of(0.08)).toBe(0.08)
  })

  it('aceita 0 e 1 (limites)', () => {
    expect(CommissionRate.of(0)).toBe(0)
    expect(CommissionRate.of(1)).toBe(1)
  })

  it('rejeita valor acima de 1', () => {
    expect(() => CommissionRate.of(1.1)).toThrow('CommissionRate must be 0..1')
  })

  it('rejeita valor negativo', () => {
    expect(() => CommissionRate.of(-0.1)).toThrow('CommissionRate must be 0..1')
  })
})

describe('SellerId', () => {
  it('of() aceita UUID válido', () => {
    expect(SellerId.of('550e8400-e29b-41d4-a716-446655440000')).toBe('550e8400-e29b-41d4-a716-446655440000')
  })

  it('of() rejeita string que não é UUID', () => {
    expect(() => SellerId.of('nao-e-uuid')).toThrow('Invalid SellerId format')
  })
})

describe('AccountId', () => {
  it('of() aceita UUID válido', () => {
    expect(AccountId.of('550e8400-e29b-41d4-a716-446655440000')).toBe('550e8400-e29b-41d4-a716-446655440000')
  })

  it('create() gera um UUID novo', () => {
    expect(AccountId.create()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })
})

describe('JournalEntryId', () => {
  it('of() aceita UUID válido', () => {
    expect(JournalEntryId.of('550e8400-e29b-41d4-a716-446655440000')).toBe('550e8400-e29b-41d4-a716-446655440000')
  })
})

describe('IdempotencyKey', () => {
  it('aceita chave com 8+ caracteres', () => {
    expect(IdempotencyKey.of('chave-valida')).toBe('chave-valida')
  })

  it('rejeita chave com menos de 8 caracteres', () => {
    expect(() => IdempotencyKey.of('curta')).toThrow('muito curta')
  })

  it('generate() retorna um UUID válido como chave', () => {
    expect(IdempotencyKey.generate()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })
})