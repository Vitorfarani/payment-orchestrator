import type { IUnitOfWork, ITransactionalRepositories } from '../../../src/application/shared/IUnitOfWork'
import { InMemoryPaymentRepository }      from './InMemoryPaymentRepository'
import { InMemoryOutboxRepository }       from './InMemoryOutboxRepository'
import { InMemoryJournalEntryRepository } from './InMemoryJournalEntryRepository'
import { InMemorySettlementRepository }   from './InMemorySettlementRepository'

/**
 * Implementação in-memory do IUnitOfWork para testes de unidade de use cases.
 *
 * Expõe os repos como campos públicos para que os testes possam inspecionar
 * o estado após a execução sem precisar de mocks.
 *
 * Exemplo de uso:
 * ```ts
 * const uow = new InMemoryUnitOfWork()
 * await useCase.execute(input)
 * expect(uow.payments.count()).toBe(1)
 * expect(uow.outbox.ofType('PAYMENT_CREATED')).toHaveLength(1)
 * ```
 */
export class InMemoryUnitOfWork implements IUnitOfWork {
  readonly payments:       InMemoryPaymentRepository
  readonly outbox:         InMemoryOutboxRepository
  readonly journalEntries: InMemoryJournalEntryRepository
  readonly settlements:    InMemorySettlementRepository

  constructor(
    payments?:       InMemoryPaymentRepository,
    outbox?:         InMemoryOutboxRepository,
    journalEntries?: InMemoryJournalEntryRepository,
    settlements?:    InMemorySettlementRepository,
  ) {
    this.payments       = payments       ?? new InMemoryPaymentRepository()
    this.outbox         = outbox         ?? new InMemoryOutboxRepository()
    this.journalEntries = journalEntries ?? new InMemoryJournalEntryRepository()
    this.settlements    = settlements    ?? new InMemorySettlementRepository()
  }

  async run<T>(fn: (repos: ITransactionalRepositories) => Promise<T>): Promise<T> {
    return fn({
      payments:       this.payments,
      journalEntries: this.journalEntries,
      outbox:         this.outbox,
      settlements:    this.settlements,
    })
  }
}
