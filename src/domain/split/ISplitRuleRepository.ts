import type { SellerId, SplitRuleId } from '../shared/types'
import type { SplitRule } from './SplitRule'

/**
 * Contrato do repositório de split rules.
 *
 * Definido no domínio — sem qualquer referência a Knex ou infraestrutura.
 * Injetado diretamente nos use cases e workers que precisam consultar
 * a comissão ativa de um seller (não faz parte do IUnitOfWork porque
 * split rules são configuração, não dados transacionais de pagamento).
 */
export interface ISplitRuleRepository {
  /** Persiste uma nova split rule (INSERT). */
  save(rule: SplitRule): Promise<void>

  findById(id: SplitRuleId): Promise<SplitRule | null>

  /**
   * Retorna a split rule ativa para um seller.
   *
   * Usado pelo PaymentWorker após capture para calcular o split antes
   * de emitir PAYMENT_CAPTURED com platformAmountCents e sellerAmountCents.
   *
   * Retorna null se não houver regra ativa — o chamador deve tratar
   * como UnrecoverableError pois a captura no gateway já ocorreu.
   */
  findActiveBySellerId(sellerId: SellerId): Promise<SplitRule | null>
}
