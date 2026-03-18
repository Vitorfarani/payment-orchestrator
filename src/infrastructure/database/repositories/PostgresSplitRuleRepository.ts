import type { Knex } from 'knex'
import type { ISplitRuleRepository } from '../../../domain/split/ISplitRuleRepository'
import type { SellerId, SplitRuleId } from '../../../domain/shared/types'
import { CommissionRate, SplitRuleId as SplitRuleIdNS, SellerId as SellerIdNS } from '../../../domain/shared/types'
import { SplitRule } from '../../../domain/split/SplitRule'
import type { ReconstituteSplitRuleInput } from '../../../domain/split/SplitRule'

/**
 * Linha retornada pelo driver pg para a tabela split_rules.
 *
 * Nota crítica: commission_rate é DECIMAL(5,4) no PostgreSQL.
 * O driver `pg` retorna DECIMAL/NUMERIC como string para preservar precisão
 * (ex: 0.1500 → "0.1500"). A conversão para number ocorre em rowToInput()
 * via parseFloat() + CommissionRate.of().
 */
interface SplitRuleRow {
  readonly id:              string
  readonly seller_id:       string
  readonly commission_rate: string
  readonly active:          boolean
  readonly created_at:      Date
  readonly updated_at:      Date
}

/**
 * Tipo usado exclusivamente no INSERT.
 * commission_rate é enviado como number — o pg converte para DECIMAL(5,4).
 */
interface SplitRuleInsertRow {
  readonly id:              string
  readonly seller_id:       string
  readonly commission_rate: number
  readonly active:          boolean
  readonly created_at:      Date
  readonly updated_at:      Date
}

function rowToInput(row: SplitRuleRow): ReconstituteSplitRuleInput {
  return {
    id:             SplitRuleIdNS.of(row.id),
    sellerId:       SellerIdNS.of(row.seller_id),
    commissionRate: CommissionRate.of(parseFloat(row.commission_rate)),
    active:         row.active,
    createdAt:      new Date(row.created_at),
    updatedAt:      new Date(row.updated_at),
  }
}

export class PostgresSplitRuleRepository implements ISplitRuleRepository {
  constructor(private readonly db: Knex) {}

  async save(rule: SplitRule): Promise<void> {
    await this.db<SplitRuleInsertRow>('split_rules').insert({
      id:              rule.id,
      seller_id:       rule.sellerId,
      commission_rate: rule.commissionRate,
      active:          rule.active,
      created_at:      rule.createdAt,
      updated_at:      rule.updatedAt,
    })
  }

  async findById(id: SplitRuleId): Promise<SplitRule | null> {
    const row = await this.db<SplitRuleRow>('split_rules')
      .select('*')
      .where('id', id)
      .first()

    return row !== undefined ? SplitRule.reconstitute(rowToInput(row)) : null
  }

  async findActiveBySellerId(sellerId: SellerId): Promise<SplitRule | null> {
    const row = await this.db<SplitRuleRow>('split_rules')
      .select('*')
      .where({ seller_id: sellerId, active: true })
      .first()

    return row !== undefined ? SplitRule.reconstitute(rowToInput(row)) : null
  }
}
