import { UnrecoverableError } from 'bullmq'
import type { Job } from 'bullmq'
import type { Logger } from 'pino'
import type { IUnitOfWork, ITransactionalRepositories } from '../../../src/application/shared/IUnitOfWork'
import type { IJournalEntryRepository } from '../../../src/domain/ledger/IJournalEntryRepository'
import type { IOutboxRepository } from '../../../src/domain/outbox/IOutboxRepository'
import type { IPaymentRepository } from '../../../src/domain/payment/IPaymentRepository'
import type { ISettlementRepository } from '../../../src/domain/settlement/ISettlementRepository'
import { AccountCode } from '../../../src/domain/ledger/value-objects/AccountCode'
import { LedgerWorker } from '../../../src/infrastructure/queue/workers/LedgerWorker'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PAYMENT_ID = '33333333-3333-4333-8333-333333333333'
const SELLER_ID  = '44444444-4444-4444-8444-444444444444'
const EVENT_ID   = '55555555-5555-4555-8555-555555555555'

function makeJob(
  name: string,
  data: Record<string, unknown>,
  id: string | undefined = EVENT_ID,
): Job<Record<string, unknown>> {
  return { id, name, data } as unknown as Job<Record<string, unknown>>
}

function makeCapturedJob(overrides: Record<string, unknown> = {}): Job<Record<string, unknown>> {
  return makeJob('PAYMENT_CAPTURED', {
    paymentId:           PAYMENT_ID,
    sellerId:            SELLER_ID,
    amount:              10_000,
    platformAmountCents: 800,
    sellerAmountCents:   9_200,
    ...overrides,
  })
}

function makeRefundedJob(overrides: Record<string, unknown> = {}): Job<Record<string, unknown>> {
  return makeJob('PAYMENT_REFUNDED', {
    paymentId:           PAYMENT_ID,
    sellerId:            SELLER_ID,
    amount:              10_000,
    platformAmountCents: 800,
    sellerAmountCents:   9_200,
    ...overrides,
  })
}

function makeJournalEntryRepo(exists = false): jest.Mocked<IJournalEntryRepository> {
  return {
    save:                  jest.fn().mockResolvedValue(undefined),
    findById:              jest.fn(),
    findByPaymentId:       jest.fn(),
    existsByOutboxEventId: jest.fn().mockResolvedValue(exists),
  }
}

function makeRepos(journalRepo: jest.Mocked<IJournalEntryRepository>): jest.Mocked<ITransactionalRepositories> {
  return {
    payments: {
      save:                  jest.fn(),
      update:                jest.fn(),
      findById:              jest.fn(),
      findByIdForUpdate:     jest.fn(),
      findByIdempotencyKey:    jest.fn(),
      findBySellerAndStatus:   jest.fn(),
      findStuckInProcessing:   jest.fn(),
    } as jest.Mocked<IPaymentRepository>,
    journalEntries: journalRepo,
    outbox: {
      save:                 jest.fn().mockResolvedValue(undefined),
      findUnprocessedBatch: jest.fn(),
      markProcessed:        jest.fn(),
      recordFailure:        jest.fn(),
    } as jest.Mocked<IOutboxRepository>,
    settlements: {
      save:                  jest.fn(),
      update:                jest.fn(),
      findById:              jest.fn(),
      findByPaymentId:       jest.fn(),
      findDueItems:          jest.fn(),
      findByIdForUpdate:     jest.fn(),
      findBySellerAndStatus: jest.fn(),
    } as jest.Mocked<ISettlementRepository>,
  }
}

function makeUow(repos: jest.Mocked<ITransactionalRepositories>): jest.Mocked<IUnitOfWork> {
  return {
    run: jest.fn().mockImplementation(
      (fn: (r: ITransactionalRepositories) => Promise<unknown>) => fn(repos),
    ),
  }
}

function makeLogger(): Logger {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as Logger
}

interface WorkerFixture {
  worker:  LedgerWorker
  repos:   jest.Mocked<ITransactionalRepositories>
  jeRepo:  jest.Mocked<IJournalEntryRepository>
  uow:     jest.Mocked<IUnitOfWork>
}

