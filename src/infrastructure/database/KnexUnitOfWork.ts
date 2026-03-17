import type { Knex } from 'knex'
import type { IUnitOfWork, ITransactionalRepositories } from '../../application/shared/IUnitOfWork'
import { PostgresPaymentRepository } from './repositories/PostgresPaymentRepository'
import { PostgresLedgerRepository } from './repositories/PostgresLedgerRepository'
import { PostgresOutboxRepository } from './repositories/PostgresOutboxRepository'
import { PostgresSettlementRepository } from './repositories/PostgresSettlementRepository'

/**
 * Implementação Knex do IUnitOfWork (ADR-009, Option B).
 *
 * `run()` abre uma transação via `db.transaction(callback)`:
 * - O callback recebe `trx` (Knex.Transaction, que extends Knex)
 * - Os 4 repositórios são construídos escopados ao `trx`
 * - Knex commita automaticamente se o callback resolve
 * - Knex faz rollback automaticamente se o callback rejeita
 *
 * Use cases dependem de IUnitOfWork (application/) — nunca deste arquivo.
 * O DEFERRABLE INITIALLY DEFERRED trigger do ledger valida no COMMIT,
 * garantindo que todas as linhas sejam inseridas antes da validação debit=credit.
 */
export class KnexUnitOfWork implements IUnitOfWork {
  constructor(private readonly db: Knex) {}

  run<T>(fn: (repos: ITransactionalRepositories) => Promise<T>): Promise<T> {
    return this.db.transaction<T>((trx) => {
      const repos: ITransactionalRepositories = {
        payments:       new PostgresPaymentRepository(trx),
        journalEntries: new PostgresLedgerRepository(trx),
        outbox:         new PostgresOutboxRepository(trx),
        settlements:    new PostgresSettlementRepository(trx),
      }
      return fn(repos)
    })
  }
}
