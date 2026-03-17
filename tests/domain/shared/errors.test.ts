import { DomainError, ValidationError, BusinessRuleError, NotFoundError, ConflictError } from '../../../src/domain/shared/errors'
describe('DomainError', () => {
  it('tem code padrão DOMAIN_ERROR', () => {
    const error = new DomainError('algo errado')
    expect(error.code).toBe('DOMAIN_ERROR')
    expect(error.message).toBe('algo errado')
  })
})

describe('ValidationError', () => {
  it('tem code VALIDATION_ERROR', () => {
    const error = new ValidationError('campo inválido')
    expect(error.code).toBe('VALIDATION_ERROR')
  })

  it('é instância de DomainError', () => {
    expect(new ValidationError('x')).toBeInstanceOf(DomainError)
  })
})

describe('BusinessRuleError', () => {
  it('tem code BUSINESS_RULE_ERROR', () => {
    const error = new BusinessRuleError('regra violada')
    expect(error.code).toBe('BUSINESS_RULE_ERROR')
  })
})

describe('NotFoundError', () => {
  it('tem code NOT_FOUND e mensagem com resource e id', () => {
    const error = new NotFoundError('Payment', 'abc-123')
    expect(error.code).toBe('NOT_FOUND')
    expect(error.message).toBe('Payment not found: abc-123')
  })
})

describe('ConflictError', () => {
  it('tem code CONFLICT', () => {
    const error = new ConflictError('já existe')
    expect(error.code).toBe('CONFLICT')
  })
})