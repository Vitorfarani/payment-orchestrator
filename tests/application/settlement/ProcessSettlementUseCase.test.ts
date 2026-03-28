import { ProcessSettlementUseCase }      from '../../../src/application/settlement/ProcessSettlementUseCase'
import { InMemoryUnitOfWork }            from '../fakes/InMemoryUnitOfWork'
import { SettlementItem }                from '../../../src/domain/settlement/SettlementItem'
import { PaymentId, SellerId, Cents, SettlementItemId } from '../../../src/domain/shared/types'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PAYMENT_ID = '11111111-1111-4111-8111-111111111111'
const SELLER_ID  = '22222222-2222-4222-8222-222222222222'
const ITEM_ID    = '44444444-4444-4444-8444-444444444444'

function makeItem(status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' = 'PENDING') {
  return SettlementItem.reconstitute({
    id:            SettlementItemId.of(ITEM_ID),
    paymentId:     PaymentId.of(PAYMENT_ID),
    sellerId:      SellerId.of(SELLER_ID),
    amountCents:   Cents.of(9_000),
    scheduledDate: new Date('2026-01-15T00:00:00Z'),
    status,
    createdAt:     new Date(),
    updatedAt:     new Date(),
  })
}

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('ProcessSettlementUseCase', () => {
  it('transiciona PENDING → COMPLETED e emite SETTLEMENT_COMPLETED', async () => {
    const uow     = new InMemoryUnitOfWork()
    const useCase = new ProcessSettlementUseCase(uow)

    await uow.settlements.save(makeItem('PENDING'))

    const result = await useCase.execute({
      settlementItemId: SettlementItemId.of(ITEM_ID),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.settlementItemId).toBe(SettlementItemId.of(ITEM_ID))

    // Item atualizado para COMPLETED
    const updated = await uow.settlements.findById(SettlementItemId.of(ITEM_ID))
    expect(updated?.status).toBe('COMPLETED')

    // OutboxEvent emitido
    const events = uow.outbox.ofType('SETTLEMENT_COMPLETED')
    expect(events).toHaveLength(1)
    expect(events[0]?.payload['paymentId']).toBe(PAYMENT_ID)
    expect(events[0]?.payload['settlementItemId']).toBe(ITEM_ID)
  })

  it('é idempotente: item já COMPLETED retorna ok sem nova escrita', async () => {
    const uow     = new InMemoryUnitOfWork()
    const useCase = new ProcessSettlementUseCase(uow)

    await uow.settlements.save(makeItem('COMPLETED'))

    const result = await useCase.execute({
      settlementItemId: SettlementItemId.of(ITEM_ID),
    })

    expect(result.ok).toBe(true)
    // Nenhum novo outbox event emitido (item já estava COMPLETED)
    expect(uow.outbox.count()).toBe(0)
  })

  it('é idempotente: item já PROCESSING retorna ok sem nova escrita', async () => {
    const uow     = new InMemoryUnitOfWork()
    const useCase = new ProcessSettlementUseCase(uow)

    await uow.settlements.save(makeItem('PROCESSING'))

    const result = await useCase.execute({
      settlementItemId: SettlementItemId.of(ITEM_ID),
    })

    expect(result.ok).toBe(true)
    expect(uow.outbox.count()).toBe(0)
  })

  it('retorna NotFoundError se o item não existe', async () => {
    const uow     = new InMemoryUnitOfWork()
    const useCase = new ProcessSettlementUseCase(uow)

    const result = await useCase.execute({
      settlementItemId: SettlementItemId.of(ITEM_ID),
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('NOT_FOUND')
  })

  it('o payload do OutboxEvent contém todos os campos necessários', async () => {
    const uow     = new InMemoryUnitOfWork()
    const useCase = new ProcessSettlementUseCase(uow)
    await uow.settlements.save(makeItem('PENDING'))

    await useCase.execute({ settlementItemId: SettlementItemId.of(ITEM_ID) })

    const event = uow.outbox.ofType('SETTLEMENT_COMPLETED')[0]
    expect(event).toBeDefined()
    if (!event) return
    expect(event.payload).toMatchObject({
      settlementItemId: ITEM_ID,
      paymentId:        PAYMENT_ID,
      sellerId:         SELLER_ID,
      amountCents:      9_000,
    })
  })
})
