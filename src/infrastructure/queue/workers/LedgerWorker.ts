import { UnrecoverableError } from 'bullmq'
import type { Job } from 'bullmq'
import type { Logger } from 'pino'
import type { IUnitOfWork } from '../../../application/shared/IUnitOfWork'
import type { IJournalEntryRepository } from '../../../domain/ledger/IJournalEntryRepository'
import type { JournalLine } from '../../../domain/ledger/JournalEntry'
import { JournalEntry } from '../../../domain/ledger/JournalEntry'
import { AccountCode } from '../../../domain/ledger/value-objects/AccountCode'
import { JournalEntryId, PaymentId, Cents } from '../../../domain/shared/types'

export interface LedgerWorkerOptions {
  /** Unit of Work para a escrita atômica da JournalEntry. */
  readonly uow:              IUnitOfWork
  /**
   * Repositório para a verificação de idempotência ANTES de abrir a UoW.
   * Injetado sem transação — apenas leitura (SELECT).
   */
  readonly journalEntryRepo: IJournalEntryRepository
  readonly logger:           Logger
}

/**
 * Worker que processa eventos PAYMENT_CAPTURED e PAYMENT_REFUNDED
 * e gera JournalEntries de double-entry correspondentes (ADR-010).
 *
 * Fluxo por job:
 *   1. Valida os campos obrigatórios do payload
 *   2. `existsByOutboxEventId(job.id)` — verifica idempotência ANTES de abrir UoW
 *   3. Abre UoW → cria JournalEntry com linhas de double-entry
 *   4. Persiste a entry com `sourceEventId = job.id` (idempotência futura)
 *
 * Contas movimentadas (ADR-010):
 *   PAYMENT_CAPTURED:
 *     DEBIT  1001 Receivable Gateway   (total)
 *     CREDIT 3001 Revenue Platform     (plataforma)
 *     CREDIT 2001 Payable Seller       (vendedor)
 *
 *   PAYMENT_REFUNDED (reversing entries — nunca UPDATE):
 *     DEBIT  3001 Revenue Platform     (plataforma)
 *     DEBIT  2001 Payable Seller       (vendedor)
 *     CREDIT 1001 Receivable Gateway   (total)
 *
 * Tratamento de erros:
 *   - Payload inválido ou entry desbalanceada → UnrecoverableError (DLQ imediata)
 *   - Trigger PG rejeita (23514 / P0001)     → UnrecoverableError (DLQ imediata)
 *   - Erro de infra (conexão, timeout)       → propaga para BullMQ retry
 *
 * Configurado com `ledgerBackoffStrategy` (8 tentativas, cap 30s — ADR-012).
 */
export class LedgerWorker {
  constructor(private readonly opts: LedgerWorkerOptions) {}

