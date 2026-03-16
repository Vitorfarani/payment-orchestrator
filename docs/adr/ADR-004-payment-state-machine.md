# ADR-004: Design da State Machine de pagamentos

## Metadados

| Campo | Valor |
|---|---|
| **ID** | ADR-004 |
| **Título** | Design da State Machine de pagamentos |
| **Status** | `accepted` |
| **Data** | 2025-01-01 |
| **Contextos afetados** | PaymentContext, LedgerContext |
| **Depende de** | ADR-010 (Chart of Accounts), ADR-014 (Result Type), ADR-015 (Branded Types) |
| **Bloqueia** | Entidade Payment, ProcessWebhookUseCase, migrations de payments |

---

## Contexto

Um pagamento não tem dois estados (pago/não pago). Na realidade de um gateway de pagamentos, um pagamento passa por múltiplas fases com semânticas financeiras distintas — e cada fase tem implicações diferentes no Ledger, nas notificações e no comportamento do sistema.

O problema de não modelar isso explicitamente é que o código fica cheio de `if payment.status === 'paid'` espalhados, cada desenvolvedor assume transições diferentes, e o sistema aceita sequências de estados impossíveis (ex: um pagamento ir de `REFUNDED` de volta para `AUTHORIZED`).

Em sistemas financeiros, estados inválidos não são apenas bugs de interface — são inconsistências contábeis. Um pagamento que vai de `CAPTURED` para `PENDING` sem uma entrada de reversão no Ledger cria dinheiro do nada ou faz dinheiro desaparecer.

Adicionalmente, o gateway externo (Stripe/Asaas) envia webhooks com seus próprios status que precisam ser mapeados para os estados internos sem ambiguidade.

---

## Decisão

A entidade `Payment` implementará uma **State Machine explícita** com:

1. **13 estados** nomeados como discriminated union TypeScript
2. **Mapa de transições válidas** declarado como constante — única fonte de verdade
3. **Método `transition()`** que valida e executa a transição, retornando `Result`
4. **`assertNever()`** em todos os switches sobre status — o compilador garante cobertura total
5. **Cada transição dispara um Domain Event** — consumido pelo Ledger para registrar a entrada contábil correspondente
6. **Constraint no banco** espelha os estados válidos (ADR-016)

### Os 13 estados e suas semânticas

```
PENDING           — Payment criado, aguardando envio ao gateway
PROCESSING        — Enviado ao gateway, aguardando resposta (pode levar segundos a minutos)
REQUIRES_ACTION   — Gateway exige ação adicional do comprador (ex: 3DS, Pix aguardando)
AUTHORIZED        — Fundos reservados no cartão, ainda não capturados
CAPTURED          — Cobrança efetivada. Dinheiro garantido. → Ledger entry criada
SETTLED           — Gateway liquidou na conta da plataforma
REFUNDED          — Estornado totalmente ao comprador
PARTIALLY_REFUNDED — Estornado parcialmente
FAILED            — Falha no processamento (sem cobrança)
CANCELLED         — Cancelado antes de ser processado (sem cobrança)
DISPUTED          — Chargeback aberto pelo comprador
CHARGEBACK_WON    — Disputa resolvida em favor da plataforma
CHARGEBACK_LOST   — Disputa perdida — prejuízo registrado no Ledger
```

### Mapa de transições válidas

```
PENDING           → PROCESSING, CANCELLED
PROCESSING        → AUTHORIZED, REQUIRES_ACTION, FAILED, CANCELLED
REQUIRES_ACTION   → AUTHORIZED, FAILED, CANCELLED
AUTHORIZED        → CAPTURED, CANCELLED
CAPTURED          → SETTLED, REFUNDED, PARTIALLY_REFUNDED, DISPUTED
SETTLED           → REFUNDED, PARTIALLY_REFUNDED, DISPUTED
REFUNDED          → (terminal)
PARTIALLY_REFUNDED → REFUNDED, DISPUTED
FAILED            → (terminal)
CANCELLED         → (terminal)
DISPUTED          → CHARGEBACK_WON, CHARGEBACK_LOST
CHARGEBACK_WON    → (terminal)
CHARGEBACK_LOST   → (terminal)
```

### Domain Events disparados por transição

