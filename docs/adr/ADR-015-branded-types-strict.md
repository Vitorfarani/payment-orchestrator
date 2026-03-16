# ADR-015: Branded Types e TypeScript strict como contrato do domínio financeiro

## Metadados

| Campo | Valor |
|---|---|
| **ID** | ADR-015 |
| **Título** | Branded Types e TypeScript strict como contrato do domínio financeiro |
| **Status** | `accepted` |
| **Data** | 2025-01-01 |
| **Contextos afetados** | Todos (decisão transversal) |
| **Depende de** | ADR-001 (Cents) |
| **Bloqueia** | Toda implementação de domínio |

---

## Contexto

TypeScript usa **structural typing**: dois tipos são compatíveis se têm a mesma estrutura, independente do nome. Isso é conveniente na maioria dos casos, mas em domínios financeiros cria uma categoria inteira de bugs silenciosos:

```typescript
// Sem branded types — o compilador aceita tudo isso sem reclamar:
function transfer(fromAccountId: string, toSellerId: string, amount: number): void {}

transfer(sellerId, accountId, -500)        // IDs invertidos + valor negativo ✓ compila
transfer(accountId, accountId, 0)          // mesmo ID nos dois lados ✓ compila
transfer('não-é-uuid', sellerId, amount)   // formato inválido ✓ compila
transfer(accountId, sellerId, 99.99)       // float em contexto de centavos ✓ compila
```

Nenhum desses erros é detectado pelo compilador. Todos chegam em produção.

O problema cresce com `strict: false` no `tsconfig.json`: `null` e `undefined` são assignáveis a qualquer tipo, `any` implícito aparece em funções sem anotação, e erros de lógica que o TypeScript poderia detectar passam silenciosamente.

Para um sistema financeiro onde um bug pode resultar em cobrança duplicada ou transferência incorreta, confiar no runtime para detectar esses erros é inaceitável.

---

## Decisão

**1. Branded Types para todos os identificadores e valores do domínio financeiro.**

Usaremos o padrão de Branded Types (também chamado de Nominal Types ou Opaque Types) para criar tipos distintos a partir de primitivos:

```typescript
// src/domain/shared/types.ts
declare const __brand: unique symbol
type Brand<T, B> = T & { readonly [__brand]: B }

// Identificadores — nunca intercambiáveis entre si
export type PaymentId    = Brand<string, 'PaymentId'>
export type SellerId     = Brand<string, 'SellerId'>
export type AccountId    = Brand<string, 'AccountId'>
export type JournalId    = Brand<string, 'JournalId'>
export type IdempotencyKey = Brand<string, 'IdempotencyKey'>

// Valores financeiros — ver ADR-001
export type Cents        = Brand<number, 'Cents'>
export type CommissionRate = Brand<number, 'CommissionRate'>  // 0..1

// Cada branded type tem seu construtor com validação
export const PaymentId = (id: string): PaymentId => {
  if (!isUUID(id)) throw new ValidationError(`Invalid PaymentId: ${id}`)
  return id as PaymentId
}
```

**2. `tsconfig.json` com todas as flags strict habilitadas.**

O projeto usará a configuração mais restrita possível do TypeScript:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "exactOptionalPropertyTypes": true,
    "noPropertyAccessFromIndexSignature": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

**3. ESLint complementa o que o compilador não alcança.**

Regras de lint customizadas para o domínio financeiro cobrem padrões que o TypeScript não verifica.

---

## Alternativas consideradas

### Alternativa 1: Classes para Value Objects em vez de Branded Types

Criar classes com validação no construtor: `class PaymentId { constructor(private value: string) {} }`.

**Prós:** encapsula comportamento junto com o tipo, mais familiar para desenvolvedores OO.
**Contras:** overhead de instanciação para cada ID, serialização/deserialização mais complexa (não é mais um `string` puro), comparações precisam de método `equals()`, JSON.stringify não funciona naturalmente.
**Por que descartada:** a maioria dos IDs é criada uma vez e passada adiante. Classes adicionam overhead sem benefício real para tipos que só precisam de identidade, não comportamento. Para Value Objects com comportamento real (`Money`, `Commission`), usamos classes — para IDs, branded types são suficientes.

### Alternativa 2: `strict: false` com type assertions manuais

Manter `strict: false` e usar `as` quando necessário.

**Prós:** menos atritos no início, código mais permissivo.
**Contras:** a maioria dos bugs que o strict mode previne (null dereference, implicit any, etc.) são exatamente os que aparecem em produção de madrugada. Em sistemas financeiros, essa permissividade é dívida técnica com juros altos.
**Por que descartada:** não é uma alternativa legítima para um sistema financeiro. O custo de ativar strict desde o início é zero comparado ao custo de encontrar bugs de null/undefined em produção.

### Alternativa 3: io-ts ou zod para validação em runtime

Usar bibliotecas de validação em runtime em vez de tipos em compile-time.

