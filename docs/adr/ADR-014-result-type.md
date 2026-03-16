# ADR-014: Result Type para erros de domínio em vez de exceções

## Metadados

| Campo | Valor |
|---|---|
| **ID** | ADR-014 |
| **Título** | Result Type para erros de domínio em vez de exceções |
| **Status** | `accepted` |
| **Data** | 2025-01-01 |
| **Contextos afetados** | Todos (decisão transversal) |
| **Depende de** | — |
| **Bloqueia** | Toda implementação de domínio e use cases |

---

## Contexto

Em TypeScript, qualquer função pode lançar uma exceção a qualquer momento — e o compilador não exige que o chamador trate isso. A assinatura `function processPayment(input): Payment` promete retornar um `Payment`, mas pode silenciosamente lançar um erro que derruba o processo se não for capturado em algum lugar.

Em sistemas financeiros, isso cria dois problemas sérios:

**Problema 1 — Erros de domínio não são erros de sistema.** Um pagamento rejeitado por saldo insuficiente é um resultado esperado do negócio, não uma falha catastrófica. Tratar isso com `throw` mistura erros previsíveis (negócio) com erros imprevisíveis (sistema), e o chamador não consegue distinguir os dois sem inspecionar o tipo da exceção — que o compilador não garante.

**Problema 2 — A assinatura da função mente.** `function validateSplit(rule, amount): SplitResult` não comunica que pode falhar. Um novo desenvolvedor que lê essa assinatura assume que a função sempre retorna um `SplitResult`. O contrato está incompleto.

O efeito prático: erros de domínio são silenciados por `try/catch` genéricos que retornam HTTP 500 para situações que deveriam ser HTTP 400, e lógica de recuperação fica espalhada em múltiplos lugares sem padrão.

---

## Decisão

Usaremos o padrão **Result Type** para todos os erros esperados nas camadas de domínio e aplicação. Exceções (`throw`) ficam reservadas exclusivamente para erros de infraestrutura imprevisíveis (banco indisponível, memória esgotada, falha de rede não tratada pelo circuit breaker).

A regra é: **se o erro faz parte das regras de negócio, é um `Result`. Se o erro é uma surpresa do ambiente, é uma exceção.**

```typescript
// src/domain/shared/Result.ts
// Implementação local — sem biblioteca externa. Simples e sob controle.

export type Result<T, E extends AppError = DomainError> =
  | { readonly ok: true;  readonly value: T }
  | { readonly ok: false; readonly error: E }

// Helpers para criar resultados sem repetição
export const ok  = <T>(value: T): Result<T, never> => ({ ok: true, value })
export const err = <E extends AppError>(error: E): Result<never, E> => ({ ok: false, error })

// Hierarquia de erros — permite distinguir categoria no controller
export abstract class AppError extends Error {
  abstract readonly code: string
}

export class DomainError extends AppError {
  readonly code: string
  constructor(message: string, code = 'DOMAIN_ERROR') {
    super(message)
    this.code = code
  }
}

export class ValidationError extends DomainError {
  constructor(message: string) { super(message, 'VALIDATION_ERROR') }
}

export class BusinessRuleError extends DomainError {
  constructor(message: string) { super(message, 'BUSINESS_RULE_ERROR') }
}

export class NotFoundError extends DomainError {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`, 'NOT_FOUND')
  }
}

