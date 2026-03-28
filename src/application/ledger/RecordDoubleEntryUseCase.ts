import type { IUnitOfWork } from '../shared/IUnitOfWork'
import type { IJournalEntryRepository } from '../../domain/ledger/IJournalEntryRepository'
import type { Result } from '../../domain/shared/Result'
import type { ValidationError } from '../../domain/shared/errors'
import type { PaymentId, Cents } from '../../domain/shared/types'
import { ok } from '../../domain/shared/Result'
import { JournalEntryId } from '../../domain/shared/types'
import { JournalEntry } from '../../domain/ledger/JournalEntry'
import { AccountCode } from '../../domain/ledger/value-objects/AccountCode'

export interface RecordDoubleEntryInput {
  readonly paymentId:          PaymentId
  readonly amount:             Cents  // total capturado
  readonly platformAmountCents: Cents
  readonly sellerAmountCents:   Cents
  /** ID do OutboxEvent que originou este processamento — garante idempotência. */
  readonly sourceEventId:      string
}

/**
 * Registra as entradas contábeis de dupla entrada para um pagamento capturado (ADR-010).
 *
 * Entradas geradas (business-rules §7.1):
 *   DEBIT  1001 Receivable Gateway   total
 *   CREDIT 3001 Revenue Platform     platformAmountCents
 *   CREDIT 2001 Payable Seller       sellerAmountCents
 *
 * Idempotência verificada ANTES de abrir a UoW (business-rules §8):
 *   se o sourceEventId já gerou uma JournalEntry, retorna ok sem reprocessar.
 */
export class RecordDoubleEntryUseCase {
  constructor(
    private readonly uow:              IUnitOfWork,
    /**
     * Repositório sem transação — usado apenas para a verificação de idempotência.
     * Injetado separadamente para evitar o overhead de abrir UoW desnecessariamente.
     */
    private readonly journalEntryRepo: IJournalEntryRepository,
  ) {}

  async execute(
    input: RecordDoubleEntryInput,
  ): Promise<Result<void, ValidationError>> {
    // Verificação de idempotência ANTES de abrir UoW (business-rules §8)
    const alreadyProcessed = await this.journalEntryRepo.existsByOutboxEventId(input.sourceEventId)
    if (alreadyProcessed) return ok(undefined)

    return this.uow.run(async (repos) => {
      const entryResult = JournalEntry.create({
        id:          JournalEntryId.create(),
        paymentId:   input.paymentId,
        description: 'PaymentCaptured',
        sourceEventId: input.sourceEventId,
        lines: [
          { accountCode: AccountCode.RECEIVABLE_GATEWAY, type: 'DEBIT',  amount: input.amount },
          { accountCode: AccountCode.REVENUE_PLATFORM,   type: 'CREDIT', amount: input.platformAmountCents },
          { accountCode: AccountCode.PAYABLE_SELLER,     type: 'CREDIT', amount: input.sellerAmountCents },
        ],
      })

      if (!entryResult.ok) return entryResult

      await repos.journalEntries.save(entryResult.value)
      return ok(undefined)
    })
  }
}
