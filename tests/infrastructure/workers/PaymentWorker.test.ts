import type { Job } from 'bullmq'
import type { Logger } from 'pino'
import type { IUnitOfWork, ITransactionalRepositories } from '../../../src/application/shared/IUnitOfWork'
import type { IPaymentRepository } from '../../../src/domain/payment/IPaymentRepository'
import type { IPaymentGateway } from '../../../src/domain/payment/IPaymentGateway'
import type { IOutboxRepository } from '../../../src/domain/outbox/IOutboxRepository'
import type { IJournalEntryRepository } from '../../../src/domain/ledger/IJournalEntryRepository'
import type { ISettlementRepository } from '../../../src/domain/settlement/ISettlementRepository'
import type { PaymentStatus } from '../../../src/domain/payment/value-objects/PaymentStatus'
import { Payment } from '../../../src/domain/payment/Payment'
import { GatewayError } from '../../../src/domain/shared/errors'
import { ok, err } from '../../../src/domain/shared/Result'
import { PaymentId, SellerId, Cents, IdempotencyKey } from '../../../src/domain/shared/types'
import { PaymentWorker } from '../../../src/infrastructure/queue/workers/PaymentWorker'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PAYMENT_ID = '11111111-1111-4111-8111-111111111111'
const SELLER_ID  = '22222222-2222-4222-8222-222222222222'

function makePayment(status: PaymentStatus = 'PENDING'): Payment {
  return Payment.reconstitute({
    id:             PaymentId.of(PAYMENT_ID),
    sellerId:       SellerId.of(SELLER_ID),
    amount:         Cents.of(10_000),
    idempotencyKey: IdempotencyKey.of('idem-key-1234'),
    status,
    createdAt:      new Date(),
    updatedAt:      new Date(),
  })
}

function makeJob(data: Record<string, unknown> = { paymentId: PAYMENT_ID }): Job<Record<string, unknown>> {
  return { id: 'test-job-1', data, name: 'PAYMENT_CREATED' } as unknown as Job<Record<string, unknown>>
}

