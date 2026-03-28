import type { ISplitRuleRepository } from '../../domain/split/ISplitRuleRepository'
import type { Result } from '../../domain/shared/Result'
import type { DomainError } from '../../domain/shared/errors'
import type { SellerId, Cents } from '../../domain/shared/types'
import { err } from '../../domain/shared/Result'
import { BusinessRuleError } from '../../domain/shared/errors'
import { SplitCalculator } from '../../domain/split/SplitCalculator'

export interface CalculateSplitInput {
  readonly sellerId:    SellerId
  readonly amountCents: Cents
}

export interface CalculateSplitOutput {
  readonly platformAmountCents: Cents
  readonly sellerAmountCents:   Cents
  readonly totalCents:          Cents
}

/**
 * Calcula o split de um pagamento para um seller (ADR-005).
 *
 * Lookup da split rule ativa + SplitCalculator.calculate().
 * Usado pela camada web para preview e internamente por outros use cases.
 *
 * Leitura pura — não abre UoW, não persiste nada.
 */
export class CalculateSplitUseCase {
  constructor(private readonly splitRuleRepo: ISplitRuleRepository) {}

  async execute(
    input: CalculateSplitInput,
  ): Promise<Result<CalculateSplitOutput, DomainError>> {
    const splitRule = await this.splitRuleRepo.findActiveBySellerId(input.sellerId)
    if (splitRule === null) {
      return err(new BusinessRuleError(
        `Nenhuma split rule ativa para o seller ${input.sellerId}`
      ))
    }

    const splitResult = SplitCalculator.calculate(input.amountCents, splitRule.commissionRate)
    if (!splitResult.ok) return splitResult

    return {
      ok:    true,
      value: {
        platformAmountCents: splitResult.value.platform,
        sellerAmountCents:   splitResult.value.seller,
        totalCents:          splitResult.value.total,
      },
    }
  }
}