**Prós:** validação real dos dados (compile-time não valida valores externos como JSON de API).
**Contras:** são complementares, não substitutos. Runtime validation (Zod) é necessária nas fronteiras do sistema (entrada de API, webhooks). Branded types são necessários no interior do domínio.
**Por que descartada:** a decisão não é entre um e outro — usamos os dois. Zod na camada Web para validar entrada. Branded types no domínio para garantir contratos internos.

---

## Consequências

### Positivas
- Erros de inversão de IDs e valores incorretos são detectados em compile-time, não em produção.
- A assinatura de cada função é a documentação completa dos seus parâmetros.
- Refactoring é seguro: renomear um tipo ou mudar sua estrutura causa erros de compilação em todos os pontos de uso.
- `noUncheckedIndexedAccess` força o tratamento de `undefined` ao acessar arrays — elimina crashes de runtime em código de iteração.

### Negativas / Trade-offs
- Branded types têm um "custo de entrada": todo valor externo precisa passar pelo construtor (`PaymentId(req.params.id)`) antes de entrar no domínio.
- `exactOptionalPropertyTypes` e `noUncheckedIndexedAccess` podem gerar atrito com bibliotecas externas que não são strict-compliant. Nesses casos, usamos `// @ts-expect-error` localizado e documentado.
- Desenvolvedores novos no projeto precisam entender o padrão antes de contribuir — documentado no glossário e nos exemplos de código.

### Riscos e mitigações
- **Risco:** `as` usado para forçar tipos e contornar as garantias.
  **Mitigação:** ESLint rule `@typescript-eslint/no-explicit-any` + `no-type-assertion-in-domain` customizada. `as` é permitido apenas nos construtores dos branded types — em nenhum outro lugar do domínio.

- **Risco:** biblioteca externa não é strict-compliant e causa erros de compilação em cadeia.
  **Mitigação:** bibliotecas de terceiros ficam exclusivamente na camada `infrastructure/`. O domínio nunca importa de bibliotecas externas, então o problema é isolado.

---

## Implementação

```typescript
// src/domain/shared/types.ts — fonte única de verdade para branded types

declare const __brand: unique symbol
type Brand<T, B> = T & { readonly [__brand]: B }

// — Identificadores —
export type PaymentId      = Brand<string, 'PaymentId'>
export type SellerId       = Brand<string, 'SellerId'>
export type AccountId      = Brand<string, 'AccountId'>
export type JournalEntryId = Brand<string, 'JournalEntryId'>
export type LedgerEntryId  = Brand<string, 'LedgerEntryId'>
export type SplitRuleId    = Brand<string, 'SplitRuleId'>
export type IdempotencyKey = Brand<string, 'IdempotencyKey'>
export type RequestId      = Brand<string, 'RequestId'>

// — Valores financeiros —
export type Cents          = Brand<number, 'Cents'>          // sempre inteiro, sempre >= 0
export type CommissionRate = Brand<number, 'CommissionRate'> // 0.0 a 1.0

// — Construtores com validação —
import { randomUUID } from 'crypto'
import { ValidationError } from './errors/ValidationError'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function requireUUID(value: string, typeName: string): void {
  if (!UUID_REGEX.test(value)) {
    throw new ValidationError(`Invalid ${typeName} format: ${value}`)
  }
}

export const PaymentId = {
  of:     (id: string): PaymentId => { requireUUID(id, 'PaymentId'); return id as PaymentId },
  create: (): PaymentId => randomUUID() as PaymentId,
}

export const SellerId = {
  of:     (id: string): SellerId => { requireUUID(id, 'SellerId'); return id as SellerId },
  create: (): SellerId => randomUUID() as SellerId,
}

export const Cents = {
  of: (value: number): Cents => {
    if (!Number.isInteger(value)) throw new ValidationError(`Cents must be integer, got: ${value}`)
    if (value < 0)                throw new ValidationError(`Cents cannot be negative, got: ${value}`)
    return value as Cents
  },
  ZERO: 0 as Cents,
}

export const CommissionRate = {
  of: (value: number): CommissionRate => {
    if (value < 0 || value > 1) throw new ValidationError(`CommissionRate must be 0..1, got: ${value}`)
    return value as CommissionRate
  },
}

export const IdempotencyKey = {
  of: (key: string): IdempotencyKey => {
    if (key.length < 8 || key.length > 255) {
      throw new ValidationError(`IdempotencyKey must be 8-255 chars, got length: ${key.length}`)
    }
    return key as IdempotencyKey
  },
}
```

```json
// tsconfig.json — configuração completa
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "exactOptionalPropertyTypes": true,
    "noPropertyAccessFromIndexSignature": true,
    "forceConsistentCasingInFileNames": true,
    "esModuleInterop": true,
    "skipLibCheck": false,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Arquivos:**
- `src/domain/shared/types.ts` — todos os branded types
- `tsconfig.json` — configuração strict na raiz
- `.eslintrc.js` — regras complementares
