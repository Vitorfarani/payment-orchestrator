# ADR-001: Representação de valores monetários como inteiros (centavos)

## Metadados

| Campo | Valor |
|---|---|
| **ID** | ADR-001 |
| **Título** | Representação de valores monetários como inteiros (centavos) |
| **Status** | `accepted` |
| **Data** | 2025-01-01 |
| **Contextos afetados** | PaymentContext, LedgerContext, SplitContext, SettlementContext |

---

## Contexto

Todo o sistema lida com valores monetários. A escolha de como representar esses valores afeta a correção de todos os cálculos financeiros, a integridade do ledger e a confiabilidade do split entre plataforma e vendedores.

Sistemas financeiros que usam `float` ou `double` sofrem de erros de arredondamento acumulados que podem resultar em diferenças de centavos entre o que o gateway processou e o que o ledger registrou. Em um marketplace com alto volume, essas diferenças se acumulam e criam discrepâncias contábeis reais.

```javascript
// Demonstração do problema com ponto flutuante
0.1 + 0.2 === 0.3          // false
0.1 + 0.2                  // 0.30000000000000004
100.10 * 100               // 10009.999999999998 (não 10010.00)
```

Em um split de R$ 100,10 com comissão de 8%, o resultado correto é:
- Plataforma: R$ 8,00 (800 centavos)
- Vendedor: R$ 92,10 (9210 centavos)

Com float, o resultado pode ser ligeiramente diferente e variar por plataforma/runtime.

---

## Decisão

**Todos os valores monetários são armazenados e manipulados como inteiros representando a menor unidade da moeda** (centavos para BRL/USD, sen para JPY, etc.).

- No banco de dados: `BIGINT NOT NULL` — nunca `DECIMAL`, `NUMERIC`, `FLOAT` ou `DOUBLE`
- Na aplicação TypeScript: `Cents` Branded Type sobre `number`
- Na API (entrada/saída): inteiros em centavos. A serialização para display (`R$ 92,10`) é responsabilidade exclusiva da camada de apresentação
- Nunca usar `parseFloat`, `toFixed` ou divisão em cálculos de negócio

```typescript
// Value Object no domínio
declare const __brand: unique symbol;
type Brand<T, TBrand> = T & { readonly [__brand]: TBrand };

type Cents = Brand<number, 'Cents'>;

const Cents = {
  of: (value: number): Cents => {
    if (!Number.isInteger(value)) {
      throw new DomainError(`Cents must be an integer, got: ${value}`);
    }
    if (value < 0) {
      throw new DomainError(`Cents cannot be negative, got: ${value}`);
    }
    return value as Cents;
  },

  add: (a: Cents, b: Cents): Cents => Cents.of(a + b),

  // Multiplicação segura: arredonda para baixo, retorna o resto separado
  multiply: (amount: Cents, rate: number): { result: Cents; remainder: Cents } => {
    const raw = amount * rate;
    const result = Math.floor(raw);
    const remainder = amount - result; // o centavo que sobrou
    return {
      result: Cents.of(result),
      remainder: Cents.of(remainder),
    };
  },

  toDisplay: (cents: Cents, currency: 'BRL' | 'USD' = 'BRL'): string => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency,
    }).format(cents / 100);
  },
};

// Uso correto no split (ver também ADR-005)
const total = Cents.of(10010);           // R$ 100,10
const commissionRate = 0.08;             // 8%
const { result: platform, remainder } = Cents.multiply(total, commissionRate);
const seller = Cents.of(total - platform + remainder); // vendedor recebe o centavo que sobrou

// platform = 800   (R$ 8,00)
// seller   = 9210  (R$ 92,10) — 9200 + 10 de remainder
```

---

## Alternativas consideradas

### Alternativa 1: `DECIMAL(19, 4)` no banco + `string` na aplicação

**Prós**: representa frações de centavo (útil para câmbio), mais "natural" para valores monetários.
**Contras**: operações com `string` no TypeScript são trabalhosas. Requer biblioteca externa (`decimal.js`, `big.js`). Adds complexity sem benefício real para BRL/USD que não têm subdivisões menores que centavo.
**Por que descartada**: complexidade desnecessária. O sistema opera exclusivamente em BRL (e potencialmente USD), onde a menor unidade é o centavo.

### Alternativa 2: `NUMERIC` no banco + `Decimal.js` na aplicação

**Prós**: biblioteca madura, amplamente usada em Fintech Node.js.
**Contras**: dependência externa, serialização/deserialização entre `Decimal` e tipos nativos em todo lugar, overhead de performance.
**Por que descartada**: `BIGINT` + inteiros nativos é mais simples, mais rápido, e suficiente para o problema. Adicionar `Decimal.js` seria YAGNI.

### Alternativa 3: `FLOAT`/`DOUBLE` (o que não fazer)

**Prós**: conveniência aparente, sem conversão.
**Contras**: erros de arredondamento garantidos, discrepâncias contábeis em produção.
**Por que descartada**: inadequado para qualquer sistema financeiro. Esta alternativa existe apenas para documentar o que NÃO fazer.

---

## Consequências

### Positivas
- Aritmética exata — sem erros de arredondamento
- Comparações de igualdade funcionam corretamente (`===`)
- Operações de banco de dados (somas, médias) são exatas
- Branded Type previne confusão acidental com outros números em compile-time

### Negativas / Trade-offs
- A API sempre trabalha em centavos — requer documentação clara para integradores
- Exibição para o usuário requer conversão (`/ 100`) — centralizada em `Cents.toDisplay()`
- Cálculos com taxas percentuais geram frações que precisam de tratamento explícito (ver ADR-005)

### Riscos e mitigações
- **Risco**: desenvolvedores esquecerem de converter e exibirem "10010" em vez de "R$ 100,10"
  **Mitigação**: `Cents.toDisplay()` é o único ponto de conversão. Linting rule proíbe divisão direta de `Cents` por 100 fora desse método.

- **Risco**: overflow de `BIGINT` para valores muito grandes
  **Mitigação**: `BIGINT` do PostgreSQL suporta até ~9.2 × 10¹⁸ centavos. Isso equivale a ~92 petadólares por transação. Não é um risco prático.

---

## Implementação

- `src/domain/shared/value-objects/Cents.ts` — Value Object com todas as operações
- `src/domain/shared/value-objects/Money.ts` — combina `Cents` + `Currency`
- Migration: todas as colunas de valor monetário usam `BIGINT NOT NULL CHECK (column >= 0)`
- ESLint rule customizada: `no-float-money` — detecta literais float em contextos monetários
