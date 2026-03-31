import type { Job } from 'bullmq'
import type { Logger } from 'pino'
import type { IUnitOfWork, ITransactionalRepositories } from '../../../src/application/shared/IUnitOfWork'
import type { IPaymentRepository } from '../../../src/domain/payment/IPaymentRepository'
import type { IPaymentGateway } from '../../../src/domain/payment/IPaymentGateway'
import type { IOutboxRepository } from '../../../src/domain/outbox/IOutboxRepository'
import type { IJournalEntryRepository } from '../../../src/domain/ledger/IJournalEntryRepository'
import type { ISettlementRepository } from '../../../src/domain/settlement/ISettlementRepository'
import type { ISplitRuleRepository } from '../../../src/domain/split/ISplitRuleRepository'
import { Payment } from '../../../src/domain/payment/Payment'
import { SplitRule } from '../../../src/domain/split/SplitRule'
import { GatewayError } from '../../../src/domain/shared/errors'
import { ok, err } from '../../../src/domain/shared/Result'
import {
  PaymentId, SellerId, Cents, IdempotencyKey,
  SplitRuleId, CommissionRate,
} from '../../../src/domain/shared/types'
import { PaymentReconciliationWorker } from '../../../src/infrastructure/queue/workers/PaymentReconciliationWorker'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PAYMENT_ID  = '11111111-1111-4111-8111-111111111111'
const SELLER_ID   = '22222222-2222-4222-8222-222222222222'
const RULE_ID     = '33333333-3333-4333-8333-333333333333'
const GW_PAY_ID   = 'gw-pay-abc123'

/** Cria payment com status PROCESSING e, por padrão, sem gatewayPaymentId. */
function makePayment(gatewayPaymentId?: string): Payment {
  return Payment.reconstitute({
    id:             PaymentId.of(PAYMENT_ID),
    sellerId:       SellerId.of(SELLER_ID),
    amount:         Cents.of(10_000),
    idempotencyKey: IdempotencyKey.of('idem-1234'),
    status:         'PROCESSING',
    createdAt:      new Date('2026-01-01T00:00:00Z'),
    updatedAt:      new Date('2026-01-01T00:00:00Z'),
    ...(gatewayPaymentId !== undefined && { gatewayPaymentId }),
  })
}

function makeSplitRule(rate = 0.10): SplitRule {
  return SplitRule.create({
    id:             SplitRuleId.of(RULE_ID),
    sellerId:       SellerId.of(SELLER_ID),
    commissionRate: CommissionRate.of(rate),
  })
}

function makeGatewayStatus(status: string): jest.Mocked<IPaymentGateway> {
  return {
    authorize:  jest.fn(),
    capture:    jest.fn(),
    refund:     jest.fn(),
    getStatus:  jest.fn().mockResolvedValue(ok({
      gatewayPaymentId: GW_PAY_ID,
      status,
      gatewayResponse:  {},
    })),
  }
}

