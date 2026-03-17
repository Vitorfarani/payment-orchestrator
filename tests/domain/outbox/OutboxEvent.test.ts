import { OutboxEvent } from '../../../src/domain/outbox/OutboxEvent'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const validInput = {
  eventType:     'payment.captured',
  aggregateId:   'pay-123',
  aggregateType: 'Payment',
  payload:       { paymentId: 'pay-123', amountCents: 10000 },
} as const

describe('OutboxEvent', () => {
  describe('create()', () => {
    it('cria com as propriedades informadas', () => {
      const event = OutboxEvent.create(validInput)

      expect(event.eventType).toBe('payment.captured')
      expect(event.aggregateId).toBe('pay-123')
      expect(event.aggregateType).toBe('Payment')
      expect(event.payload).toEqual({ paymentId: 'pay-123', amountCents: 10000 })
    })

    it('inicia como não processado', () => {
      const event = OutboxEvent.create(validInput)
      expect(event.processed).toBe(false)
    })

    it('inicia com retryCount zero', () => {
      const event = OutboxEvent.create(validInput)
      expect(event.retryCount).toBe(0)
    })

    it('gera um UUID válido como id', () => {
      const event = OutboxEvent.create(validInput)
      expect(event.id).toMatch(UUID_REGEX)
    })

    it('gera ids únicos a cada chamada', () => {
      const a = OutboxEvent.create(validInput)
      const b = OutboxEvent.create(validInput)
      expect(a.id).not.toBe(b.id)
    })

    it('define createdAt como a data atual', () => {
      const before = new Date()
      const event  = OutboxEvent.create(validInput)
      const after  = new Date()

      expect(event.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
      expect(event.createdAt.getTime()).toBeLessThanOrEqual(after.getTime())
    })

    it('processedAt e error são undefined na criação', () => {
      const event = OutboxEvent.create(validInput)
      expect(event.processedAt).toBeUndefined()
      expect(event.error).toBeUndefined()
    })
  })

  describe('reconstitute()', () => {
    it('restaura todas as propriedades obrigatórias exatamente como passadas', () => {
      const createdAt = new Date('2024-01-15T09:00:00Z')
      const event = OutboxEvent.reconstitute({
        id:            'abc-123',
        eventType:     'payment.captured',
        aggregateId:   'pay-456',
        aggregateType: 'Payment',
        payload:       { paymentId: 'pay-456' },
        processed:     true,
        retryCount:    2,
        createdAt,
      })

      expect(event.id).toBe('abc-123')
      expect(event.eventType).toBe('payment.captured')
      expect(event.aggregateId).toBe('pay-456')
      expect(event.aggregateType).toBe('Payment')
      expect(event.payload).toEqual({ paymentId: 'pay-456' })
      expect(event.processed).toBe(true)
      expect(event.retryCount).toBe(2)
      expect(event.createdAt).toBe(createdAt)
    })

    it('restaura processedAt quando fornecido', () => {
      const processedAt = new Date('2024-01-15T10:00:00Z')
      const event = OutboxEvent.reconstitute({
        id:            'abc-456',
        eventType:     'payment.captured',
        aggregateId:   'pay-789',
        aggregateType: 'Payment',
        payload:       {},
        processed:     true,
        retryCount:    0,
        createdAt:     new Date(),
        processedAt,
      })

      expect(event.processedAt).toBe(processedAt)
    })

    it('restaura error quando fornecido', () => {
      const event = OutboxEvent.reconstitute({
        id:            'err-123',
        eventType:     'payment.failed',
        aggregateId:   'pay-999',
        aggregateType: 'Payment',
        payload:       {},
        processed:     false,
        retryCount:    3,
        createdAt:     new Date(),
        error:         'Connection timeout',
      })

      expect(event.error).toBe('Connection timeout')
      expect(event.retryCount).toBe(3)
    })

    it('reconstitui com processedAt e error ausentes', () => {
      const event = OutboxEvent.reconstitute({
        id:            'min-123',
        eventType:     'payment.created',
        aggregateId:   'pay-000',
        aggregateType: 'Payment',
        payload:       {},
        processed:     false,
        retryCount:    0,
        createdAt:     new Date(),
      })

      expect(event.processedAt).toBeUndefined()
      expect(event.error).toBeUndefined()
    })
  })
})
