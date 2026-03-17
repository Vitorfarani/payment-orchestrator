import type { Knex } from 'knex'
import type { ISettlementRepository } from '../../../domain/settlement/ISettlementRepository'
import { SettlementItem } from '../../../domain/settlement/SettlementItem'
import type { SettlementStatus } from '../../../domain/settlement/SettlementItem'
import { Cents, PaymentId, SellerId, SettlementItemId } from '../../../domain/shared/types'

/**
 * scheduled_date é DATE no PostgreSQL — node-postgres retorna como string (YYYY-MM-DD)
 * por padrão (sem pg.types.setTypeParser para o OID 1082).
 * amount_cents é BIGINT → string.
 */
interface SettlementItemRow {
  id:             string
  payment_id:     string
  seller_id:      string
  amount_cents:   string         // BIGINT → node-postgres retorna string
  scheduled_date: string         // DATE → node-postgres retorna string (YYYY-MM-DD)
  status:         SettlementStatus
  created_at:     Date
  updated_at:     Date
}

function rowToItem(row: SettlementItemRow): SettlementItem {
  return SettlementItem.reconstitute({
    id:            SettlementItemId.of(row.id),
    paymentId:     PaymentId.of(row.payment_id),
    sellerId:      SellerId.of(row.seller_id),
    amountCents:   Cents.of(Number(row.amount_cents)),
    scheduledDate: new Date(row.scheduled_date),
    status:        row.status,
    createdAt:     row.created_at,
    updatedAt:     row.updated_at,
  })
}

/**
 * Implementação PostgreSQL do ISettlementRepository (ADR-011).
 *
 * findDueItems usa o índice parcial idx_settlement_pending (WHERE status = 'PENDING')
 * para eficiência no polling diário do SettlementWorker.
 *
 * findByIdForUpdate usa SELECT FOR UPDATE para exclusividade quando
 * múltiplas instâncias do SettlementWorker estão rodando (ADR-012).
 */
export class PostgresSettlementRepository implements ISettlementRepository {
  constructor(private readonly db: Knex) {}

  async save(item: SettlementItem): Promise<void> {
    await this.db('settlement_items').insert({
      id:             item.id,
      payment_id:     item.paymentId,
      seller_id:      item.sellerId,
      amount_cents:   item.amountCents,
      scheduled_date: item.scheduledDate,
      status:         item.status,
      created_at:     item.createdAt,
      updated_at:     item.updatedAt,
    })
  }

  async update(item: SettlementItem): Promise<void> {
    await this.db('settlement_items').where({ id: item.id }).update({
      status:     item.status,
      updated_at: item.updatedAt,
    })
  }

  async findById(id: SettlementItemId): Promise<SettlementItem | null> {
    const row = await this.db<SettlementItemRow>('settlement_items').where({ id }).first()
    return row ? rowToItem(row) : null
  }

  async findByPaymentId(paymentId: PaymentId): Promise<SettlementItem | null> {
    const row = await this.db<SettlementItemRow>('settlement_items').where({ payment_id: paymentId }).first()
    return row ? rowToItem(row) : null
  }

  async findDueItems(asOf: Date): Promise<SettlementItem[]> {
    const rows = await this.db<SettlementItemRow>('settlement_items')
      .where({ status: 'PENDING' })
      .where('scheduled_date', '<=', asOf)
      .orderBy('scheduled_date', 'asc')
    return rows.map(rowToItem)
  }

  async findByIdForUpdate(id: SettlementItemId): Promise<SettlementItem | null> {
    const row = await this.db<SettlementItemRow>('settlement_items')
      .where({ id })
      .forUpdate()
      .first()
    return row ? rowToItem(row) : null
  }

  async findBySellerAndStatus(sellerId: SellerId, status: SettlementStatus): Promise<SettlementItem[]> {
    const rows = await this.db<SettlementItemRow>('settlement_items').where({ seller_id: sellerId, status })
    return rows.map(rowToItem)
  }
}