| Transição | Domain Event | Ação no Ledger |
|---|---|---|
| → CAPTURED | `PaymentCaptured` | Cria JournalEntry (ADR-010 fluxo principal) |
| → REFUNDED | `PaymentRefunded` | Cria JournalEntry de reversão total |
| → PARTIALLY_REFUNDED | `PaymentPartiallyRefunded` | Cria JournalEntry de reversão parcial |
| → CHARGEBACK_LOST | `ChargebackLost` | Cria JournalEntry de prejuízo |
| → CHARGEBACK_WON | `ChargebackWon` | Libera reserva de disputa |
| → FAILED | `PaymentFailed` | Nenhuma ação no Ledger (nunca houve cobrança) |
| → SETTLED | `PaymentSettled` | Atualiza read model do dashboard |

---

## Alternativas consideradas

### Alternativa 1: Enum simples com if/else nos use cases

Definir `PaymentStatus` como enum e deixar cada use case verificar manualmente se a transição é válida.

**Prós:** simples, sem abstrações novas.
**Contras:** lógica de transição espalhada em múltiplos lugares. Quando um novo estado é adicionado, nenhum mecanismo garante que todos os use cases foram atualizados. Com `assertNever`, o compilador quebra em todos os pontos não tratados.
**Por que descartada:** sem a state machine centralizada, o histórico de bugs mostra que estados inválidos aparecem em produção quando a lógica de transição está duplicada.

### Alternativa 2: Biblioteca de state machine (XState)

Usar XState para modelar a state machine com visualização e ferramentas de debug.

**Prós:** visualização gráfica dos estados, ferramentas de teste dedicadas, padrão estabelecido.
**Contras:** XState é uma dependência pesada (180kb) com seu próprio paradigma. Viola o princípio de zero dependências externas no domínio. A state machine deste projeto é suficientemente simples para implementação manual.
**Por que descartada:** YAGNI. Nossa implementação manual com discriminated union TypeScript oferece as mesmas garantias de compile-time sem dependência externa.

### Alternativa 3: Persistir apenas o status atual (sem histórico)

Salvar só o `status` atual na tabela `payments`, sem rastrear as transições.

**Prós:** schema mais simples.
**Contras:** em auditoria financeira, é essencial saber quando cada transição aconteceu e qual evento externo (webhook) a disparou. Sem histórico, investigar um pagamento problemático é muito mais difícil.
**Por que descartada:** adicionamos uma tabela `payment_status_history` que registra cada transição com timestamp e o evento que a causou — custo baixo, valor alto para debugging e auditoria.

---

## Consequências

### Positivas
- Transições inválidas são impossíveis — bloqueadas em compile-time pelo TypeScript e em runtime pelo método `transition()`.
- `assertNever()` garante que todo novo estado adicionado causa erro de compilação em todos os switches não atualizados.
- Domain Events desacoplam a state machine do Ledger — o Payment não sabe que o Ledger existe.
- Histórico de transições facilita debugging e auditoria.

### Negativas / Trade-offs
- 13 estados para documentar, testar e manter — mais que um booleano `isPaid`.
- Cada novo estado requer: atualização do enum, do mapa de transições, dos domain events, das migrations, e dos testes. Processo bem definido, mas não trivial.

### Riscos e mitigações
- **Risco:** webhook do gateway chega com status desconhecido (gateway adiciona novo status).
  **Mitigação:** o `WebhookMapper` que converte status do gateway para `PaymentStatus` interno trata status desconhecidos como `FAILED` e registra um log de warning com o valor recebido. Nunca ignora silenciosamente.

- **Risco:** race condition — dois webhooks para o mesmo pagamento chegam simultaneamente.
  **Mitigação:** o `ProcessWebhookUseCase` usa `SELECT FOR UPDATE` no pagamento antes de transicionar. Apenas um processamento por vez por `payment_id`. Combinado com idempotência (ADR-002), o segundo webhook é descartado após o lock ser liberado.

---

## Implementação