function makeGateway(): jest.Mocked<IPaymentGateway> {
  return {
    authorize: jest.fn().mockResolvedValue(ok({
      gatewayPaymentId: 'gw-pay-1',
      status:           'authorized',
      gatewayResponse:  { id: 'gw-pay-1' },
    })),
    capture: jest.fn().mockResolvedValue(ok({
      gatewayPaymentId: 'gw-pay-1',
      gatewayResponse:  { id: 'gw-pay-1' },
    })),
    refund:    jest.fn(),
    getStatus: jest.fn(),
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
    } as jest.Mocked<IPaymentRepository>,
    journalEntries: {
      save:                   jest.fn(),
      findById:               jest.fn(),
      findByPaymentId:        jest.fn(),
      existsByOutboxEventId:  jest.fn(),
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

function makeLogger(): Logger {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as Logger
}

function makeWorker(
  repos: jest.Mocked<ITransactionalRepositories>,
  gateway: jest.Mocked<IPaymentGateway>,
): PaymentWorker {
  return new PaymentWorker({
    uow:         makeUow(repos),
    gateway,
    gatewayName: 'stripe',
    logger:      makeLogger(),
  })
}

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('PaymentWorker', () => {
  afterEach(() => jest.clearAllMocks())

  describe('validação do job', () => {
    it('retorna silencioso e não acessa o banco quando paymentId não está no job data', async () => {
      const repos  = makeRepos(null)
      const worker = makeWorker(repos, makeGateway())

      await worker.process(makeJob({}))

      expect(repos.payments.findByIdForUpdate).not.toHaveBeenCalled()
    })
  })

  describe('idempotência', () => {
    it('retorna silencioso quando o pagamento não é encontrado no banco', async () => {
      const repos  = makeRepos(null)
      const worker = makeWorker(repos, makeGateway())

      await worker.process(makeJob())

      expect(repos.payments.update).not.toHaveBeenCalled()
    })

    it('não chama o gateway quando o pagamento já está CAPTURED', async () => {
      const payment = makePayment('CAPTURED')
      const gateway = makeGateway()
      const worker  = makeWorker(makeRepos(payment), gateway)

      await worker.process(makeJob())

      expect(gateway.authorize).not.toHaveBeenCalled()
    })

    it('não chama o gateway quando o pagamento já está FAILED', async () => {
      const payment = makePayment('FAILED')
      const gateway = makeGateway()
      const worker  = makeWorker(makeRepos(payment), gateway)

      await worker.process(makeJob())

      expect(gateway.authorize).not.toHaveBeenCalled()
    })

    it('não chama o gateway quando o pagamento já está SETTLED', async () => {
      const payment = makePayment('SETTLED')
      const gateway = makeGateway()
      const worker  = makeWorker(makeRepos(payment), gateway)

      await worker.process(makeJob())

      expect(gateway.authorize).not.toHaveBeenCalled()
    })

    it('usa findByIdForUpdate (SELECT FOR UPDATE) e não findById', async () => {
      const payment = makePayment('PENDING')
      const repos   = makeRepos(payment)
      const worker  = makeWorker(repos, makeGateway())

      await worker.process(makeJob())

      expect(repos.payments.findByIdForUpdate).toHaveBeenCalledWith(PaymentId.of(PAYMENT_ID))
      expect(repos.payments.findById).not.toHaveBeenCalled()
    })
  })

  describe('circuit breaker', () => {
    it('lança o erro e não persiste quando authorize retorna CIRCUIT_OPEN', async () => {
      const payment = makePayment('PENDING')
      const repos   = makeRepos(payment)
      const gateway = makeGateway()
      gateway.authorize.mockResolvedValue(err(new GatewayError('CB open', 'CIRCUIT_OPEN')))
      const worker = makeWorker(repos, gateway)

      await expect(worker.process(makeJob())).rejects.toThrow(GatewayError)
      expect(repos.payments.update).not.toHaveBeenCalled()
      expect(repos.outbox.save).not.toHaveBeenCalled()
    })

    it('lança o erro e não persiste quando capture retorna CIRCUIT_OPEN', async () => {
      const payment = makePayment('PENDING')
      const repos   = makeRepos(payment)
      const gateway = makeGateway()
      gateway.capture.mockResolvedValue(err(new GatewayError('CB open', 'CIRCUIT_OPEN')))
      const worker = makeWorker(repos, gateway)

      await expect(worker.process(makeJob())).rejects.toThrow(GatewayError)
      expect(repos.payments.update).not.toHaveBeenCalled()
      expect(repos.outbox.save).not.toHaveBeenCalled()
    })

    it('lança o erro mesmo quando o pagamento está em PROCESSING e authorize retorna CIRCUIT_OPEN', async () => {
      const payment = makePayment('PROCESSING')
      const gateway = makeGateway()
      gateway.authorize.mockResolvedValue(err(new GatewayError('CB open', 'CIRCUIT_OPEN')))
      const worker = makeWorker(makeRepos(payment), gateway)

      await expect(worker.process(makeJob())).rejects.toThrow(GatewayError)
    })
  })

  describe('falha terminal no gateway', () => {
    it('salva PAYMENT_FAILED e atualiza o pagamento quando authorize retorna erro não-circuit', async () => {
      const payment = makePayment('PENDING')
      const repos   = makeRepos(payment)
      const gateway = makeGateway()
      gateway.authorize.mockResolvedValue(err(new GatewayError('Card declined', 'CARD_DECLINED')))
      const worker = makeWorker(repos, gateway)

      await worker.process(makeJob())

      expect(repos.payments.update).toHaveBeenCalledTimes(1)
      expect(repos.outbox.save).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'PAYMENT_FAILED' }),
      )
    })

    it('pagamento fica como FAILED quando authorize falha terminalmente', async () => {
      const payment = makePayment('PENDING')
      const repos   = makeRepos(payment)
      const gateway = makeGateway()
      gateway.authorize.mockResolvedValue(err(new GatewayError('Card declined', 'CARD_DECLINED')))
      const worker = makeWorker(repos, gateway)

      await worker.process(makeJob())

      expect(payment.status).toBe('FAILED')
    })

    it('salva PAYMENT_FAILED e atualiza o pagamento quando capture retorna erro não-circuit', async () => {
      const payment = makePayment('PENDING')
      const repos   = makeRepos(payment)
      const gateway = makeGateway()
      gateway.capture.mockResolvedValue(err(new GatewayError('Capture failed', 'STRIPE_ERROR')))
      const worker = makeWorker(repos, gateway)

      await worker.process(makeJob())

      expect(repos.payments.update).toHaveBeenCalledTimes(1)
      expect(repos.outbox.save).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'PAYMENT_FAILED' }),
      )
    })

    it('não transiciona para AUTHORIZED quando capture falha (PROCESSING → FAILED direto)', async () => {
      const payment = makePayment('PENDING')
      const repos   = makeRepos(payment)
      const gateway = makeGateway()
      gateway.capture.mockResolvedValue(err(new GatewayError('Capture failed', 'STRIPE_ERROR')))
      const worker = makeWorker(repos, gateway)

      await worker.process(makeJob())

      // O pagamento vai direto de PROCESSING para FAILED, nunca persiste AUTHORIZED
      expect(payment.status).toBe('FAILED')
    })
  })

  describe('fluxo de 3DS (requires_action)', () => {
    it('salva PAYMENT_REQUIRES_ACTION e não chama capture', async () => {
      const payment = makePayment('PENDING')
      const repos   = makeRepos(payment)
      const gateway = makeGateway()
      gateway.authorize.mockResolvedValue(ok({
        gatewayPaymentId: 'gw-pay-1',
        status:           'requires_action',
        gatewayResponse:  { id: 'gw-pay-1' },
      }))
      const worker = makeWorker(repos, gateway)

      await worker.process(makeJob())

      expect(gateway.capture).not.toHaveBeenCalled()
      expect(repos.outbox.save).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'PAYMENT_REQUIRES_ACTION' }),
      )
    })

    it('pagamento fica como REQUIRES_ACTION quando gateway pede 3DS', async () => {
      const payment = makePayment('PENDING')
      const repos   = makeRepos(payment)
      const gateway = makeGateway()
      gateway.authorize.mockResolvedValue(ok({
        gatewayPaymentId: 'gw-pay-1',
        status:           'requires_action',
        gatewayResponse:  { id: 'gw-pay-1' },
      }))
      const worker = makeWorker(repos, gateway)

      await worker.process(makeJob())

      expect(payment.status).toBe('REQUIRES_ACTION')
    })
  })

  describe('happy path', () => {
    it('transiciona para CAPTURED e salva PAYMENT_CAPTURED no outbox', async () => {
      const payment = makePayment('PENDING')
      const repos   = makeRepos(payment)
      const worker  = makeWorker(repos, makeGateway())

      await worker.process(makeJob())

      expect(payment.status).toBe('CAPTURED')
      expect(repos.payments.update).toHaveBeenCalledTimes(1)
      expect(repos.outbox.save).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'PAYMENT_CAPTURED' }),
      )
    })

    it('inclui sellerId e amount no payload do PAYMENT_CAPTURED', async () => {
      const payment = makePayment('PENDING')
      const repos   = makeRepos(payment)
      const worker  = makeWorker(repos, makeGateway())

      await worker.process(makeJob())

      expect(repos.outbox.save).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'PAYMENT_CAPTURED',
        }),
      )
      const savedEvent = jest.mocked(repos.outbox.save).mock.calls[0]?.[0]
      expect(savedEvent?.payload).toMatchObject({
        paymentId: PAYMENT_ID,
        sellerId:  SELLER_ID,
        amount:    10_000,
      })
    })

    it('funciona corretamente quando pagamento já está em PROCESSING (retry idempotente)', async () => {
      const payment = makePayment('PROCESSING')
      const repos   = makeRepos(payment)
      const worker  = makeWorker(repos, makeGateway())

      await worker.process(makeJob())

      expect(payment.status).toBe('CAPTURED')
      expect(repos.outbox.save).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'PAYMENT_CAPTURED' }),
      )
    })

    it('chama authorize antes de capture', async () => {
      const payment  = makePayment('PENDING')
      const repos    = makeRepos(payment)
      const gateway  = makeGateway()
      const callOrder: string[] = []
      gateway.authorize.mockImplementation(() => {
        callOrder.push('authorize')
        return Promise.resolve(ok({ gatewayPaymentId: 'gw-pay-1', status: 'authorized', gatewayResponse: {} }))
      })
      gateway.capture.mockImplementation(() => {
        callOrder.push('capture')
        return Promise.resolve(ok({ gatewayPaymentId: 'gw-pay-1', gatewayResponse: {} }))
      })
      const worker = makeWorker(repos, gateway)

      await worker.process(makeJob())

      expect(callOrder).toEqual(['authorize', 'capture'])
    })
  })
})
