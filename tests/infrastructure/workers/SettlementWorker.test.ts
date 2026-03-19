import { UnrecoverableError } from 'bullmq'
import type { Job } from 'bullmq'
import type { Logger } from 'pino'
import type { IUnitOfWork, ITransactionalRepositories } from '../../../src/application/shared/IUnitOfWork'
import type { IJournalEntryRepository } from '../../../src/domain/ledger/IJournalEntryRepository'
import type { IOutboxRepository } from '../../../src/domain/outbox/IOutboxRepository'
import type { IPaymentRepository } from '../../../src/domain/payment/IPaymentRepository'
import type { ISettlementRepository } from '../../../src/domain/settlement/ISettlementRepository'
import { SettlementItem } from '../../../src/domain/settlement/SettlementItem'
import { PaymentId, SellerId, Cents, SettlementItemId } from '../../../src/domain/shared/types'
import { SettlementWorker } from '../../../src/infrastructure/queue/workers/SettlementWorker'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PAYMENT_ID  = '66666666-6666-4666-8666-666666666666'
const PAYMENT_ID2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SELLER_ID   = '77777777-7777-4777-8777-777777777777'
const ITEM_ID     = '88888888-8888-4888-8888-888888888888'
const ITEM_ID2    = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const CAPTURED_AT = '2026-03-01T12:00:00.000Z'

function makeJob(data: Record<string, unknown> = {}): Job<Record<string, unknown>> {
  return {
    id:   'job-settlement-1',
    name: 'PAYMENT_CAPTURED',
    data: {
      paymentId:           PAYMENT_ID,
      sellerId:            SELLER_ID,
      amount:              10_000,
      platformAmountCents: 800,
      sellerAmountCents:   9_200,
      capturedAt:          CAPTURED_AT,
      ...data,
    },
  } as unknown as Job<Record<string, unknown>>
}

function makePendingItem(
  id      = ITEM_ID,
  payment = PAYMENT_ID,
): SettlementItem {
  return SettlementItem.reconstitute({
    id:            SettlementItemId.of(id),
    paymentId:     PaymentId.of(payment),
    sellerId:      SellerId.of(SELLER_ID),
    amountCents:   Cents.of(9_200),
    scheduledDate: new Date('2026-03-15T00:00:00.000Z'),
    status:        'PENDING',
    createdAt:     new Date(),
    updatedAt:     new Date(),
  })
}

function makeSettlementRepo(
  existingItem: SettlementItem | null = null,
): jest.Mocked<ISettlementRepository> {
  return {
    save:                  jest.fn().mockResolvedValue(undefined),
    update:                jest.fn().mockResolvedValue(undefined),
    findById:              jest.fn(),
    findByPaymentId:       jest.fn().mockResolvedValue(existingItem),
    findDueItems:          jest.fn().mockResolvedValue([]),
    findByIdForUpdate:     jest.fn().mockResolvedValue(existingItem),
    findBySellerAndStatus: jest.fn(),
  }
}

