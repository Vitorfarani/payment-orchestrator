import type { IUnitOfWork } from '../shared/IUnitOfWork'
import type { IJournalEntryRepository } from '../../domain/ledger/IJournalEntryRepository'
import type { Result } from '../../domain/shared/Result'
import type { ValidationError } from '../../domain/shared/errors'
import type { PaymentId, Cents } from '../../domain/shared/types'
import { ok } from '../../domain/shared/Result'
import { JournalEntryId } from '../../domain/shared/types'
import { JournalEntry } from '../../domain/ledger/JournalEntry'
import { AccountCode } from '../../domain/ledger/value-objects/AccountCode'

export interface RecordRefundEntryInput {
  readonly paymentId:          PaymentId
  readonly amount:             Cents  // total estornado
  readonly platformAmountCents: Cents
  readonly sellerAmountCents:   Cents
  /** ID do OutboxEvent que originou este processamento — garante idempotência. */
  readonly sourceEventId:      string
}

/**
 * Registra as entradas contábeis de estorno via reversing entries (ADR-010).
 *
 * Reversing entries — nunca UPDATE no ledger (business-rules §6.5):
 *   DEBIT  3001 Revenue Platform     platformAmountCents
 *   DEBIT  2001 Payable Seller       sellerAmountCents
 *   CREDIT 1001 Receivable Gateway   total
 *
 * Idempotência verificada ANTES de abrir a UoW (business-rules §8).
 */
export class RecordRefundEntryUseCase {
  constructor(
    private readonly uow:              IUnitOfWork,
    private readonly journalEntryRepo: IJournalEntryRepository,
  ) {}

  async execute(
    input: RecordRefundEntryInput,
  ): Promise<Result<void, ValidationError>> {
    const alreadyProcessed = await this.journalEntryRepo.existsByOutboxEventId(input.sourceEventId)
    if (alreadyProcessed) return ok(undefined)

    return this.uow.run(async (repos) => {
      const entryResult = JournalEntry.create({
        id:          JournalEntryId.create(),
        paymentId:   input.paymentId,
        description: 'PaymentRefunded',
        sourceEventId: input.sourceEventId,
        lines: [
          { accountCode: AccountCode.REVENUE_PLATFORM,   type: 'DEBIT',  amount: input.platformAmountCents },
          { accountCode: AccountCode.PAYABLE_SELLER,     type: 'DEBIT',  amount: input.sellerAmountCents },
          { accountCode: AccountCode.RECEIVABLE_GATEWAY, type: 'CREDIT', amount: input.amount },
        ],
      })

      if (!entryResult.ok) return entryResult

      await repos.journalEntries.save(entryResult.value)
      return ok(undefined)
    })
  }
}