function makeWorker(
  jeRepo?: jest.Mocked<IJournalEntryRepository>,
  uow?: jest.Mocked<IUnitOfWork>,
): WorkerFixture {
  const je     = jeRepo ?? makeJournalEntryRepo()
  const repos  = makeRepos(je)
  const u      = uow ?? makeUow(repos)
  return {
    worker: new LedgerWorker({ uow: u, journalEntryRepo: je, logger: makeLogger() }),
    repos,
    jeRepo: je,
    uow:    u,
  }
}

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('LedgerWorker', () => {
  afterEach(() => jest.clearAllMocks())

  // ── Validação do job ────────────────────────────────────────────────────────

  describe('validação do job', () => {
    it('retorna silencioso quando job.id está ausente', async () => {
      const { worker, jeRepo } = makeWorker()
      await worker.process(makeJob('PAYMENT_CAPTURED', { paymentId: PAYMENT_ID }, undefined))
      expect(jeRepo.existsByOutboxEventId).not.toHaveBeenCalled()
    })

    it('retorna silencioso quando paymentId está ausente no payload', async () => {
      const { worker, jeRepo } = makeWorker()
      await worker.process(makeCapturedJob({ paymentId: undefined }))
      expect(jeRepo.existsByOutboxEventId).not.toHaveBeenCalled()
    })

    it('retorna silencioso quando platformAmountCents está ausente', async () => {
      const { worker, repos } = makeWorker()
      await worker.process(makeCapturedJob({ platformAmountCents: undefined }))
      expect(repos.journalEntries.save).not.toHaveBeenCalled()
    })

    it('retorna silencioso quando sellerAmountCents está ausente', async () => {
      const { worker, repos } = makeWorker()
      await worker.process(makeCapturedJob({ sellerAmountCents: undefined }))
      expect(repos.journalEntries.save).not.toHaveBeenCalled()
    })
  })

  // ── Idempotência ────────────────────────────────────────────────────────────

  describe('idempotência', () => {
    it('retorna silencioso quando o outbox event já gerou JournalEntry', async () => {
      const jeRepo = makeJournalEntryRepo(true)
      const { worker, repos } = makeWorker(jeRepo)

      await worker.process(makeCapturedJob())

      expect(repos.journalEntries.save).not.toHaveBeenCalled()
    })

    it('não abre UoW quando o evento já foi processado', async () => {
      const jeRepo = makeJournalEntryRepo(true)
      const repos  = makeRepos(jeRepo)
      const uow    = makeUow(repos)
      const { worker } = makeWorker(jeRepo, uow)

      await worker.process(makeCapturedJob())

      expect(uow.run).not.toHaveBeenCalled()
    })

    it('verifica idempotência usando o job.id como eventId', async () => {
      const jeRepo = makeJournalEntryRepo(false)
      const { worker } = makeWorker(jeRepo)

      await worker.process(makeCapturedJob())

      expect(jeRepo.existsByOutboxEventId).toHaveBeenCalledWith(EVENT_ID)
    })
  })

  // ── PAYMENT_CAPTURED ────────────────────────────────────────────────────────

  describe('PAYMENT_CAPTURED', () => {
    it('cria JournalEntry com débito em 1001 e créditos em 3001 e 2001', async () => {
      const { worker, repos } = makeWorker()

      await worker.process(makeCapturedJob())

      const savedEntry = jest.mocked(repos.journalEntries.save).mock.calls[0]?.[0]
      expect(savedEntry).toBeDefined()
      expect(savedEntry?.lines).toHaveLength(3)

      const debit   = savedEntry?.lines.find(l => l.type === 'DEBIT')
      const credits = savedEntry?.lines.filter(l => l.type === 'CREDIT')

      expect(debit?.accountCode).toBe(AccountCode.RECEIVABLE_GATEWAY)
      expect(debit?.amount).toBe(10_000)
      expect(credits).toHaveLength(2)
      expect(credits?.map(c => c.accountCode)).toContain(AccountCode.REVENUE_PLATFORM)
      expect(credits?.map(c => c.accountCode)).toContain(AccountCode.PAYABLE_SELLER)
    })

    it('os créditos somam exatamente o débito total (double-entry balanceado)', async () => {
      const { worker, repos } = makeWorker()

      await worker.process(makeCapturedJob())

      const savedEntry  = jest.mocked(repos.journalEntries.save).mock.calls[0]?.[0]
      const debitTotal  = savedEntry?.lines.filter(l => l.type === 'DEBIT').reduce((s, l) => s + l.amount, 0) ?? 0
      const creditTotal = savedEntry?.lines.filter(l => l.type === 'CREDIT').reduce((s, l) => s + l.amount, 0) ?? 0

      expect(debitTotal).toBe(creditTotal)
    })

    it('salva sourceEventId igual ao job.id para garantir idempotência futura', async () => {
      const { worker, repos } = makeWorker()

      await worker.process(makeCapturedJob())

      const savedEntry = jest.mocked(repos.journalEntries.save).mock.calls[0]?.[0]
      expect(savedEntry?.sourceEventId).toBe(EVENT_ID)
    })
  })

  // ── PAYMENT_REFUNDED (reversing entries) ────────────────────────────────────

  describe('PAYMENT_REFUNDED (reversing entries)', () => {
    it('cria JournalEntry com débitos em 3001 e 2001 e crédito em 1001', async () => {
      const { worker, repos } = makeWorker()

      await worker.process(makeRefundedJob())

      const savedEntry = jest.mocked(repos.journalEntries.save).mock.calls[0]?.[0]
      expect(savedEntry?.lines).toHaveLength(3)

      const credit = savedEntry?.lines.find(l => l.type === 'CREDIT')
      const debits = savedEntry?.lines.filter(l => l.type === 'DEBIT')

      expect(credit?.accountCode).toBe(AccountCode.RECEIVABLE_GATEWAY)
      expect(credit?.amount).toBe(10_000)
      expect(debits).toHaveLength(2)
      expect(debits?.map(d => d.accountCode)).toContain(AccountCode.REVENUE_PLATFORM)
      expect(debits?.map(d => d.accountCode)).toContain(AccountCode.PAYABLE_SELLER)
    })

    it('reversing entry é balanceada (débitos = créditos)', async () => {
      const { worker, repos } = makeWorker()

      await worker.process(makeRefundedJob())

      const savedEntry  = jest.mocked(repos.journalEntries.save).mock.calls[0]?.[0]
      const debitTotal  = savedEntry?.lines.filter(l => l.type === 'DEBIT').reduce((s, l) => s + l.amount, 0) ?? 0
      const creditTotal = savedEntry?.lines.filter(l => l.type === 'CREDIT').reduce((s, l) => s + l.amount, 0) ?? 0

      expect(debitTotal).toBe(creditTotal)
    })
  })

  // ── Erros não-retriable (UnrecoverableError) ────────────────────────────────

  describe('erros não-retriable', () => {
    it('lança UnrecoverableError quando plataforma + vendedor ≠ total (entry desbalanceada)', async () => {
      const { worker } = makeWorker()
      // 800 + 8_000 = 8_800 ≠ 10_000 → JournalEntry.create falha
      const job = makeCapturedJob({ amount: 10_000, platformAmountCents: 800, sellerAmountCents: 8_000 })

      await expect(worker.process(job)).rejects.toBeInstanceOf(UnrecoverableError)
    })

    it('lança UnrecoverableError quando o banco rejeita com check_violation (code 23514)', async () => {
      const jeRepo   = makeJournalEntryRepo(false)
      const dbError  = Object.assign(new Error('check_violation'), { code: '23514' })
      jeRepo.save.mockRejectedValue(dbError)
      const { worker } = makeWorker(jeRepo)

      await expect(worker.process(makeCapturedJob())).rejects.toBeInstanceOf(UnrecoverableError)
    })

    it('lança UnrecoverableError quando o trigger PL/pgSQL rejeita (code P0001)', async () => {
      const jeRepo  = makeJournalEntryRepo(false)
      const dbError = Object.assign(new Error('raise_exception'), { code: 'P0001' })
      jeRepo.save.mockRejectedValue(dbError)
      const { worker } = makeWorker(jeRepo)

      await expect(worker.process(makeCapturedJob())).rejects.toBeInstanceOf(UnrecoverableError)
    })
  })

  // ── Erros retriable ─────────────────────────────────────────────────────────

  describe('erros retriable', () => {
    it('propaga erro genérico de infraestrutura para BullMQ fazer retry', async () => {
      const jeRepo = makeJournalEntryRepo(false)
      jeRepo.save.mockRejectedValue(new Error('Connection timeout'))
      const { worker } = makeWorker(jeRepo)

      await expect(worker.process(makeCapturedJob())).rejects.toThrow('Connection timeout')
    })
  })

  // ── Tipo de evento desconhecido ─────────────────────────────────────────────

  describe('tipo de evento desconhecido', () => {
    it('retorna silencioso para tipo de evento não suportado', async () => {
      const { worker, repos } = makeWorker()

      await worker.process(makeJob('PAYMENT_CREATED', {
        paymentId:           PAYMENT_ID,
        amount:              10_000,
        platformAmountCents: 800,
        sellerAmountCents:   9_200,
      }))

      expect(repos.journalEntries.save).not.toHaveBeenCalled()
    })
  })
})
