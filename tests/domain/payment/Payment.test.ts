import { PaymentId, SellerId, Cents, IdempotencyKey } from '../../../src/domain/shared/types'
import { Payment } from '../../../src/domain/payment/Payment'


const makeInput = () => ({
  id:             PaymentId.create(),
  sellerId:       SellerId.create(),
  amount:         Cents.of(10000),
  idempotencyKey: IdempotencyKey.of('chave-de-teste-123'),
})

const makePayment = () => Payment.create(makeInput())

// Leva o pagamento até CAPTURED pelo caminho padrão
const capturar = (p: Payment): void => {
  p.transition('PROCESSING')
  p.transition('AUTHORIZED')
  p.transition('CAPTURED')
}

describe('Payment.create()', () => {
  it('cria pagamento com status PENDING', () => {
    const result = makePayment()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.status).toBe('PENDING')
    }
  })

  it('gera um domain event PaymentCreated', () => {
    const result = makePayment()
    if (result.ok) {
      expect(result.value.domainEvents).toHaveLength(1)
      expect(result.value.domainEvents[0]?.type).toBe('PaymentCreated')
    }
  })
})

describe('Payment.create() — validações', () => {
  it('rejeita amount zero', () => {
    const result = Payment.create({ ...makeInput(), amount: Cents.of(0) })
    expect(result.ok).toBe(false)
  })
})

describe('Payment — getters', () => {
  it('expõe todos os campos via getters', () => {
    const input  = makeInput()
    const result = Payment.create(input)
    if (!result.ok) return
    const p = result.value
    expect(p.id).toBe(input.id)
    expect(p.sellerId).toBe(input.sellerId)
    expect(p.amount).toBe(10000)
    expect(p.idempotencyKey).toBe(input.idempotencyKey)
    expect(p.createdAt).toBeInstanceOf(Date)
    expect(p.updatedAt).toBeInstanceOf(Date)
  })
})

describe('Payment.transition()', () => {
  it('transição válida: PENDING → PROCESSING', () => {
    const result = makePayment()
    if (!result.ok) return
    const transition = result.value.transition('PROCESSING')
    expect(transition.ok).toBe(true)
    expect(result.value.status).toBe('PROCESSING')
  })

  it('transição inválida retorna err', () => {
    const result = makePayment()
    if (!result.ok) return
    const transition = result.value.transition('CAPTURED')
    expect(transition.ok).toBe(false)
  })

  it('não é possível sair de um estado terminal', () => {
    const result = makePayment()
    if (!result.ok) return
    result.value.transition('PROCESSING')
    result.value.transition('FAILED')
    const transition = result.value.transition('PROCESSING')
    expect(transition.ok).toBe(false)
  })

  it('transição AUTHORIZED → CAPTURED adiciona evento PaymentCaptured', () => {
    const result = makePayment()
    if (!result.ok) return
    const payment = result.value
    payment.clearEvents()
    payment.transition('PROCESSING')
    payment.transition('AUTHORIZED')
    payment.transition('CAPTURED')
    const captured = payment.domainEvents.find((e: { type: string }) => e.type === 'PaymentCaptured')
    expect(captured).toBeDefined()
  })

  it('mensagem de erro de estado terminal menciona "nenhuma"', () => {
    const result = makePayment()
    if (!result.ok) return
    result.value.transition('PROCESSING')
    result.value.transition('FAILED')
    const r = result.value.transition('PROCESSING')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toContain('nenhuma')
  })
})

