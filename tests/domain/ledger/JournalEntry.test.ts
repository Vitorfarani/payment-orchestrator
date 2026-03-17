import { JournalEntryId, PaymentId, Cents } from '../../../src/domain/shared/types'
import { JournalEntry } from '../../../src/domain/ledger/JournalEntry'
import type { JournalLine } from '../../../src/domain/ledger/JournalEntry'
import { AccountCode } from '../../../src/domain/ledger/value-objects/AccountCode'

// Helper tipado para evitar repetição — contextual typing garante literal 'DEBIT'/'CREDIT'
const line = (
  accountCode: AccountCode,
  type: JournalLine['type'],
  amount: Cents,
): JournalLine => ({ accountCode, type, amount })

// Fluxo PaymentCaptured: R$ 100,00 com split 8%
// DEBIT  1001 Receivable Gateway  10.000  ← vamos receber do gateway
// CREDIT 3001 Revenue Platform       800  ← comissão da plataforma
// CREDIT 2001 Payable Seller        9.200  ← devemos ao vendedor
const makeInput = () => ({
  id:        JournalEntryId.create(),
  paymentId: PaymentId.create(),
  lines: [
    line(AccountCode.RECEIVABLE_GATEWAY, 'DEBIT',  Cents.of(10000)),
    line(AccountCode.REVENUE_PLATFORM,   'CREDIT', Cents.of(800)),
    line(AccountCode.PAYABLE_SELLER,     'CREDIT', Cents.of(9200)),
  ],
})

describe('JournalEntry.create() — validações', () => {
  it('falha com menos de 2 linhas', () => {
    const result = JournalEntry.create({
      ...makeInput(),
      lines: [line(AccountCode.RECEIVABLE_GATEWAY, 'DEBIT', Cents.of(100))],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('mínimo 2 linhas')
  })

  it('falha se qualquer linha tiver valor zero', () => {
    const result = JournalEntry.create({
      ...makeInput(),
      lines: [
        line(AccountCode.RECEIVABLE_GATEWAY, 'DEBIT',  Cents.of(0)),
        line(AccountCode.PAYABLE_SELLER,     'CREDIT', Cents.of(0)),
      ],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('positivos')
  })

  it('falha com entrada desbalanceada (débitos ≠ créditos)', () => {
    const result = JournalEntry.create({
      ...makeInput(),
      lines: [
        line(AccountCode.RECEIVABLE_GATEWAY, 'DEBIT',  Cents.of(10000)),
        line(AccountCode.PAYABLE_SELLER,     'CREDIT', Cents.of(9000)), // falta 1000
      ],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('balanceada')
  })

  it('falha com entrada de 2 linhas onde ambas são DEBIT', () => {
    const result = JournalEntry.create({
      ...makeInput(),
      lines: [
        line(AccountCode.RECEIVABLE_GATEWAY, 'DEBIT', Cents.of(5000)),
        line(AccountCode.PAYABLE_SELLER,     'DEBIT', Cents.of(5000)),
      ],
    })
    expect(result.ok).toBe(false)
  })
})

describe('JournalEntry.create() — caminho feliz', () => {
  it('cria entrada balanceada com sucesso', () => {
    const result = JournalEntry.create(makeInput())
    expect(result.ok).toBe(true)
  })

  it('fluxo PaymentCaptured: 10.000 = 800 + 9.200 (split 8%)', () => {
    const result = JournalEntry.create(makeInput())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.lines).toHaveLength(3)
  })

  it('expõe id, paymentId, lines e createdAt corretamente', () => {
    const input  = makeInput()
    const result = JournalEntry.create(input)
    if (!result.ok) return
    const entry = result.value
    expect(entry.id).toBe(input.id)
    expect(entry.paymentId).toBe(input.paymentId)
    expect(entry.lines).toHaveLength(3)
    expect(entry.createdAt).toBeInstanceOf(Date)
  })

  it('entradas com apenas 2 linhas também são válidas', () => {
    const result = JournalEntry.create({
      ...makeInput(),
      lines: [
        line(AccountCode.PAYABLE_SELLER,         'DEBIT',  Cents.of(9200)),
        line(AccountCode.RECEIVABLE_GATEWAY,     'CREDIT', Cents.of(9200)),
      ],
    })
    expect(result.ok).toBe(true)
  })
})