```typescript
// src/domain/payment/value-objects/PaymentStatus.ts

export type PaymentStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'REQUIRES_ACTION'
  | 'AUTHORIZED'
  | 'CAPTURED'
  | 'SETTLED'
  | 'REFUNDED'
  | 'PARTIALLY_REFUNDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'DISPUTED'
  | 'CHARGEBACK_WON'
  | 'CHARGEBACK_LOST'

// Única fonte de verdade para transições válidas.
// Readonly garante que ninguém muta isso em runtime.
export const VALID_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  PENDING:             ['PROCESSING', 'CANCELLED'],
  PROCESSING:          ['AUTHORIZED', 'REQUIRES_ACTION', 'FAILED', 'CANCELLED'],
  REQUIRES_ACTION:     ['AUTHORIZED', 'FAILED', 'CANCELLED'],
  AUTHORIZED:          ['CAPTURED', 'CANCELLED'],
  CAPTURED:            ['SETTLED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'DISPUTED'],
  SETTLED:             ['REFUNDED', 'PARTIALLY_REFUNDED', 'DISPUTED'],
  REFUNDED:            [],
  PARTIALLY_REFUNDED:  ['REFUNDED', 'DISPUTED'],
  FAILED:              [],
  CANCELLED:           [],
  DISPUTED:            ['CHARGEBACK_WON', 'CHARGEBACK_LOST'],
  CHARGEBACK_WON:      [],
  CHARGEBACK_LOST:     [],
} as const

export const TERMINAL_STATES: readonly PaymentStatus[] = [
  'REFUNDED', 'FAILED', 'CANCELLED', 'CHARGEBACK_WON', 'CHARGEBACK_LOST'
]

// Usado em switch/case para garantir cobertura total pelo compilador
export function assertNever(status: never): never {
  throw new Error(`Unhandled payment status: ${JSON.stringify(status)}`)
}
```

```typescript
// src/domain/payment/Payment.ts (trecho relevante da state machine)

import { VALID_TRANSITIONS, PaymentStatus, assertNever } from './value-objects/PaymentStatus'
import { err, ok, Result } from '../shared/Result'
import { BusinessRuleError } from '../shared/errors'

export class Payment {
  // ... props, constructor, etc.

  transition(
    newStatus: PaymentStatus,
    metadata?: Record<string, unknown>
  ): Result<void, BusinessRuleError> {
    const validNext = VALID_TRANSITIONS[this.props.status]

    if (!validNext.includes(newStatus)) {
      return err(new BusinessRuleError(
        `Invalid transition: ${this.props.status} → ${newStatus}. ` +
        `Valid transitions: ${validNext.join(', ') || 'none (terminal state)'}`
      ))
    }

    const previousStatus = this.props.status
    this.props.status = newStatus
    this.props.updatedAt = new Date()

    // Dispara o domain event correspondente à transição
    this.addDomainEvent(this.buildEventForTransition(newStatus, previousStatus, metadata))

    return ok(undefined)
  }

  private buildEventForTransition(
    newStatus: PaymentStatus,
    previousStatus: PaymentStatus,
    metadata?: Record<string, unknown>
  ) {
    // assertNever garante que todo estado é tratado.
    // Se adicionar um novo status e esquecer aqui: ERRO DE COMPILAÇÃO.
    switch (newStatus) {
      case 'CAPTURED':           return new PaymentCapturedEvent(this.id, this.amount, this.sellerId)
      case 'REFUNDED':           return new PaymentRefundedEvent(this.id, this.amount)
      case 'PARTIALLY_REFUNDED': return new PaymentPartiallyRefundedEvent(this.id, metadata?.refundAmount)
      case 'CHARGEBACK_LOST':    return new ChargebackLostEvent(this.id, this.amount)
      case 'CHARGEBACK_WON':     return new ChargebackWonEvent(this.id)
      case 'SETTLED':            return new PaymentSettledEvent(this.id)
      case 'FAILED':             return new PaymentFailedEvent(this.id, metadata?.reason)
      case 'CANCELLED':          return new PaymentCancelledEvent(this.id)
      case 'PROCESSING':         return new PaymentProcessingEvent(this.id)
      case 'AUTHORIZED':         return new PaymentAuthorizedEvent(this.id)
      case 'REQUIRES_ACTION':    return new PaymentRequiresActionEvent(this.id)
      case 'DISPUTED':           return new PaymentDisputedEvent(this.id)
      case 'PENDING':            return assertNever(newStatus) // nunca se transiciona PARA pending
    }
  }
}
```

```typescript
// Como o assertNever protege em tempo de compilação:
// Se amanhã você adicionar 'EXPIRED' ao tipo PaymentStatus e esquecer
// de adicionar o case no switch acima, o TypeScript vai recusar compilar:
//
// Type '"EXPIRED"' is not assignable to type 'never'
//
// Isso é a garantia de que nenhum estado fica sem tratamento — nunca.
```

**Arquivos:**
- `src/domain/payment/value-objects/PaymentStatus.ts`
- `src/domain/payment/Payment.ts`
- `src/domain/payment/events/` — um arquivo por domain event
- `src/infrastructure/database/migrations/007_payment_status_history.ts`
