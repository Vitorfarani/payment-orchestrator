import type { SellerId, CommissionRate, SplitRuleId } from '../shared/types'

interface SplitRuleProps {
  readonly id:             SplitRuleId
  readonly sellerId:       SellerId
  readonly commissionRate: CommissionRate
  readonly active:         boolean
  readonly createdAt:      Date
  readonly updatedAt:      Date
}

interface CreateSplitRuleInput {
  readonly id:             SplitRuleId
  readonly sellerId:       SellerId
  readonly commissionRate: CommissionRate
  readonly active?:        boolean
}

/**
 * Regra de split para um vendedor.
 *
 * Define a taxa de comissão percentual da plataforma sobre cada pagamento
 * capturado. Apenas comissão percentual é suportada — sem flat fee.
 *
 * Imutável após criação. Alterações (ex: desativar) requerem
 * reconstitution com os novos valores via repositório.
 */
export interface ReconstituteSplitRuleInput {
  readonly id:             SplitRuleId
  readonly sellerId:       SellerId
  readonly commissionRate: CommissionRate
  readonly active:         boolean
  readonly createdAt:      Date
  readonly updatedAt:      Date
}

export class SplitRule {
  private constructor(private readonly props: SplitRuleProps) {}

  get id():             SplitRuleId    { return this.props.id }
  get sellerId():       SellerId       { return this.props.sellerId }
  get commissionRate(): CommissionRate { return this.props.commissionRate }
  get active():         boolean        { return this.props.active }
  get createdAt():      Date           { return this.props.createdAt }
  get updatedAt():      Date           { return this.props.updatedAt }

  /**
   * Cria uma nova SplitRule. `active` é true por padrão.
   *
   * Não retorna Result porque não há invariante de domínio que possa falhar
   * além do que os Branded Types já garantem em compile-time (CommissionRate
   * valida 0..1 no construtor do tipo).
   */
  static create(input: CreateSplitRuleInput): SplitRule {
    const now = new Date()
    return new SplitRule({
      id:             input.id,
      sellerId:       input.sellerId,
      commissionRate: input.commissionRate,
      active:         input.active ?? true,
      createdAt:      now,
      updatedAt:      now,
    })
  }

  /** Rehidrata a entidade a partir de uma linha do banco. Não gera eventos. */
  static reconstitute(input: ReconstituteSplitRuleInput): SplitRule {
    return new SplitRule({ ...input })
  }
}
