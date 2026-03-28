import { RecordRefundEntryUseCase }        from '../../../src/application/ledger/RecordRefundEntryUseCase'
import { InMemoryUnitOfWork }              from '../fakes/InMemoryUnitOfWork'
import { InMemoryJournalEntryRepository }  from '../fakes/InMemoryJournalEntryRepository'
import { PaymentId, Cents }                from '../../../src/domain/shared/types'
import { AccountCode }                     from '../../../src/domain/ledger/value-objects/AccountCode'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PAYMENT_ID   = '11111111-1111-4111-8111-111111111111'
const SOURCE_EVENT = 'outbox-event-refund-001'

function makeInput(overrides: Partial<Parameters<RecordRefundEntryUseCase['execute']>[0]> = {}) {
  return {
    paymentId:           PaymentId.of(PAYMENT_ID),
    amount:              Cents.of(10_000),
    platformAmountCents: Cents.of(1_000),
    sellerAmountCents:   Cents.of(9_000),
    sourceEventId:       SOURCE_EVENT,
    ...overrides,
  }
}

function makeSetup() {
  const journalEntryRepo = new InMemoryJournalEntryRepository()
  const uow              = new InMemoryUnitOfWork(undefined, undefined, journalEntryRepo)
  const useCase          = new RecordRefundEntryUseCase(uow, journalEntryRepo)
  return { uow, journalEntryRepo, useCase }
}

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('RecordRefundEntryUseCase', () => {
  it('cria reversing entries com as linhas corretas (business-rules §6.5)', async () => {
    const { uow, useCase } = makeSetup()

    const result = await useCase.execute(makeInput())

    expect(result.ok).toBe(true)
    expect(uow.journalEntries.count()).toBe(1)

    const entries = uow.journalEntries.all()
    expect(entries).toHaveLength(1)
    const entry = entries[0]
    expect(entry).toBeDefined()
    if (!entry) return
    expect(entry.description).toBe('PaymentRefunded')
    expect(entry.sourceEventId).toBe(SOURCE_EVENT)

    const lines      = entry.lines
    const debit3001  = lines.find(l => l.accountCode === AccountCode.REVENUE_PLATFORM  && l.type === 'DEBIT')
    const debit2001  = lines.find(l => l.accountCode === AccountCode.PAYABLE_SELLER    && l.type === 'DEBIT')
    const credit1001 = lines.find(l => l.accountCode === AccountCode.RECEIVABLE_GATEWAY && l.type === 'CREDIT')

    expect(debit3001?.amount).toBe(Cents.of(1_000))
    expect(debit2001?.amount).toBe(Cents.of(9_000))
    expect(credit1001?.amount).toBe(Cents.of(10_000))
  })

  it('double-entry balanceada: débitos === créditos', async () => {
    const { uow, useCase } = makeSetup()

    await useCase.execute(makeInput())

    const entry = uow.journalEntries.all()[0]
    expect(entry).toBeDefined()
    if (!entry) return
    const debitSum  = entry.lines.filter(l => l.type === 'DEBIT').reduce((s, l) => s + l.amount, 0)
    const creditSum = entry.lines.filter(l => l.type === 'CREDIT').reduce((s, l) => s + l.amount, 0)
    expect(debitSum).toBe(creditSum)
  })

  it('é idempotente: mesmo sourceEventId não cria segunda entrada', async () => {
    const { uow, useCase } = makeSetup()

    await useCase.execute(makeInput())
    await useCase.execute(makeInput())  // duplicata

    expect(uow.journalEntries.count()).toBe(1)
  })

  it('retorna ValidationError se os valores não balanceiam', async () => {
    const { uow, useCase } = makeSetup()

    const result = await useCase.execute(makeInput({
      amount:              Cents.of(10_000),
      platformAmountCents: Cents.of(100),
      sellerAmountCents:   Cents.of(100),  // 200 ≠ 10_000
    }))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_ERROR')
    expect(uow.journalEntries.count()).toBe(0)
  })
})
