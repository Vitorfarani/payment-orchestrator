import { ScheduleSettlementUseCase }     from '../../../src/application/settlement/ScheduleSettlementUseCase'
import { InMemoryUnitOfWork }            from '../fakes/InMemoryUnitOfWork'
import { InMemorySettlementRepository }  from '../fakes/InMemorySettlementRepository'
import { PaymentId, SellerId, Cents }    from '../../../src/domain/shared/types'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PAYMENT_ID = '11111111-1111-4111-8111-111111111111'
const SELLER_ID  = '22222222-2222-4222-8222-222222222222'

function makeInput(overrides: Partial<Parameters<ScheduleSettlementUseCase['execute']>[0]> = {}) {
  return {
    paymentId:         PaymentId.of(PAYMENT_ID),
    sellerId:          SellerId.of(SELLER_ID),
    sellerAmountCents: Cents.of(9_000),
    capturedAt:        new Date('2026-01-01T12:00:00Z'),
    ...overrides,
  }
}

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('ScheduleSettlementUseCase', () => {
  it('cria SettlementItem com status PENDING e data calculada pelo SettlementScheduler', async () => {
    const uow            = new InMemoryUnitOfWork()
    const settlementRepo = new InMemorySettlementRepository()
    const useCase        = new ScheduleSettlementUseCase(uow, settlementRepo)

    const result = await useCase.execute(makeInput())

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.settlementItemId).toBeDefined()

    // Item salvo no repositório com status PENDING
    const saved = uow.settlements.all()
    expect(saved).toHaveLength(1)
    expect(saved[0]?.status).toBe('PENDING')
    expect(saved[0]?.sellerId).toBe(SellerId.of(SELLER_ID))
    expect(saved[0]?.amountCents).toBe(Cents.of(9_000))

    // Data de liquidação é D+14 (padrão para novos vendedores — ADR-011)
    const expectedDate = new Date('2026-01-01T12:00:00Z')
    expectedDate.setUTCDate(expectedDate.getUTCDate() + 14)
    expectedDate.setUTCHours(0, 0, 0, 0)
    expect(result.value.scheduledDate.getTime()).toBe(expectedDate.getTime())
  })

  it('retorna ConflictError se já existe settlement para o mesmo paymentId', async () => {
    const uow            = new InMemoryUnitOfWork()
    const settlementRepo = new InMemorySettlementRepository()
    const useCase        = new ScheduleSettlementUseCase(uow, settlementRepo)

    // Primeiro agendamento
    const r1 = await useCase.execute(makeInput())
    expect(r1.ok).toBe(true)

    // Copia o item criado para o settlementRepo standalone (simula o banco)
    if (r1.ok) {
      const item = uow.settlements.all()[0]
      if (item) await settlementRepo.save(item)
    }

    // Segundo agendamento para o mesmo paymentId
    const r2 = await useCase.execute(makeInput())
    expect(r2.ok).toBe(false)
    if (r2.ok) return
    expect(r2.error.code).toBe('CONFLICT')
  })

  it('não cria settlement quando há ConflictError (nada persistido)', async () => {
    const uow            = new InMemoryUnitOfWork()
    const settlementRepo = new InMemorySettlementRepository()
    const useCase        = new ScheduleSettlementUseCase(uow, settlementRepo)

    // Simula que já existe um item para o paymentId no repo standalone
    const r1 = await useCase.execute(makeInput())
    if (r1.ok) {
      const item = uow.settlements.all()[0]
      if (item) await settlementRepo.save(item)
    }

    const uow2    = new InMemoryUnitOfWork()
    const useCase2 = new ScheduleSettlementUseCase(uow2, settlementRepo)
    await useCase2.execute(makeInput())

    // Nenhum item adicional criado
    expect(uow2.settlements.count()).toBe(0)
  })

  it('retorna ValidationError se sellerAmountCents é zero', async () => {
    const uow            = new InMemoryUnitOfWork()
    const settlementRepo = new InMemorySettlementRepository()
    const useCase        = new ScheduleSettlementUseCase(uow, settlementRepo)

    const result = await useCase.execute(makeInput({ sellerAmountCents: Cents.of(0) }))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_ERROR')
    expect(uow.settlements.count()).toBe(0)
  })
})
