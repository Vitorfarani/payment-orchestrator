import type { IPaymentRepository } from '../../domain/payment/IPaymentRepository'
import type { IJournalEntryRepository } from '../../domain/ledger/IJournalEntryRepository'
import type { IOutboxRepository } from '../../domain/outbox/IOutboxRepository'
import type { ISettlementRepository } from '../../domain/settlement/ISettlementRepository'

/**
 * Repositórios disponíveis dentro de uma transação ativa.
 *
 * Cada campo é uma instância escoped à transação corrente —
 * use cases nunca veem `trx` do Knex diretamente.
 */
export interface ITransactionalRepositories {
  readonly payments:       IPaymentRepository
  readonly journalEntries: IJournalEntryRepository
  readonly outbox:         IOutboxRepository
  readonly settlements:    ISettlementRepository
}

/**
 * Abstração de transação para use cases — IUnitOfWork Option B (ADR-009).
 *
 * `run()` abre uma transação, constrói os repositórios escopados,
 * executa o callback e commita automaticamente.
 * Em caso de erro, faz rollback e repropaga a exceção.
 *
 * Use cases dependem desta interface (application/) — nunca de Knex.
 * A implementação concreta fica em infrastructure/database/KnexUnitOfWork.ts.
 *
 * Exemplo de uso em um use case:
 * ```ts
 * await this.uow.run(async (repos) => {
 *   await repos.payments.save(payment)
 *   await repos.outbox.save(outboxEvent)
 * })
 * ```
 */
export interface IUnitOfWork {
  run<T>(fn: (repos: ITransactionalRepositories) => Promise<T>): Promise<T>
}