function makeRepos(sr: jest.Mocked<ISettlementRepository>): jest.Mocked<ITransactionalRepositories> {
  return {
    payments: {
      save:                  jest.fn(),
      update:                jest.fn(),
      findById:              jest.fn(),
      findByIdForUpdate:     jest.fn(),
      findByIdempotencyKey:  jest.fn(),
      findBySellerAndStatus: jest.fn(),
    } as jest.Mocked<IPaymentRepository>,
    journalEntries: {
      save:                  jest.fn(),
      findById:              jest.fn(),
      findByPaymentId:       jest.fn(),
      existsByOutboxEventId: jest.fn(),
    } as jest.Mocked<IJournalEntryRepository>,
    outbox: {
      save:                 jest.fn().mockResolvedValue(undefined),
      findUnprocessedBatch: jest.fn(),
      markProcessed:        jest.fn(),
      recordFailure:        jest.fn(),
    } as jest.Mocked<IOutboxRepository>,
    settlements: sr,
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

/** Monta worker com deps controláveis. */
function buildWorker(sr: jest.Mocked<ISettlementRepository>, uow?: jest.Mocked<IUnitOfWork>) {
  const repos = makeRepos(sr)
  const u     = uow ?? makeUow(repos)
  return {
    worker: new SettlementWorker({ uow: u, settlementRepo: sr, logger: makeLogger() }),
    repos,
    sr,
    uow: u,
  }
}

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('SettlementWorker', () => {
  afterEach(() => jest.clearAllMocks())

  // ── process — PAYMENT_CAPTURED ──────────────────────────────────────────────

  describe('process — PAYMENT_CAPTURED', () => {
    it('retorna silencioso quando paymentId está ausente no payload', async () => {
      const sr = makeSettlementRepo()
      const { worker } = buildWorker(sr)

      await worker.process(makeJob({ paymentId: undefined }))

      expect(sr.findByPaymentId).not.toHaveBeenCalled()
    })

    it('retorna silencioso quando sellerId está ausente no payload', async () => {
      const sr = makeSettlementRepo()
      const { worker } = buildWorker(sr)

      await worker.process(makeJob({ sellerId: undefined }))

      expect(sr.findByPaymentId).not.toHaveBeenCalled()
    })

    it('retorna silencioso quando sellerAmountCents está ausente', async () => {
      const sr = makeSettlementRepo()
      const { worker } = buildWorker(sr)

      await worker.process(makeJob({ sellerAmountCents: undefined }))

      expect(sr.save).not.toHaveBeenCalled()
    })

    it('retorna silencioso quando já existe settlement para o pagamento (idempotência)', async () => {
      const sr = makeSettlementRepo(makePendingItem())
      const repos = makeRepos(sr)
      const uow   = makeUow(repos)
      const { worker } = buildWorker(sr, uow)

      await worker.process(makeJob())

      expect(uow.run).not.toHaveBeenCalled()
    })

    it('verifica idempotência com o paymentId correto', async () => {
      const sr = makeSettlementRepo()
      const { worker } = buildWorker(sr)

      await worker.process(makeJob())

      expect(sr.findByPaymentId).toHaveBeenCalledWith(PaymentId.of(PAYMENT_ID))
    })

    it('cria SettlementItem com status PENDING', async () => {
      const sr = makeSettlementRepo()
      const { worker } = buildWorker(sr)

      await worker.process(makeJob())

      const savedItem = sr.save.mock.calls[0]?.[0]
      expect(savedItem?.status).toBe('PENDING')
    })

    it('usa o sellerAmountCents do payload como amountCents do SettlementItem', async () => {
      const sr = makeSettlementRepo()
      const { worker } = buildWorker(sr)

      await worker.process(makeJob())

      const savedItem = sr.save.mock.calls[0]?.[0]
      expect(savedItem?.amountCents).toBe(9_200)
    })

    it('calcula scheduledDate a partir de capturedAt usando schedule padrão D+14', async () => {
      const sr = makeSettlementRepo()
      const { worker } = buildWorker(sr)

      await worker.process(makeJob())

      const savedItem = sr.save.mock.calls[0]?.[0]
      // capturedAt = 2026-03-01 + 14 dias = 2026-03-15 (UTC midnight)
      expect(savedItem?.scheduledDate.toISOString()).toBe('2026-03-15T00:00:00.000Z')
    })

    it('lança UnrecoverableError quando sellerAmountCents é zero ou negativo', async () => {
      const sr = makeSettlementRepo()
      const { worker } = buildWorker(sr)

      await expect(
        worker.process(makeJob({ sellerAmountCents: 0 })),
      ).rejects.toBeInstanceOf(UnrecoverableError)
    })
  })

  // ── processDue — cron 06:00 UTC ─────────────────────────────────────────────

  describe('processDue', () => {
    it('não abre UoW quando não há itens vencidos', async () => {
      const sr          = makeSettlementRepo()
      const repos       = makeRepos(sr)
      const uow         = makeUow(repos)
      const { worker }  = buildWorker(sr, uow)
      sr.findDueItems.mockResolvedValue([])

      await worker.processDue(new Date())

      expect(uow.run).not.toHaveBeenCalled()
    })

    it('transiciona item de PENDING para COMPLETED', async () => {
      const pendingItem = makePendingItem()
      const sr          = makeSettlementRepo()
      sr.findDueItems.mockResolvedValue([pendingItem])
      sr.findByIdForUpdate.mockResolvedValue(pendingItem)
      const { worker } = buildWorker(sr)

      await worker.processDue(new Date())

      const updatedItem = sr.update.mock.calls[0]?.[0]
      expect(updatedItem?.status).toBe('COMPLETED')
    })

    it('salva OutboxEvent SETTLEMENT_COMPLETED para cada item processado', async () => {
      const pendingItem = makePendingItem()
      const sr          = makeSettlementRepo()
      const repos       = makeRepos(sr)
      sr.findDueItems.mockResolvedValue([pendingItem])
      sr.findByIdForUpdate.mockResolvedValue(pendingItem)
      const uow = makeUow(repos)
      const { worker } = buildWorker(sr, uow)

      await worker.processDue(new Date())

      expect(jest.mocked(repos.outbox.save)).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'SETTLEMENT_COMPLETED' }),
      )
    })

    it('pula item que não está mais PENDING (race condition)', async () => {
      const processingItem = SettlementItem.reconstitute({
        id:            SettlementItemId.of(ITEM_ID),
        paymentId:     PaymentId.of(PAYMENT_ID),
        sellerId:      SellerId.of(SELLER_ID),
        amountCents:   Cents.of(9_200),
        scheduledDate: new Date(),
        status:        'PROCESSING',
        createdAt:     new Date(),
        updatedAt:     new Date(),
      })
      const sr = makeSettlementRepo()
      sr.findDueItems.mockResolvedValue([processingItem])
      sr.findByIdForUpdate.mockResolvedValue(processingItem)
      const { worker } = buildWorker(sr)

      await worker.processDue(new Date())

      expect(sr.update).not.toHaveBeenCalled()
    })

    it('pula item quando findByIdForUpdate retorna null', async () => {
      const pendingItem = makePendingItem()
      const sr          = makeSettlementRepo()
      sr.findDueItems.mockResolvedValue([pendingItem])
      sr.findByIdForUpdate.mockResolvedValue(null)
      const { worker } = buildWorker(sr)

      await worker.processDue(new Date())

      expect(sr.update).not.toHaveBeenCalled()
    })

    it('continua processando itens seguintes quando um item falha', async () => {
      const item1 = makePendingItem(ITEM_ID,  PAYMENT_ID)
      const item2 = makePendingItem(ITEM_ID2, PAYMENT_ID2)

      const sr = makeSettlementRepo()
      sr.findDueItems.mockResolvedValue([item1, item2])
      // Primeiro item lança erro no lock; segundo retorna normalmente
      sr.findByIdForUpdate
        .mockRejectedValueOnce(new Error('DB timeout'))
        .mockResolvedValueOnce(item2)

      const { worker } = buildWorker(sr)

      // Não deve lançar — cada item é independente
      await expect(worker.processDue(new Date())).resolves.toBeUndefined()
      // item2 deve ter sido processado com sucesso
      expect(sr.update).toHaveBeenCalledTimes(1)
    })
  })
})
