import { ProcessWebhookUseCase }  from '../../../src/application/payment/ProcessWebhookUseCase'
import { InMemoryUnitOfWork }     from '../fakes/InMemoryUnitOfWork'
import { Payment }                from '../../../src/domain/payment/Payment'
import { PaymentId, SellerId, Cents, IdempotencyKey } from '../../../src/domain/shared/types'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PAYMENT_ID = '11111111-1111-4111-8111-111111111111'
const SELLER_ID  = '22222222-2222-4222-8222-222222222222'
const EVENT_ID   = 'evt_abc123webhook'

function makePayment(status: Parameters<typeof Payment.reconstitute>[0]['status'] = 'PROCESSING') {
  return Payment.reconstitute({
    id:             PaymentId.of(PAYMENT_ID),
    sellerId:       SellerId.of(SELLER_ID),
    amount:         Cents.of(10_000),
    idempotencyKey: IdempotencyKey.of('idem-key-abc-1234'),
    status,
    createdAt:      new Date(),
    updatedAt:      new Date(),
  })
}

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('ProcessWebhookUseCase', () => {
  it('transiciona o pagamento para o novo status e emite OutboxEvent', async () => {
    const uow     = new InMemoryUnitOfWork()
    const useCase = new ProcessWebhookUseCase(uow)
    await uow.payments.save(makePayment('PROCESSING'))

    const result = await useCase.execute({
      eventId:   EVENT_ID,
      paymentId: PaymentId.of(PAYMENT_ID),
      newStatus: 'AUTHORIZED',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.previousStatus).toBe('PROCESSING')
    expect(result.value.newStatus).toBe('AUTHORIZED')
    expect(result.value.idempotent).toBe(false)

    // Payment atualizado
    const updated = await uow.payments.findById(PaymentId.of(PAYMENT_ID))
    expect(updated?.status).toBe('AUTHORIZED')

    // OutboxEvent emitido
    const events = uow.outbox.ofType('PAYMENT_AUTHORIZED')
    expect(events).toHaveLength(1)
    expect(events[0]?.payload['paymentId']).toBe(PAYMENT_ID)
    expect(events[0]?.payload['eventId']).toBe(EVENT_ID)
  })

  it('é idempotente quando o pagamento já está no status alvo', async () => {
    const uow     = new InMemoryUnitOfWork()
    const useCase = new ProcessWebhookUseCase(uow)
    await uow.payments.save(makePayment('AUTHORIZED'))

    const result = await useCase.execute({
      eventId:   EVENT_ID,
      paymentId: PaymentId.of(PAYMENT_ID),
      newStatus: 'AUTHORIZED',  // já está AUTHORIZED
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.idempotent).toBe(true)

    // Nenhum outbox event emitido — não houve mudança de estado
    expect(uow.outbox.count()).toBe(0)
  })

  it('retorna NotFoundError se o pagamento não existe', async () => {
    const uow     = new InMemoryUnitOfWork()  // vazio
    const useCase = new ProcessWebhookUseCase(uow)

    const result = await useCase.execute({
      eventId:   EVENT_ID,
      paymentId: PaymentId.of(PAYMENT_ID),
      newStatus: 'AUTHORIZED',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('NOT_FOUND')
  })

  it('retorna BusinessRuleError em transição inválida pela state machine', async () => {
    const uow     = new InMemoryUnitOfWork()
    const useCase = new ProcessWebhookUseCase(uow)
    await uow.payments.save(makePayment('REFUNDED'))  // estado terminal

    const result = await useCase.execute({
      eventId:   EVENT_ID,
      paymentId: PaymentId.of(PAYMENT_ID),
      newStatus: 'AUTHORIZED',  // REFUNDED → AUTHORIZED é inválido
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('BUSINESS_RULE_ERROR')

    // Nenhum outbox event emitido
    expect(uow.outbox.count()).toBe(0)
  })

  it('repassa metadata para a transição quando fornecido', async () => {
    const uow     = new InMemoryUnitOfWork()
    const useCase = new ProcessWebhookUseCase(uow)
    await uow.payments.save(makePayment('PROCESSING'))

    const result = await useCase.execute({
      eventId:   EVENT_ID,
      paymentId: PaymentId.of(PAYMENT_ID),
      newStatus: 'FAILED',
      metadata:  { errorCode: 'CARD_DECLINED', errorMessage: 'Card declined' },
    })

    expect(result.ok).toBe(true)
    const updated = await uow.payments.findById(PaymentId.of(PAYMENT_ID))
    expect(updated?.status).toBe('FAILED')
    expect(updated?.errorCode).toBe('CARD_DECLINED')
  })

  it('race condition: SELECT FOR UPDATE garante exclusividade (simulado em memória)', async () => {
    const uow     = new InMemoryUnitOfWork()
    const useCase = new ProcessWebhookUseCase(uow)
    await uow.payments.save(makePayment('PROCESSING'))

    // Dois eventos concorrentes para o mesmo pagamento
    const [r1, r2] = await Promise.all([
      useCase.execute({ eventId: 'evt-001', paymentId: PaymentId.of(PAYMENT_ID), newStatus: 'AUTHORIZED' }),
      useCase.execute({ eventId: 'evt-002', paymentId: PaymentId.of(PAYMENT_ID), newStatus: 'AUTHORIZED' }),
    ])

    // Ambos devem retornar ok (um processa, o outro é idempotente)
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)

    // Payment no estado final correto
    const final = await uow.payments.findById(PaymentId.of(PAYMENT_ID))
    expect(final?.status).toBe('AUTHORIZED')
  })
})
