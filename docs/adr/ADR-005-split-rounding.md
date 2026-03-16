# ADR-005: Estratégia de arredondamento no split de pagamentos

## Metadados

| Campo | Valor |
|---|---|
| **ID** | ADR-005 |
| **Título** | Estratégia de arredondamento no split de pagamentos |
| **Status** | `accepted` |
| **Data** | 2025-01-01 |
| **Contextos afetados** | SplitContext, LedgerContext |
| **Depende de** | ADR-001 (Cents) |
| **Bloqueia** | SplitCalculator, RecordDoubleEntryUseCase |

---

## Contexto

Quando um pagamento é dividido entre plataforma e vendedor usando uma taxa percentual, o resultado quase nunca é um número inteiro de centavos. Trabalhar com inteiros (ADR-001) resolve os erros de ponto flutuante, mas cria um novo problema: o que fazer com o centavo que sobra?

Exemplo concreto com comissão de 8%:

```
Pagamento: R$ 10,01 = 1001 centavos
Comissão 8%: 1001 × 0.08 = 80.08 centavos

Opção A: Math.floor(80.08) = 80 centavos → plataforma
         1001 - 80 = 921 centavos → vendedor
         Soma: 80 + 921 = 1001 ✓

Opção B: Math.round(80.08) = 80 centavos → igual ao floor neste caso
         Mas com 1001 × 0.085 = 85.085 → Math.round = 85, Math.floor = 85

Opção C: Math.ceil(80.08) = 81 centavos → plataforma
         1001 - 81 = 920 centavos → vendedor
         Soma: 81 + 920 = 1001 ✓
```

A questão não é matemática — é de negócio: **quem fica com o centavo que sobra?**

Isso parece trivial para uma transação. Mas em um marketplace com 100.000 transações por mês, a escolha de arredondamento acumula dinheiro sistematicamente para uma das partes. Isso precisa ser uma decisão explícita e documentada, não um comportamento acidental do `Math.round`.

**Edge case adicional: splits múltiplos**

Quando um pagamento é dividido entre mais de duas partes (ex: plataforma + dois vendedores em um pedido multi-seller), o problema se multiplica. Arredondar cada parte individualmente pode resultar em soma diferente do total:

```
Total: 1000 centavos
Parte A: 33.33% = 333.33 → floor = 333
Parte B: 33.33% = 333.33 → floor = 333
Parte C: 33.33% = 333.33 → floor = 333
Soma: 333 + 333 + 333 = 999 ≠ 1000  ← 1 centavo desapareceu
```

---

## Decisão

Adotaremos a estratégia **"truncate and assign remainder"**:

1. Calcular a comissão da plataforma com `Math.floor` (truncar para baixo)
2. O vendedor recebe `total - comissão_plataforma` — matematicamente, o resto
3. O centavo que sobra **sempre vai para o vendedor**

Para splits múltiplos (multi-seller):
1. Calcular cada parte com `Math.floor`
2. Somar todas as partes calculadas
3. O remainder (`total - soma_das_partes`) vai para a **última parte na lista** (geralmente o vendedor principal)

**Justificativa de negócio:** a plataforma sempre recebe um valor conservador (floor). O vendedor, que é o parceiro da plataforma, fica com qualquer fração não alocada. Essa escolha é favorável ao relacionamento com vendedores e é a convenção mais comum em marketplaces.

```typescript
function calculateSplit(
  totalCents: Cents,
  commissionRate: CommissionRate
): SplitResult {
  const platformCents = Cents.of(Math.floor(totalCents * commissionRate))
  const sellerCents   = Cents.of(totalCents - platformCents)
  // sellerCents inclui automaticamente qualquer fração não alocada

  // Invariante: deve sempre fechar
  assert(platformCents + sellerCents === totalCents)

  return { platform: platformCents, seller: sellerCents }
}
```

---

## Alternativas consideradas

### Alternativa 1: Banker's Rounding (arredondamento do banqueiro)

Arredondar para o par mais próximo quando o dígito é exatamente 5 (ex: 80.5 → 80, 81.5 → 82).

**Prós:** estatisticamente neutro em grandes volumes — não favorece sistematicamente nenhuma parte.
**Contras:** comportamento não-intuitivo para desenvolvedores, difícil de explicar para vendedores, e o problema do "centavo desaparecido" em multi-seller ainda existe.
**Por que descartada:** a complexidade não compensa. Em um marketplace, a diferença estatística entre floor e banker's rounding em grandes volumes é negligenciável. A simplicidade do floor + remainder é superior.

### Alternativa 2: Plataforma absorve o remainder (ceil para plataforma)

Plataforma recebe `Math.ceil(total × rate)` e vendedor recebe o resto.

**Prós:** plataforma maximiza receita.
**Contras:** favorece sistematicamente a plataforma. Em 100k transações com 8% de comissão, a plataforma pode acumular centenas de reais de centavos "extras". Em auditoria, isso pode ser questionado.
**Por que descartada:** a decisão de quem fica com o centavo deve beneficiar o parceiro (vendedor), não a plataforma. É uma questão de relacionamento comercial, não só matemática.

### Alternativa 3: Armazenar frações e liquidar depois

Armazenar os valores fracionários como `DECIMAL` e liquidar quando atingir 1 centavo inteiro.

**Prós:** matematicamente perfeito, nenhuma fração é perdida.
**Contras:** viola ADR-001 (sem decimais). Complexidade de implementação muito alta. Cria saldo em "frações de centavo" que precisam ser rastreados por vendedor — novo conceito no domínio.
**Por que descartada:** YAGNI e violação de ADR-001. O valor acumulado de frações de centavo é irrelevante financeiramente para o escopo deste projeto.