describe('Payment — gateway info', () => {
  it('setGatewayInfo persiste gateway, gatewayPaymentId e gatewayResponse', () => {
    const result = makePayment()
    if (!result.ok) return
    const p = result.value
    const response = { id: 'pi_123', status: 'requires_capture' }
    p.setGatewayInfo('STRIPE', 'pi_123', response)
    expect(p.gateway).toBe('STRIPE')
    expect(p.gatewayPaymentId).toBe('pi_123')
    expect(p.gatewayResponse).toBe(response)
  })

  it('setGatewayInfo atualiza updatedAt', () => {
    const result = makePayment()
    if (!result.ok) return
    const p = result.value
    const before = p.updatedAt
    p.setGatewayInfo('ASAAS', 'pay_abc', {})
    expect(p.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
  })
})

describe('Payment — timestamps de transição', () => {
  it('authorizedAt é setado ao transicionar para AUTHORIZED', () => {
    const result = makePayment()
    if (!result.ok) return
    const p = result.value
    expect(p.authorizedAt).toBeUndefined()
    p.transition('PROCESSING')
    p.transition('AUTHORIZED')
    expect(p.authorizedAt).toBeInstanceOf(Date)
  })

  it('capturedAt é setado ao transicionar para CAPTURED', () => {
    const result = makePayment()
    if (!result.ok) return
    const p = result.value
    capturar(p)
    expect(p.capturedAt).toBeInstanceOf(Date)
  })

  it('refundedAt é setado ao transicionar para REFUNDED', () => {
    const result = makePayment()
    if (!result.ok) return
    const p = result.value
    capturar(p)
    p.transition('REFUNDED')
    expect(p.refundedAt).toBeInstanceOf(Date)
  })

  it('failedAt é setado ao transicionar para FAILED', () => {
    const result = makePayment()
    if (!result.ok) return
    const p = result.value
    p.transition('PROCESSING')
    p.transition('FAILED', { errorCode: 'card_declined', errorMessage: 'Cartão recusado' })
    expect(p.failedAt).toBeInstanceOf(Date)
    expect(p.errorCode).toBe('card_declined')
    expect(p.errorMessage).toBe('Cartão recusado')
  })
})

describe('Payment — domain events por transição', () => {
  it('PROCESSING → REQUIRES_ACTION gera PaymentRequiresAction', () => {
    const result = makePayment()
    if (!result.ok) return
    const p = result.value
    p.clearEvents()
    p.transition('PROCESSING')
    p.transition('REQUIRES_ACTION')
    expect(p.domainEvents.find((e: { type: string }) => e.type === 'PaymentRequiresAction')).toBeDefined()
  })

  it('CAPTURED → SETTLED gera PaymentSettled', () => {
    const result = makePayment()
    if (!result.ok) return
    const p = result.value
    capturar(p)
    p.clearEvents()
    p.transition('SETTLED')
    expect(p.domainEvents.find((e: { type: string }) => e.type === 'PaymentSettled')).toBeDefined()
  })

  it('CAPTURED → REFUNDED gera PaymentRefunded', () => {
    const result = makePayment()
    if (!result.ok) return
    const p = result.value
    capturar(p)
    p.clearEvents()
    p.transition('REFUNDED')
    expect(p.domainEvents.find((e: { type: string }) => e.type === 'PaymentRefunded')).toBeDefined()
  })

  it('CAPTURED → PARTIALLY_REFUNDED com refundAmount gera PaymentPartiallyRefunded', () => {
    const result = makePayment()
    if (!result.ok) return
    const p = result.value
    capturar(p)
    p.clearEvents()
    p.transition('PARTIALLY_REFUNDED', { refundAmount: 500 })
    const event = p.domainEvents.find((e: { type: string }) => e.type === 'PaymentPartiallyRefunded')
    expect(event).toBeDefined()
  })

  it('PROCESSING → FAILED com reason gera PaymentFailed com reason', () => {
    const result = makePayment()
    if (!result.ok) return
    const p = result.value
    p.transition('PROCESSING')
    p.clearEvents()
    p.transition('FAILED', { reason: 'cartão recusado' })
    const event = p.domainEvents.find((e: { type: string }) => e.type === 'PaymentFailed')
    expect(event).toBeDefined()
  })

  it('PENDING → CANCELLED gera PaymentCancelled', () => {
    const result = makePayment()
    if (!result.ok) return
    const p = result.value
    p.clearEvents()
    p.transition('CANCELLED')
    expect(p.domainEvents.find((e: { type: string }) => e.type === 'PaymentCancelled')).toBeDefined()
  })

  it('CAPTURED → DISPUTED gera PaymentDisputed', () => {
    const result = makePayment()
    if (!result.ok) return
    const p = result.value
    capturar(p)
    p.clearEvents()
    p.transition('DISPUTED')
    expect(p.domainEvents.find((e: { type: string }) => e.type === 'PaymentDisputed')).toBeDefined()
  })

  it('DISPUTED → CHARGEBACK_WON gera ChargebackWon', () => {
    const result = makePayment()
    if (!result.ok) return
    const p = result.value
    capturar(p)
    p.transition('DISPUTED')
    p.clearEvents()
    p.transition('CHARGEBACK_WON')
    expect(p.domainEvents.find((e: { type: string }) => e.type === 'ChargebackWon')).toBeDefined()
  })

  it('DISPUTED → CHARGEBACK_LOST gera ChargebackLost', () => {
    const result = makePayment()
    if (!result.ok) return
    const p = result.value
    capturar(p)
    p.transition('DISPUTED')
    p.clearEvents()
    p.transition('CHARGEBACK_LOST')
    expect(p.domainEvents.find((e: { type: string }) => e.type === 'ChargebackLost')).toBeDefined()
  })
})