import { Cents } from '../shared/types'
import type { CommissionRate } from '../shared/types'
import type { Result } from '../shared/Result'
import { ok, err } from '../shared/Result'
import { BusinessRuleError } from '../shared/errors'

export interface SplitResult {
  readonly platform: Cents
  readonly seller:   Cents
  readonly total:    Cents
  readonly rate:     CommissionRate
}

export interface MultiSplitPart {
  readonly recipientId: string
  readonly rate:        CommissionRate
}

export interface MultiSplitResult {
  readonly parts: ReadonlyArray<{ recipientId: string; amount: Cents }>
  readonly total: Cents
}

export class SplitCalculator {
  // Split simples: plataforma recebe Math.floor, vendedor recebe o resto.
  // O centavo que sobra vai sempre para o vendedor (ADR-005).
  static calculate(
    total:          Cents,
    commissionRate: CommissionRate,
  ): Result<SplitResult, BusinessRuleError> {
    if (total <= 0) {
      return err(new BusinessRuleError('O total do split deve ser positivo'))
    }

    const platform = Cents.of(Math.floor(total * commissionRate))
    const seller   = Cents.of(total - platform)

    // Invariante por construção — seller = total - platform, matematicamente impossível falhar
    /* istanbul ignore next */
    if (platform + seller !== total) {
      throw new Error(
        `Split invariant violated: ${platform} + ${seller} !== ${total}. Bug em SplitCalculator.`
      )
    }

    return ok({ platform, seller, total, rate: commissionRate })
  }

  // Split múltiplo: cada parte recebe Math.floor, remainder vai para o último.
  // Garante que sum(parts) === total sempre (ADR-005).
  static calculateMulti(
    total: Cents,
    parts: MultiSplitPart[],
  ): Result<MultiSplitResult, BusinessRuleError> {
    if (parts.length === 0) {
      return err(new BusinessRuleError('O split requer pelo menos uma parte'))
    }

    let totalRate = 0
    for (const part of parts) {
      totalRate += part.rate
    }
    if (totalRate > 1.0001) {
      return err(new BusinessRuleError(
        `A soma das rates (${totalRate.toFixed(4)}) não pode ultrapassar 1.0`
      ))
    }

    const allocated: Array<{ recipientId: string; amount: Cents }> = []
    for (const part of parts) {
      allocated.push({
        recipientId: part.recipientId,
        amount:      Cents.of(Math.floor(total * part.rate)),
      })
    }

    let allocatedSum = 0
    for (const a of allocated) {
      allocatedSum += a.amount
    }

    // Remainder vai para o último destinatário (ADR-005)
    const remainder  = total - allocatedSum
    const lastIndex  = allocated.length - 1
    const lastEntry  = allocated[lastIndex]
    if (lastEntry !== undefined && remainder > 0) {
      allocated[lastIndex] = {
        ...lastEntry,
        amount: Cents.of(lastEntry.amount + remainder),
      }
    }

    // Verificação final da invariante — remainder garante o fechamento por construção
    let finalSum = 0
    for (const a of allocated) {
      finalSum += a.amount
    }
    /* istanbul ignore next */
    if (finalSum !== total) {
      throw new Error(
        `MultiSplit invariant violated: ${finalSum} !== ${total}. Bug em SplitCalculator.`
      )
    }

    return ok({ parts: allocated, total })
  }
}
