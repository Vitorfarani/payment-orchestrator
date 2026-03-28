import { RecordDoubleEntryUseCase }        from '../../../src/application/ledger/RecordDoubleEntryUseCase'
import { InMemoryUnitOfWork }              from '../fakes/InMemoryUnitOfWork'
import { InMemoryJournalEntryRepository }  from '../fakes/InMemoryJournalEntryRepository'
import { PaymentId, Cents }                from '../../../src/domain/shared/types'
import { AccountCode }                     from '../../../src/domain/ledger/value-objects/AccountCode'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PAYMENT_ID   = '11111111-1111-4111-8111-111111111111'
const SOURCE_EVENT = 'outbox-event-uuid-001'

function makeInput(overrides: Partial<Parameters<RecordDoubleEntryUseCase['execute']>[0]> = {}) {
  return {
    paymentId:           PaymentId.of(PAYMENT_ID),
    amount:              Cents.of(10_000),
    platformAmountCents: Cents.of(1_000),
    sellerAmountCents:   Cents.of(9_000),
    sourceEventId:       SOURCE_EVENT,
    ...overrides,
  }
}

/**
 * Em produção o repo standalone e o repo transacional leem do mesmo PostgreSQL.
 * Nos testes in-memory, compartilhamos a mesma instância para simular esse comportamento:
 * a verificação de idempotência (standalone) vê o que o UoW persistiu.
 */
function makeSetup() {
  const journalEntryRepo = new InMemoryJournalEntryRepository()
  const uow              = new InMemoryUnitOfWork(undefined, undefined, journalEntryRepo)
  const useCase          = new RecordDoubleEntryUseCase(uow, journalEntryRepo)
  return { uow, journalEntryRepo, useCase }
}

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('RecordDoubleEntryUseCase', () => {
  it('cria JournalEntry balanceada com as linhas corretas (ADR-010 §7.1)', async () => {
    const { uow, useCase } = makeSetup()

    const result = await useCase.execute(makeInput())

    expect(result.ok).toBe(true)
    expect(uow.journalEntries.count()).toBe(1)

    const entries = uow.journalEntries.all()
    expect(entries).toHaveLength(1)
    const entry = entries[0]
    expect(entry).toBeDefined()
    if (!entry) return
    expect(entry.description).toBe('PaymentCaptured')
    expect(entry.sourceEventId).toBe(SOURCE_EVENT)
    expect(entry.paymentId).toBe(PaymentId.of(PAYMENT_ID))

    const lines      = entry.lines
    const debit      = lines.find(l => l.type === 'DEBIT')
    const credit3001 = lines.find(l => l.accountCode === AccountCode.REVENUE_PLATFORM)
    const credit2001 = lines.find(l => l.accountCode === AccountCode.PAYABLE_SELLER)

    expect(debit?.accountCode).toBe(AccountCode.RECEIVABLE_GATEWAY)
    expect(debit?.amount).toBe(Cents.of(10_000))
    expect(credit3001?.amount).toBe(Cents.of(1_000))
    expect(credit2001?.amount).toBe(Cents.of(9_000))
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

  it('é idempotente: segundo processamento do mesmo sourceEventId não cria nova entrada', async () => {
    const { uow, useCase } = makeSetup()

    const r1 = await useCase.execute(makeInput())
    const r2 = await useCase.execute(makeInput())  // mesmo sourceEventId

    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    expect(uow.journalEntries.count()).toBe(1)
  })

  it('a verificação de idempotência para antes de abrir o UoW', async () => {
    // Simula um segundo worker recebendo o mesmo evento: o repo standalone
    // (compartilhado com o UoW) já tem a entrada → nenhuma nova escrita ocorre.
    const { uow, journalEntryRepo, useCase } = makeSetup()
    await useCase.execute(makeInput())  // primeira vez
    expect(uow.journalEntries.count()).toBe(1)

    // Segundo use case com o MESMO repo standalone (simula "mesmo banco")
    const uow2    = new InMemoryUnitOfWork(undefined, undefined, journalEntryRepo)
    const useCase2 = new RecordDoubleEntryUseCase(uow2, journalEntryRepo)
    const result  = await useCase2.execute(makeInput())

    expect(result.ok).toBe(true)
    // uow2 não escreveu nada — parou na verificação de idempotência
    expect(uow2.journalEntries.count()).toBe(1)  // ainda só a entrada original (repo compartilhado)
    // Nenhuma entrada NOVA foi adicionada
    expect(journalEntryRepo.count()).toBe(1)
  })

  it('retorna ValidationError se os valores não balanceiam', async () => {
    const { uow, useCase } = makeSetup()

    const result = await useCase.execute(makeInput({
      amount:              Cents.of(10_000),
      platformAmountCents: Cents.of(500),
      sellerAmountCents:   Cents.of(500),  // 500 + 500 ≠ 10_000
    }))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_ERROR')
    expect(uow.journalEntries.count()).toBe(0)
  })
})
