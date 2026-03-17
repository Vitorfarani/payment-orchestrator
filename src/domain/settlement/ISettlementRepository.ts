import type { PaymentId, SellerId, SettlementItemId } from '../shared/types'
import type { SettlementItem, SettlementStatus } from './SettlementItem'

/**
 * Contrato do repositório de settlement items.
 *
 * Definido no domínio — sem qualquer referência a Knex ou infraestrutura.
 * A implementação concreta fica em infrastructure/database/repositories/.
 *
 * Com IUnitOfWork (Option B), os métodos não recebem `trx` diretamente —
 * o repositório é construído já escoped à transação ativa.
 */
export interface ISettlementRepository {
  /**
   * Persiste novo settlement item (INSERT).
   * Deve ser chamado dentro de IUnitOfWork, na mesma transação que salva
   * o OutboxEvent correspondente (ADR-009).
   */
  save(item: SettlementItem): Promise<void>

  /**
   * Atualiza status e updatedAt do settlement item (UPDATE).
   * Usado após startProcessing(), complete() ou fail() no domínio.
   */
  update(item: SettlementItem): Promise<void>

  findById(id: SettlementItemId): Promise<SettlementItem | null>

  /**
   * Um pagamento gera exatamente um settlement item.
   * Usado pelo ScheduleSettlementUseCase para verificar duplicata.
   */
  findByPaymentId(paymentId: PaymentId): Promise<SettlementItem | null>

  /**
   * Busca itens com status PENDING cuja scheduledDate <= asOf.
   * Usado pelo SettlementWorker no processamento diário de payouts.
   * A implementação PostgreSQL usa o índice parcial idx_settlement_pending.
   */
  findDueItems(asOf: Date): Promise<SettlementItem[]>

  /**
   * Busca o item com lock exclusivo (SELECT FOR UPDATE).
   * Usado pelo SettlementWorker para evitar processamento duplicado
   * quando múltiplas instâncias estão rodando.
   * Deve ser chamado dentro de IUnitOfWork.
   */
  findByIdForUpdate(id: SettlementItemId): Promise<SettlementItem | null>

  /** Queries operacionais — ex: painel de vendedor, relatório de conciliação. */
  findBySellerAndStatus(sellerId: SellerId, status: SettlementStatus): Promise<SettlementItem[]>
}
