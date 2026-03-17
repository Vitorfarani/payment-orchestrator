import { SettlementItem } from '../../../src/domain/settlement/SettlementItem'
import { Cents, PaymentId, SellerId, SettlementItemId } from '../../../src/domain/shared/types'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const paymentId  = PaymentId.create()
const sellerId   = SellerId.create()
const amount     = Cents.of(10000)
const scheduled  = new Date('2024-03-15')

const validInput = { paymentId, sellerId, amountCents: amount, scheduledDate: scheduled }

// Helper — retorna item PENDING já criado (falha ruidosa em setup inválido)
function makePending(): SettlementItem {
  const r = SettlementItem.create(validInput)
  if (!r.ok) throw new Error(`setup failed: ${r.error.message}`)
  return r.value
}

// Helper — retorna item PROCESSING
function makeProcessing(): SettlementItem {
  const r = makePending().startProcessing()
  if (!r.ok) throw new Error(`setup failed: ${r.error.message}`)
  return r.value
}

describe('SettlementItem', () => {
  describe('create()', () => {
    it('cria com status PENDING', () => {
      const result = SettlementItem.create(validInput)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.status).toBe('PENDING')
    })

    it('cria com as propriedades informadas', () => {
      const result = SettlementItem.create(validInput)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const item = result.value
      expect(item.paymentId).toBe(paymentId)
      expect(item.sellerId).toBe(sellerId)
      expect(item.amountCents).toBe(amount)
      expect(item.scheduledDate).toBe(scheduled)
    })

    it('gera UUID válido como id', () => {
      const result = SettlementItem.create(validInput)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.id).toMatch(UUID_REGEX)
    })

    it('gera ids únicos a cada chamada', () => {
      const a = SettlementItem.create(validInput)
      const b = SettlementItem.create(validInput)
      expect(a.ok).toBe(true)
      expect(b.ok).toBe(true)
      if (!a.ok || !b.ok) return
      expect(a.value.id).not.toBe(b.value.id)
    })

    it('define createdAt e updatedAt como a data atual', () => {
      const before = new Date()
      const result = SettlementItem.create(validInput)
      const after  = new Date()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const { createdAt, updatedAt } = result.value
      expect(createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
      expect(createdAt.getTime()).toBeLessThanOrEqual(after.getTime())
      expect(updatedAt.getTime()).toBe(createdAt.getTime())
    })

    it('rejeita amount zero', () => {
      const result = SettlementItem.create({ ...validInput, amountCents: Cents.of(0) })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.code).toBe('VALIDATION_ERROR')
    })
  })

  describe('startProcessing()', () => {
    it('transiciona de PENDING para PROCESSING', () => {
      const result = makePending().startProcessing()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.status).toBe('PROCESSING')
    })

    it('retorna nova instância (imutabilidade)', () => {
      const item   = makePending()
      const result = item.startProcessing()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value).not.toBe(item)
      expect(item.status).toBe('PENDING')
    })

    it('atualiza updatedAt', () => {
      const item   = makePending()
      const before = new Date()
      const result = item.startProcessing()
      const after  = new Date()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
      expect(result.value.updatedAt.getTime()).toBeLessThanOrEqual(after.getTime())
    })

    it('retorna erro se status é PROCESSING', () => {
      const result = makeProcessing().startProcessing()
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.code).toBe('BUSINESS_RULE_ERROR')
    })

    it('retorna erro se status é COMPLETED', () => {
      const completed = makeProcessing().complete()
      if (!completed.ok) throw new Error('setup failed')
      expect(completed.value.startProcessing().ok).toBe(false)
    })

    it('retorna erro se status é FAILED', () => {
      const failed = makeProcessing().fail()
      if (!failed.ok) throw new Error('setup failed')
      expect(failed.value.startProcessing().ok).toBe(false)
    })
  })

  describe('complete()', () => {
    it('transiciona de PROCESSING para COMPLETED', () => {
      const result = makeProcessing().complete()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.status).toBe('COMPLETED')
    })

    it('retorna nova instância (imutabilidade)', () => {
      const item   = makeProcessing()
      const result = item.complete()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value).not.toBe(item)
      expect(item.status).toBe('PROCESSING')
    })

    it('retorna erro se status é PENDING', () => {
      expect(makePending().complete().ok).toBe(false)
    })

    it('retorna erro se status é COMPLETED', () => {
      const completed = makeProcessing().complete()
      if (!completed.ok) throw new Error('setup failed')
      expect(completed.value.complete().ok).toBe(false)
    })

    it('retorna erro se status é FAILED', () => {
      const failed = makeProcessing().fail()
      if (!failed.ok) throw new Error('setup failed')
      expect(failed.value.complete().ok).toBe(false)
    })
  })

  describe('fail()', () => {
    it('transiciona de PROCESSING para FAILED', () => {
      const result = makeProcessing().fail()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.status).toBe('FAILED')
    })

    it('retorna nova instância (imutabilidade)', () => {
      const item   = makeProcessing()
      const result = item.fail()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value).not.toBe(item)
      expect(item.status).toBe('PROCESSING')
    })

    it('retorna erro se status é PENDING', () => {
      expect(makePending().fail().ok).toBe(false)
    })

    it('retorna erro se status é COMPLETED', () => {
      const completed = makeProcessing().complete()
      if (!completed.ok) throw new Error('setup failed')
      expect(completed.value.fail().ok).toBe(false)
    })

    it('retorna erro se status é FAILED', () => {
      const failed = makeProcessing().fail()
      if (!failed.ok) throw new Error('setup failed')
      expect(failed.value.fail().ok).toBe(false)
    })
  })

  describe('reconstitute()', () => {
    it('restaura todas as propriedades exatamente como passadas', () => {
      const id        = SettlementItemId.create()
      const createdAt = new Date('2024-01-01T00:00:00Z')
      const updatedAt = new Date('2024-01-15T12:00:00Z')

      const item = SettlementItem.reconstitute({
        id,
        paymentId,
        sellerId,
        amountCents:   amount,
        scheduledDate: scheduled,
        status:        'COMPLETED',
        createdAt,
        updatedAt,
      })

      expect(item.id).toBe(id)
      expect(item.paymentId).toBe(paymentId)
      expect(item.sellerId).toBe(sellerId)
      expect(item.amountCents).toBe(amount)
      expect(item.scheduledDate).toBe(scheduled)
      expect(item.status).toBe('COMPLETED')
      expect(item.createdAt).toBe(createdAt)
      expect(item.updatedAt).toBe(updatedAt)
    })
  })
})