export class ConflictError extends DomainError {
  constructor(message: string) { super(message, 'CONFLICT') }
}
```

---

## Alternativas consideradas

### Alternativa 1: Exceções tipadas com hierarquia de classes

Manter `throw`, mas com uma hierarquia de classes de erro (`DomainException`, `ValidationException`, etc.) e documentação via JSDoc indicando o que cada função pode lançar.

**Prós:** familiar para desenvolvedores de Java/C#, sem mudança de paradigma.
**Contras:** o compilador TypeScript ainda não verifica se o chamador trata a exceção. A assinatura ainda mente. O contrato continua incompleto.
**Por que descartada:** resolve a organização mas não o problema central — a falta de garantia em compile-time que o erro foi tratado.

### Alternativa 2: Biblioteca externa (neverthrow, fp-ts)

Usar bibliotecas de programação funcional que implementam `Result`/`Either`.

**Prós:** `neverthrow` em particular tem API ergonômica e bem testada. `fp-ts` oferece composição funcional completa.
**Contras:** `fp-ts` tem curva de aprendizado alta (muito funcional) — inadequado para um time misto. `neverthrow` adiciona uma dependência externa para um padrão que implementamos em ~30 linhas.
**Por que descartada:** YAGNI e KISS. Nossa implementação local cobre todos os casos de uso do projeto. Adicionar dependência apenas por conveniência vai contra o princípio de manter o domínio com zero dependências externas.

### Alternativa 3: Retornar `null` ou `undefined` para falhas

`function findPayment(id): Payment | null`

**Prós:** simples, sem novo conceito.
**Contras:** `null` não carrega informação sobre o erro. Não dá para saber se o pagamento não existe ou se a query falhou. O chamador tem que inferir o motivo pela ausência de valor.
**Por que descartada:** perde informação crítica de diagnóstico. Aceitável para queries de busca, inaceitável para operações de negócio.

---

## Consequências

### Positivas
- A assinatura da função é o contrato completo — o chamador sabe exatamente o que esperar.
- O TypeScript força o tratamento: `result.ok` precisa ser verificado antes de acessar `result.value`.
- Separação clara: `ok: false` com `DomainError` → HTTP 400; exceção não capturada → HTTP 500.
- Testes de domínio ficam mais expressivos: `expect(result.ok).toBe(false)` é mais claro que `expect(() => fn()).toThrow()`.

### Negativas / Trade-offs
- Novo paradigma para quem não conhece — curva de aprendizado inicial.
- Funções com múltiplos pontos de falha ficam mais verbosas (mas mais honestas).
- `async` functions precisam de atenção: retornar `Promise<Result<T>>`, não misturar com `throw` em funções assíncronas.

### Riscos e mitigações
- **Risco:** desenvolvedor usa `throw` em código de domínio por hábito.
  **Mitigação:** ESLint rule `no-throw-in-domain` customizada que proíbe `throw` dentro de `src/domain/` e `src/application/`. O CI quebra se a regra for violada.

- **Risco:** `.value` acessado sem verificar `.ok` primeiro, causando runtime error.
  **Mitigação:** o TypeScript discriminated union garante isso em tempo de compilação com `strict: true`. Acessar `result.value` sem checar `result.ok` é erro de compilação.

---

## Implementação

```typescript
// Domínio — função honesta sobre seus possíveis resultados
class Payment {
  capture(): Result<void, BusinessRuleError> {
    if (!VALID_TRANSITIONS['AUTHORIZED'].includes('CAPTURED')) {
      return err(new BusinessRuleError(
        `Cannot capture payment in status ${this.status}`
      ))
    }
    this.props.status = 'CAPTURED'
    this.addEvent(new PaymentCapturedEvent(this.id))
    return ok(undefined)
  }
}

// Use case — compõe resultados sem exceções
class CreatePaymentUseCase {
  async execute(input: CreatePaymentInput): Promise<Result<Payment>> {
    // Cada etapa retorna Result — falha para imediatamente se algo der errado
    const validation = PaymentValidator.validate(input)
    if (!validation.ok) return validation          // retorna o erro, não lança

    const idempotency = await this.idempotencyStore.check(input.key)
    if (!idempotency.ok) return idempotency

    if (idempotency.value.exists) {
      return ok(idempotency.value.cachedPayment)   // idempotent: retorna resultado anterior
    }

    const payment = Payment.create(input)
    if (!payment.ok) return payment

    await this.repo.save(payment.value)            // infraestrutura pode lançar exceção — intencional
    return ok(payment.value)
  }
}

// Controller — traduz Result para HTTP sem lógica de negócio
class PaymentController {
  async create(req, res) {
    try {
      const result = await this.useCase.execute(req.body)

      if (!result.ok) {
        // Erros de domínio são sempre 4xx — nunca 500
        const statusMap: Record<string, number> = {
          VALIDATION_ERROR:   400,
          BUSINESS_RULE_ERROR: 422,
          NOT_FOUND:           404,
          CONFLICT:            409,
        }
        const status = statusMap[result.error.code] ?? 400
        return res.status(status).json({ error: result.error.message, code: result.error.code })
      }

      return res.status(201).json(PaymentMapper.toDTO(result.value))

    } catch (error) {
      // Exceções chegam aqui — são erros de infraestrutura (banco caiu, etc.)
      // Sempre 500, sempre logados com stack trace completo
      this.logger.error({ error }, 'Unexpected infrastructure error')
      return res.status(500).json({ error: 'Internal server error' })
    }
  }
}
```

**Arquivos:**
- `src/domain/shared/Result.ts` — tipos e helpers
- `src/domain/shared/errors/` — hierarquia de erros de domínio
- `.eslintrc` — regra `no-throw-in-domain`