function makeRepos(payment: Payment | null): jest.Mocked<ITransactionalRepositories> {
  return {
    payments: {
      save:                  jest.fn(),
      update:                jest.fn().mockResolvedValue(undefined),
      findById:              jest.fn(),
      findByIdForUpdate:     jest.fn().mockResolvedValue(payment),
      findByIdempotencyKey:  jest.fn(),
      findBySellerAndStatus: jest.fn(),
      findStuckInProcessing: jest.fn(),
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

function makePaymentRepo(stuck: Payment[] = []): jest.Mocked<IPaymentRepository> {
  return {
    save:                  jest.fn(),
    update:                jest.fn(),
    findById:              jest.fn(),
    findByIdForUpdate:     jest.fn(),
    findByIdempotencyKey:  jest.fn(),
    findBySellerAndStatus: jest.fn(),
    findStuckInProcessing: jest.fn().mockResolvedValue(stuck),
  }
}

function makeSplitRuleRepo(rule: SplitRule | null = makeSplitRule()): jest.Mocked<ISplitRuleRepository> {
  return {
    save:                 jest.fn(),
    findById:             jest.fn(),
    findActiveBySellerId: jest.fn().mockResolvedValue(rule),
  }
}

function makeLogger(): Logger {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as Logger
}

function makeWorker(
  paymentRepo:   jest.Mocked<IPaymentRepository>,
  repos:         jest.Mocked<ITransactionalRepositories>,
  gateway:       jest.Mocked<IPaymentGateway>,
  splitRuleRepo: jest.Mocked<ISplitRuleRepository> = makeSplitRuleRepo(),
  stuckThresholdMs = 0,
): PaymentReconciliationWorker {
  return new PaymentReconciliationWorker({
    paymentRepo,
    uow:          makeUow(repos),
    gateway,
    splitRuleRepo,
    logger:       makeLogger(),
    stuckThresholdMs,   // 0 = todos os pagamentos PROCESSING são "stuck" para os testes
  })
}

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('PaymentReconciliationWorker', () => {
  afterEach(() => jest.clearAllMocks())

  // ── Lista vazia ─────────────────────────────────────────────────────────────

  it('não processa nada quando não há pagamentos presos', async () => {
    const paymentRepo = makePaymentRepo([])
    const repos       = makeRepos(null)
    const gateway     = makeGatewayStatus('captured')
    const worker      = makeWorker(paymentRepo, repos, gateway)

    await worker.run()

    expect(gateway.getStatus).not.toHaveBeenCalled()
    expect(repos.payments.update).not.toHaveBeenCalled()
    expect(repos.outbox.save).not.toHaveBeenCalled()
  })

  it('chama findStuckInProcessing com a data correta (now - threshold)', async () => {
    const threshold   = 10 * 60 * 1000   // 10 minutos em ms
    const paymentRepo = makePaymentRepo([])
    const repos       = makeRepos(null)
    const worker      = new PaymentReconciliationWorker({
      paymentRepo,
      uow:          makeUow(repos),
      gateway:      makeGatewayStatus('captured'),
      splitRuleRepo: makeSplitRuleRepo(),
      logger:        makeLogger(),
      stuckThresholdMs: threshold,
    })
    const before = new Date()
    await worker.run()
    const after = new Date()

    expect(paymentRepo.findStuckInProcessing).toHaveBeenCalledTimes(1)
    const calledWith: Date = (paymentRepo.findStuckInProcessing as jest.Mock).mock.calls[0][0]
    expect(calledWith.getTime()).toBeGreaterThanOrEqual(before.getTime() - threshold)
    expect(calledWith.getTime()).toBeLessThanOrEqual(after.getTime() - threshold + 100)
  })

  // ── Sem gatewayPaymentId ────────────────────────────────────────────────────

  describe('payment sem gatewayPaymentId', () => {
    it('transiciona para FAILED sem chamar gateway', async () => {
      const payment     = makePayment()           // sem gatewayPaymentId
      const paymentRepo = makePaymentRepo([payment])
      const repos       = makeRepos(payment)
      const gateway     = makeGatewayStatus('captured')
      const worker      = makeWorker(paymentRepo, repos, gateway)

      await worker.run()

      expect(gateway.getStatus).not.toHaveBeenCalled()
      expect(repos.payments.update).toHaveBeenCalledTimes(1)

      const updated: Payment = (repos.payments.update as jest.Mock).mock.calls[0][0]
      expect(updated.status).toBe('FAILED')
      expect(updated.errorCode).toBe('RECONCILIATION_NO_GATEWAY_ID')
    })

    it('emite OutboxEvent PAYMENT_FAILED', async () => {
      const payment     = makePayment()
      const paymentRepo = makePaymentRepo([payment])
      const repos       = makeRepos(payment)
      const worker      = makeWorker(paymentRepo, repos, makeGatewayStatus('captured'))

      await worker.run()

      expect(repos.outbox.save).toHaveBeenCalledTimes(1)
      const event = (repos.outbox.save as jest.Mock).mock.calls[0][0]
      expect(event.eventType).toBe('PAYMENT_FAILED')
    })
  })

  // ── Gateway retorna 'captured' / 'succeeded' ────────────────────────────────

  describe('gateway retorna status de captura', () => {
    it.each(['captured', 'succeeded', 'paid'])(
      'reconcilia como CAPTURED quando gateway retorna "%s"',
      async (gwStatus) => {
        const payment     = makePayment(GW_PAY_ID)
        const paymentRepo = makePaymentRepo([payment])
        const repos       = makeRepos(payment)
        const worker      = makeWorker(paymentRepo, repos, makeGatewayStatus(gwStatus))

        await worker.run()

        const updated: Payment = (repos.payments.update as jest.Mock).mock.calls[0][0]
        expect(updated.status).toBe('CAPTURED')
      },
    )

    it('emite PAYMENT_CAPTURED com split calculado', async () => {
      const payment     = makePayment(GW_PAY_ID)
      const paymentRepo = makePaymentRepo([payment])
      const repos       = makeRepos(payment)
      // rate 10% → platform = 1000, seller = 9000
      const worker = makeWorker(paymentRepo, repos, makeGatewayStatus('captured'), makeSplitRuleRepo(makeSplitRule(0.10)))

      await worker.run()

      const event = (repos.outbox.save as jest.Mock).mock.calls[0][0]
      expect(event.eventType).toBe('PAYMENT_CAPTURED')
      expect(event.payload.platformAmountCents).toBe(1_000)
      expect(event.payload.sellerAmountCents).toBe(9_000)
    })

    it('lança UnrecoverableError quando split rule não existe para o seller', async () => {
      const payment     = makePayment(GW_PAY_ID)
      const paymentRepo = makePaymentRepo([payment])
      const repos       = makeRepos(payment)
      const worker      = makeWorker(paymentRepo, repos, makeGatewayStatus('captured'), makeSplitRuleRepo(null))

      await expect(worker.run()).rejects.toThrow(/split rule/)
    })
  })

  // ── Gateway retorna falha ───────────────────────────────────────────────────

  describe('gateway retorna status de falha', () => {
    it.each(['failed', 'declined'])(
      'reconcilia como FAILED quando gateway retorna "%s"',
      async (gwStatus) => {
        const payment     = makePayment(GW_PAY_ID)
        const paymentRepo = makePaymentRepo([payment])
        const repos       = makeRepos(payment)
        const worker      = makeWorker(paymentRepo, repos, makeGatewayStatus(gwStatus))

        await worker.run()

        const updated: Payment = (repos.payments.update as jest.Mock).mock.calls[0][0]
        expect(updated.status).toBe('FAILED')
        expect(updated.errorCode).toBe('GATEWAY_PAYMENT_FAILED')
      },
    )

    it('emite PAYMENT_FAILED', async () => {
      const payment     = makePayment(GW_PAY_ID)
      const paymentRepo = makePaymentRepo([payment])
      const repos       = makeRepos(payment)
      const worker      = makeWorker(paymentRepo, repos, makeGatewayStatus('failed'))

      await worker.run()

      const event = (repos.outbox.save as jest.Mock).mock.calls[0][0]
      expect(event.eventType).toBe('PAYMENT_FAILED')
    })
  })

  // ── Gateway retorna cancelado ───────────────────────────────────────────────

  describe('gateway retorna status cancelado', () => {
    it.each(['cancelled', 'canceled'])(
      'reconcilia como CANCELLED quando gateway retorna "%s"',
      async (gwStatus) => {
        const payment     = makePayment(GW_PAY_ID)
        const paymentRepo = makePaymentRepo([payment])
        const repos       = makeRepos(payment)
        const worker      = makeWorker(paymentRepo, repos, makeGatewayStatus(gwStatus))

        await worker.run()

        const updated: Payment = (repos.payments.update as jest.Mock).mock.calls[0][0]
        expect(updated.status).toBe('CANCELLED')
      },
    )

    it('emite PAYMENT_CANCELLED', async () => {
      const payment     = makePayment(GW_PAY_ID)
      const paymentRepo = makePaymentRepo([payment])
      const repos       = makeRepos(payment)
      const worker      = makeWorker(paymentRepo, repos, makeGatewayStatus('cancelled'))

      await worker.run()

      const event = (repos.outbox.save as jest.Mock).mock.calls[0][0]
      expect(event.eventType).toBe('PAYMENT_CANCELLED')
    })
  })

  // ── Gateway retorna authorized ──────────────────────────────────────────────

  describe('gateway retorna authorized', () => {
    it.each(['authorized', 'requires_capture'])(
      'reconcilia como AUTHORIZED quando gateway retorna "%s"',
      async (gwStatus) => {
        const payment     = makePayment(GW_PAY_ID)
        const paymentRepo = makePaymentRepo([payment])
        const repos       = makeRepos(payment)
        const worker      = makeWorker(paymentRepo, repos, makeGatewayStatus(gwStatus))

        await worker.run()

        const updated: Payment = (repos.payments.update as jest.Mock).mock.calls[0][0]
        expect(updated.status).toBe('AUTHORIZED')
      },
    )

    it('emite PAYMENT_AUTHORIZED', async () => {
      const payment     = makePayment(GW_PAY_ID)
      const paymentRepo = makePaymentRepo([payment])
      const repos       = makeRepos(payment)
      const worker      = makeWorker(paymentRepo, repos, makeGatewayStatus('authorized'))

      await worker.run()

      const event = (repos.outbox.save as jest.Mock).mock.calls[0][0]
      expect(event.eventType).toBe('PAYMENT_AUTHORIZED')
    })
  })

  // ── Gateway retorna requires_action ────────────────────────────────────────

  it('reconcilia como REQUIRES_ACTION quando gateway retorna "requires_action"', async () => {
    const payment     = makePayment(GW_PAY_ID)
    const paymentRepo = makePaymentRepo([payment])
    const repos       = makeRepos(payment)
    const worker      = makeWorker(paymentRepo, repos, makeGatewayStatus('requires_action'))

    await worker.run()

    const updated: Payment = (repos.payments.update as jest.Mock).mock.calls[0][0]
    expect(updated.status).toBe('REQUIRES_ACTION')

    const event = (repos.outbox.save as jest.Mock).mock.calls[0][0]
    expect(event.eventType).toBe('PAYMENT_REQUIRES_ACTION')
  })

  // ── Circuit Breaker aberto ──────────────────────────────────────────────────

  it('pula silenciosamente quando o circuit breaker está aberto', async () => {
    const payment     = makePayment(GW_PAY_ID)
    const paymentRepo = makePaymentRepo([payment])
    const repos       = makeRepos(payment)
    const gateway     = {
      authorize: jest.fn(), capture: jest.fn(), refund: jest.fn(),
      getStatus: jest.fn().mockResolvedValue(
        err(new GatewayError('Circuit open', 'CIRCUIT_OPEN')),
      ),
    }
    const worker = makeWorker(paymentRepo, repos, gateway)

    await expect(worker.run()).resolves.not.toThrow()
    expect(repos.payments.update).not.toHaveBeenCalled()
  })

  // ── Erro de gateway genérico ────────────────────────────────────────────────

  it('pula e loga erro quando gateway retorna erro não-CIRCUIT_OPEN', async () => {
    const payment     = makePayment(GW_PAY_ID)
    const paymentRepo = makePaymentRepo([payment])
    const repos       = makeRepos(payment)
    const gateway     = {
      authorize: jest.fn(), capture: jest.fn(), refund: jest.fn(),
      getStatus: jest.fn().mockResolvedValue(
        err(new GatewayError('Timeout', 'GATEWAY_TIMEOUT')),
      ),
    }
    const logger = makeLogger()
    const worker = new PaymentReconciliationWorker({
      paymentRepo, uow: makeUow(repos), gateway, splitRuleRepo: makeSplitRuleRepo(),
      logger, stuckThresholdMs: 0,
    })

    await worker.run()

    expect(repos.payments.update).not.toHaveBeenCalled()
    expect((logger.error as jest.Mock)).toHaveBeenCalled()
  })

  // ── Status desconhecido ─────────────────────────────────────────────────────

  it('pula e emite warn quando o gateway retorna status desconhecido', async () => {
    const payment     = makePayment(GW_PAY_ID)
    const paymentRepo = makePaymentRepo([payment])
    const repos       = makeRepos(payment)
    const logger      = makeLogger()
    const worker      = new PaymentReconciliationWorker({
      paymentRepo, uow: makeUow(repos),
      gateway:      makeGatewayStatus('pending_review'),
      splitRuleRepo: makeSplitRuleRepo(),
      logger, stuckThresholdMs: 0,
    })

    await worker.run()

    expect(repos.payments.update).not.toHaveBeenCalled()
    expect((logger.warn as jest.Mock)).toHaveBeenCalled()
  })

  // ── Isolamento de falhas ────────────────────────────────────────────────────

  it('continua processando os demais quando um pagamento lança erro inesperado', async () => {
    const p1 = makePayment(GW_PAY_ID)
    const p2 = Payment.reconstitute({
      id:             PaymentId.of('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      sellerId:       SellerId.of(SELLER_ID),
      amount:         Cents.of(5_000),
      idempotencyKey: IdempotencyKey.of('idem-5678'),
      status:         'PROCESSING',
      createdAt:      new Date(),
      updatedAt:      new Date(),
      gatewayPaymentId: GW_PAY_ID,
    })

    const paymentRepo = makePaymentRepo([p1, p2])
    const uow: jest.Mocked<IUnitOfWork> = {
      run: jest.fn()
        .mockRejectedValueOnce(new Error('db connection lost'))  // p1 falha
        .mockImplementation((fn: (r: ITransactionalRepositories) => Promise<unknown>) => fn(makeRepos(p2))),  // p2 ok
    }
    const worker = new PaymentReconciliationWorker({
      paymentRepo, uow,
      gateway:      makeGatewayStatus('captured'),
      splitRuleRepo: makeSplitRuleRepo(),
      logger:        makeLogger(),
      stuckThresholdMs: 0,
    })

    await expect(worker.run()).resolves.not.toThrow()
  })

  // ── Payment já saiu de PROCESSING ──────────────────────────────────────────

  it('pula sem erro quando o payment já não está em PROCESSING (processado por outro worker)', async () => {
    const payment     = makePayment(GW_PAY_ID)
    const paymentRepo = makePaymentRepo([payment])

    // findByIdForUpdate retorna CAPTURED (outro worker terminou antes)
    const capturedPayment = Payment.reconstitute({
      id:             PaymentId.of(PAYMENT_ID),
      sellerId:       SellerId.of(SELLER_ID),
      amount:         Cents.of(10_000),
      idempotencyKey: IdempotencyKey.of('idem-1234'),
      status:         'CAPTURED',
      createdAt:      new Date(),
      updatedAt:      new Date(),
    })
    const repos  = makeRepos(capturedPayment)
    const worker = makeWorker(paymentRepo, repos, makeGatewayStatus('captured'))

    await worker.run()

    // update não deve ser chamado — status já é final
    expect(repos.payments.update).not.toHaveBeenCalled()
    expect(repos.outbox.save).not.toHaveBeenCalled()
  })
})
