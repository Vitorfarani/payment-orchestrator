import { CreatePaymentUseCase } from '../../../src/application/payment/CreatePaymentUseCase'
import { InMemoryUnitOfWork }   from '../fakes/InMemoryUnitOfWork'
import { SellerId, Cents, IdempotencyKey } from '../../../src/domain/shared/types'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SELLER_ID       = '22222222-2222-4222-8222-222222222222'
const IDEMPOTENCY_KEY = 'idempotency-key-abc123'

function makeInput(overrides: Partial<Parameters<CreatePaymentUseCase['execute']>[0]> = {}) {
  return {
    sellerId:       SellerId.of(SELLER_ID),
    amountCents:    Cents.of(10_000),
    idempotencyKey: IdempotencyKey.of(IDEMPOTENCY_KEY),
    ...overrides,
  }
}

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('CreatePaymentUseCase', () => {
  it('salva o payment com status PENDING e retorna o paymentId', async () => {
    const uow     = new InMemoryUnitOfWork()
    const useCase = new CreatePaymentUseCase(uow)

    const result = await useCase.execute(makeInput())

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.paymentId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )

    // O payment foi realmente persistido no repositório in-memory
    const saved = await uow.payments.findById(result.value.paymentId)
    expect(saved).not.toBeNull()
    expect(saved?.status).toBe('PENDING')
    expect(saved?.amount).toBe(Cents.of(10_000))
    expect(saved?.sellerId).toBe(SellerId.of(SELLER_ID))
  })

  it('persiste o OutboxEvent PAYMENT_CREATED na mesma transação', async () => {
    const uow     = new InMemoryUnitOfWork()
    const useCase = new CreatePaymentUseCase(uow)

    const result = await useCase.execute(makeInput())

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const events = uow.outbox.ofType('PAYMENT_CREATED')
    expect(events).toHaveLength(1)

    const event = events[0]
    expect(event?.aggregateType).toBe('Payment')
    expect(event?.aggregateId).toBe(result.value.paymentId)
    expect(event?.payload['paymentId']).toBe(result.value.paymentId)
  })

  it('repassa metadata ao payment quando fornecido', async () => {
    const uow      = new InMemoryUnitOfWork()
    const useCase  = new CreatePaymentUseCase(uow)
    const metadata = { orderId: 'order-42', customerId: 'cust-7' }

    const result = await useCase.execute(makeInput({ metadata }))

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const saved = await uow.payments.findById(result.value.paymentId)
    expect(saved?.metadata).toEqual(metadata)
  })

  it('retorna ValidationError sem persistir nada quando amountCents é zero', async () => {
    const uow     = new InMemoryUnitOfWork()
    const useCase = new CreatePaymentUseCase(uow)

    const result = await useCase.execute(makeInput({ amountCents: Cents.of(0) }))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_ERROR')

    // Nada foi salvo — nem payment nem outbox event
    expect(uow.payments.count()).toBe(0)
    expect(uow.outbox.count()).toBe(0)
  })

  it('propaga exceção de infraestrutura sem envolver em Result', async () => {
    // Simula falha de banco sobrescrevendo o método save do repo in-memory
    const uow = new InMemoryUnitOfWork()
    uow.payments.save = () => Promise.reject(new Error('DB connection lost'))
    const useCase = new CreatePaymentUseCase(uow)

    await expect(useCase.execute(makeInput())).rejects.toThrow('DB connection lost')
  })

  it('gera paymentId único a cada execução', async () => {
    const useCase = new CreatePaymentUseCase(new InMemoryUnitOfWork())

    const r1 = await useCase.execute(makeInput({ idempotencyKey: IdempotencyKey.of('idem-key-111111111') }))
    const r2 = await useCase.execute(makeInput({ idempotencyKey: IdempotencyKey.of('idem-key-222222222') }))

    expect(r1.ok && r2.ok).toBe(true)
    if (!r1.ok || !r2.ok) return
    expect(r1.value.paymentId).not.toBe(r2.value.paymentId)
  })

  it('idempotencyKey do payment salvo bate com o input', async () => {
    const uow     = new InMemoryUnitOfWork()
    const useCase = new CreatePaymentUseCase(uow)

    const result = await useCase.execute(makeInput())

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const saved = await uow.payments.findById(result.value.paymentId)
    expect(saved?.idempotencyKey).toBe(IdempotencyKey.of(IDEMPOTENCY_KEY))
  })
})
