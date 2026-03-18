export class DomainError extends Error {
  readonly code: string

  constructor(message: string, code = 'DOMAIN_ERROR') {
    super(message)
    this.name = 'DomainError'
    this.code = code
  }
}

export class ValidationError extends DomainError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR')
    this.name = 'ValidationError'
  }
}

export class BusinessRuleError extends DomainError {
  constructor(message: string) {
    super(message, 'BUSINESS_RULE_ERROR')
    this.name = 'BusinessRuleError'
  }
}

export class NotFoundError extends DomainError {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`, 'NOT_FOUND')
    this.name = 'NotFoundError'
  }
}

export class ConflictError extends DomainError {
  constructor(message: string) {
    super(message, 'CONFLICT')
    this.name = 'ConflictError'
  }
}

export class GatewayError extends DomainError {
  constructor(message: string, code = 'GATEWAY_ERROR') {
    super(message, code)
    this.name = 'GatewayError'
  }
}