---

## Consequências

### Positivas
- Implementação simples — `Math.floor` + subtração.
- Comportamento previsível e explicável para vendedores.
- A invariante `platform + seller === total` é sempre verdadeira por construção.
- Multi-seller funciona com o mesmo princípio sem casos especiais.

### Negativas / Trade-offs
- A plataforma sistematicamente recebe o floor — em volumes muito altos, poderia receber ligeiramente menos que o percentual exato.
- Isso é intencional e documentado aqui — não é um bug.

### Riscos e mitigações
- **Risco:** implementação usa `Math.round` ou operação diferente por engano.
  **Mitigação:** `SplitCalculator` é a única função que calcula splits — não existe cálculo de split em outro lugar. Testes unitários cobrem especificamente os edge cases de arredondamento com valores que geram frações.

- **Risco:** a invariante `sum === total` não é verificada e passa despercebida.
  **Mitigação:** `SplitCalculator.calculate()` inclui um `assert` interno. Se a invariante falhar por qualquer motivo, é um erro imediato — não um dado silenciosamente errado.

---

## Implementação

```typescript
// src/domain/split/SplitCalculator.ts

import { Cents, CommissionRate } from '../shared/types'
import { ok, Result } from '../shared/Result'
import { BusinessRuleError } from '../shared/errors'

export interface SplitResult {
  readonly platform: Cents
  readonly seller:   Cents
  readonly total:    Cents
  readonly rate:     CommissionRate
}

export interface MultiSplitPart {
  readonly recipientId: string
  readonly rate: CommissionRate
}

export interface MultiSplitResult {
  readonly parts: ReadonlyArray<{ recipientId: string; amount: Cents }>
  readonly total: Cents
}

export class SplitCalculator {

  static calculate(
    total: Cents,
    commissionRate: CommissionRate
  ): Result<SplitResult, BusinessRuleError> {

    if (total <= 0) {
      return { ok: false, error: new BusinessRuleError('Split total must be positive') }
    }

    // Estratégia: floor para plataforma, resto para o vendedor.
    // O vendedor recebe qualquer fração não alocada (ADR-005).
    const platform = Cents.of(Math.floor(total * commissionRate))
    const seller   = Cents.of(total - platform)

    // Invariante: deve sempre fechar. Se falhar, é bug crítico.
    if (platform + seller !== total) {
      throw new Error(
        `Split invariant violated: ${platform} + ${seller} !== ${total}. ` +
        `This is a bug in SplitCalculator.`
      )
    }

    return ok({ platform, seller, total, rate: commissionRate })
  }

  // Para splits com múltiplos destinatários (multi-seller)
  static calculateMulti(
    total: Cents,
    parts: MultiSplitPart[]
  ): Result<MultiSplitResult, BusinessRuleError> {

    if (parts.length === 0) {
      return { ok: false, error: new BusinessRuleError('Split must have at least one part') }
    }

    const totalRate = parts.reduce((sum, p) => sum + p.rate, 0)
    if (totalRate > 1.0001) { // tolerância mínima para float
      return { ok: false, error: new BusinessRuleError(`Split rates sum to ${totalRate}, must be ≤ 1.0`) }
    }

    // Calcular cada parte com floor
    const calculated = parts.map(part => ({
      recipientId: part.recipientId,
      amount: Cents.of(Math.floor(total * part.rate))
    }))

    // O remainder vai para o último destinatário (convencionalmente o vendedor principal)
    const sumCalculated = calculated.reduce((s, p) => s + p.amount, 0)
    const remainder     = Cents.of(total - sumCalculated)

    if (remainder > 0 && calculated.length > 0) {
      const last = calculated[calculated.length - 1]!
      calculated[calculated.length - 1] = {
        ...last,
        amount: Cents.of(last.amount + remainder)
      }
    }

    // Verificação final da invariante
    const finalSum = calculated.reduce((s, p) => s + p.amount, 0)
    if (finalSum !== total) {
      throw new Error(`MultiSplit invariant violated: ${finalSum} !== ${total}`)
    }

    return ok({ parts: calculated, total })
  }
}
```

```typescript
// Testes que cobrem os edge cases críticos de arredondamento
// src/domain/split/SplitCalculator.test.ts

describe('SplitCalculator', () => {
  it('floor para plataforma, resto para vendedor', () => {
    // 1001 × 0.08 = 80.08 → floor = 80, vendedor = 921
    const result = SplitCalculator.calculate(Cents.of(1001), CommissionRate.of(0.08))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.platform).toBe(80)
    expect(result.value.seller).toBe(921)
    expect(result.value.platform + result.value.seller).toBe(1001) // invariante
  })

  it('soma de multi-split sempre iguala o total', () => {
    // 1000 ÷ 3 = 333.33... cada → floor = 333, soma = 999, remainder = 1 vai para o último
    const result = SplitCalculator.calculateMulti(Cents.of(1000), [
      { recipientId: 'A', rate: CommissionRate.of(0.3333) },
      { recipientId: 'B', rate: CommissionRate.of(0.3333) },
      { recipientId: 'C', rate: CommissionRate.of(0.3334) },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const sum = result.value.parts.reduce((s, p) => s + p.amount, 0)
    expect(sum).toBe(1000) // nunca perde centavo
  })
})
```

**Arquivos:**
- `src/domain/split/SplitCalculator.ts`
- `src/domain/split/SplitCalculator.test.ts`