  async process(job: Job<Record<string, unknown>>): Promise<void> {
    // ── Validação do job.id (eventId para idempotência) ─────────────────────

    const eventId = job.id
    if (typeof eventId !== 'string') {
      this.opts.logger.error(
        { service: 'LedgerWorker', jobId: job.id },
        'Job missing ID — cannot check idempotency',
      )
      return
    }

    // ── Validação do payload ─────────────────────────────────────────────────

    const paymentIdRaw  = job.data['paymentId']
    const platformRaw   = job.data['platformAmountCents']
    const sellerRaw     = job.data['sellerAmountCents']
    const amountRaw     = job.data['amount']

    if (typeof paymentIdRaw !== 'string') {
      this.opts.logger.error(
        { service: 'LedgerWorker', eventId },
        'Invalid job data: paymentId must be a string',
      )
      return
    }

    if (typeof platformRaw !== 'number') {
      this.opts.logger.error(
        { service: 'LedgerWorker', eventId },
        'Invalid job data: platformAmountCents must be a number',
      )
      return
    }

    if (typeof sellerRaw !== 'number') {
      this.opts.logger.error(
        { service: 'LedgerWorker', eventId },
        'Invalid job data: sellerAmountCents must be a number',
      )
      return
    }

    if (typeof amountRaw !== 'number') {
      this.opts.logger.error(
        { service: 'LedgerWorker', eventId },
        'Invalid job data: amount must be a number',
      )
      return
    }

    // ── Tipo de evento ───────────────────────────────────────────────────────

    const eventType = job.name
    if (eventType !== 'PAYMENT_CAPTURED' && eventType !== 'PAYMENT_REFUNDED') {
      this.opts.logger.warn(
        { service: 'LedgerWorker', eventType, eventId },
        'Unknown event type — skipping',
      )
      return
    }

    // ── Idempotência — ANTES de abrir UoW ───────────────────────────────────

    const alreadyProcessed = await this.opts.journalEntryRepo.existsByOutboxEventId(eventId)
    if (alreadyProcessed) {
      this.opts.logger.info(
        { service: 'LedgerWorker', eventId, eventType },
        'Event already generated a JournalEntry — skipping (idempotent)',
      )
      return
    }

    // ── UoW: double-entry ────────────────────────────────────────────────────

    await this.opts.uow.run(async (repos) => {
      const lines: readonly JournalLine[] = eventType === 'PAYMENT_CAPTURED'
        ? capturedLines(amountRaw, platformRaw, sellerRaw)
        : refundedLines(amountRaw, platformRaw, sellerRaw)

      const entryResult = JournalEntry.create({
        id:            JournalEntryId.create(),
        paymentId:     PaymentId.of(paymentIdRaw),
        lines,
        description:   eventType === 'PAYMENT_CAPTURED' ? 'PaymentCaptured' : 'PaymentRefunded',
        sourceEventId: eventId,
      })

      if (!entryResult.ok) {
        // Entrada desbalanceada é bug de programação — nunca se resolve com retry
        throw new UnrecoverableError(entryResult.error.message)
      }

      try {
        await repos.journalEntries.save(entryResult.value)
      } catch (error) {
        // Rejeição do trigger de double-entry do PostgreSQL não é retriable
        if (isNonRetriableDbError(error)) {
          throw new UnrecoverableError(
            error instanceof Error ? error.message : String(error),
          )
        }
        throw error
      }

      this.opts.logger.info(
        {
          service:    'LedgerWorker',
          eventId,
          eventType,
          paymentId:  paymentIdRaw,
          totalCents: amountRaw,
        },
        'JournalEntry created',
      )
    })
  }
}

// ─── Funções de montagem das linhas contábeis ──────────────────────────────────

/**
 * PAYMENT_CAPTURED:
 *   DEBIT  1001  total
 *   CREDIT 3001  plataforma
 *   CREDIT 2001  vendedor
 */
function capturedLines(
  total:    number,
  platform: number,
  seller:   number,
): readonly JournalLine[] {
  return [
    { accountCode: AccountCode.RECEIVABLE_GATEWAY, type: 'DEBIT',  amount: Cents.of(total) },
    { accountCode: AccountCode.REVENUE_PLATFORM,   type: 'CREDIT', amount: Cents.of(platform) },
    { accountCode: AccountCode.PAYABLE_SELLER,     type: 'CREDIT', amount: Cents.of(seller) },
  ]
}

/**
 * PAYMENT_REFUNDED — reversing entries (nunca UPDATE no Ledger — ADR-010):
 *   DEBIT  3001  plataforma
 *   DEBIT  2001  vendedor
 *   CREDIT 1001  total
 */
function refundedLines(
  total:    number,
  platform: number,
  seller:   number,
): readonly JournalLine[] {
  return [
    { accountCode: AccountCode.REVENUE_PLATFORM,   type: 'DEBIT',  amount: Cents.of(platform) },
    { accountCode: AccountCode.PAYABLE_SELLER,      type: 'DEBIT',  amount: Cents.of(seller) },
    { accountCode: AccountCode.RECEIVABLE_GATEWAY, type: 'CREDIT', amount: Cents.of(total) },
  ]
}

/**
 * Detecta erros PostgreSQL que indicam violação de constraint ou trigger —
 * esses erros não serão resolvidos com retry e devem ir para DLQ.
 *
 *   23514 — check_violation (constraint CHECK falhou, incluindo o trigger de double-entry)
 *   P0001 — raise_exception (RAISE EXCEPTION em PL/pgSQL)
 */
function isNonRetriableDbError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (!hasPgCode(error)) return false
  return error.code === '23514' || error.code === 'P0001'
}

/** Type predicate: narrowing de Error para Error com campo `code` (erro PostgreSQL). */
function hasPgCode(e: Error): e is Error & { code: unknown } {
  return 'code' in e
}
