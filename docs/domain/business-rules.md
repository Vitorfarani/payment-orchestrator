# Regras de Negócio — Payment Orchestrator

> Fonte de verdade consolidada das regras de domínio.
> Derivada dos ADRs aceitos. Onde há conflito entre este documento e um ADR, o ADR prevalece.
> Onde há conflito entre um ADR e o código implementado, o código prevalece.

---

## 1. Representação de valores monetários

Todos os valores monetários são inteiros representando centavos. Sem exceções.

- `amountCents: 10000` = R$ 100,00
- `amountCents: 1` = R$ 0,01 (menor unidade possível)
- `float`, `DECIMAL` e `NUMERIC` são proibidos — nunca usar `99.90`, sempre `9990`
- O banco armazena `BIGINT NOT NULL CHECK (column >= 0)`
- Conversão para exibição (`/ 100`) é responsabilidade exclusiva da camada de apresentação — nunca no domínio

O Branded Type `Cents` rejeita valores não-inteiros e negativos em tempo de construção:
```typescript
Cents.of(10000)  // ✓
Cents.of(99.90)  // ✗ ValidationError: Cents must be integer
Cents.of(-1)     // ✗ ValidationError: Cents cannot be negative
```

---

## 2. Idempotência da API HTTP

### 2.1 Header obrigatório

`POST /payments` e `POST /payments/:id/refund` exigem o header `x-idempotency-key`. Valor gerado pelo cliente — UUID v4 recomendado, mínimo 8 caracteres.

### 2.2 Janela de validade

24 horas. Após esse período, uma nova requisição com a mesma chave pode ser reprocessada.

### 2.3 Comportamento por status

| Status da chave | Resposta |
|---|---|
| Não existe (primeira vez) | Processa normalmente |
| `PROCESSING` (em andamento) | `409` com `IDEMPOTENCY_CONFLICT` |
| `COMPLETED` | Retorna resultado original sem reprocessar |

### 2.4 Relação com idempotência dos workers

São mecanismos distintos e independentes:
- **API:** `x-idempotency-key` via Redis + PostgreSQL — protege o endpoint HTTP
- **LedgerWorker:** `existsByOutboxEventId` via `source_event_id` em `journal_entries` — protege o processamento assíncrono

---

## 3. Ciclo de vida do pagamento

### 3.1 Estados válidos

```
PENDING | PROCESSING | REQUIRES_ACTION | AUTHORIZED | CAPTURED
SETTLED | REFUNDED | PARTIALLY_REFUNDED | FAILED | CANCELLED
DISPUTED | CHARGEBACK_WON | CHARGEBACK_LOST
```

### 3.2 Transições válidas

| De | Para |
|---|---|
| PENDING | PROCESSING, CANCELLED |
| PROCESSING | AUTHORIZED, REQUIRES_ACTION, FAILED, CANCELLED |
| REQUIRES_ACTION | AUTHORIZED, FAILED, CANCELLED |
| AUTHORIZED | CAPTURED, CANCELLED |
| CAPTURED | SETTLED, REFUNDED, PARTIALLY_REFUNDED, DISPUTED |
| SETTLED | REFUNDED, PARTIALLY_REFUNDED, DISPUTED |
| PARTIALLY_REFUNDED | REFUNDED, DISPUTED |
| DISPUTED | CHARGEBACK_WON, CHARGEBACK_LOST |
| REFUNDED | — (terminal) |
| FAILED | — (terminal) |
| CANCELLED | — (terminal) |
| CHARGEBACK_WON | — (terminal) |
| CHARGEBACK_LOST | — (terminal) |

### 3.3 Quais estados permitem estorno

Apenas três estados permitem transicionar para `REFUNDED` ou `PARTIALLY_REFUNDED`:
- **CAPTURED** → REFUNDED, PARTIALLY_REFUNDED
- **SETTLED** → REFUNDED, PARTIALLY_REFUNDED
- **PARTIALLY_REFUNDED** → REFUNDED (estorno total do restante)

Qualquer tentativa de estorno a partir de outro estado retorna `BusinessRuleError` com a mensagem de transição inválida. Isso é verificado pela state machine em `Payment.transition()` — não pelo use case.

### 3.4 Estados terminais

`REFUNDED`, `FAILED`, `CANCELLED`, `CHARGEBACK_WON`, `CHARGEBACK_LOST`. Nenhuma transição é possível a partir deles.

### 3.5 Domain Events por transição

Toda transição dispara exatamente um Domain Event. O evento é adicionado via `this.events.push(this.buildEvent(newStatus, metadata))` dentro de `transition()`.

> **Nota:** a tabela abaixo cobre apenas os 12 eventos de *transição*. O 13º event é o `PaymentCreatedEvent`, disparado no momento da criação da entidade (dentro de `Payment.create()`), antes de qualquer transição de estado. Por isso não aparece nesta tabela.

| Transição para | Domain Event | Ação no Ledger |
|---|---|---|
| PROCESSING | PaymentProcessingEvent | Nenhuma |
| AUTHORIZED | PaymentAuthorizedEvent | Nenhuma |
| REQUIRES_ACTION | PaymentRequiresActionEvent | Nenhuma |
| CAPTURED | PaymentCapturedEvent | Cria JournalEntry (fluxo principal ADR-010) |
| SETTLED | PaymentSettledEvent | Atualiza read model |
| REFUNDED | PaymentRefundedEvent | Cria JournalEntry de reversão total |
| PARTIALLY_REFUNDED | PaymentPartiallyRefundedEvent | Cria JournalEntry de reversão parcial |
| FAILED | PaymentFailedEvent | Nenhuma (nunca houve cobrança) |
| CANCELLED | PaymentCancelledEvent | Nenhuma |
| DISPUTED | PaymentDisputedEvent | Nenhuma |
| CHARGEBACK_WON | ChargebackWonEvent | Libera reserva de disputa |
| CHARGEBACK_LOST | ChargebackLostEvent | Cria JournalEntry de prejuízo |

---

## 4. Processamento de pagamentos (fluxo síncrono/assíncrono)

### 4.1 O que CreatePaymentUseCase faz

1. Cria entidade `Payment` com status `PENDING`
2. Persiste `Payment` + `OutboxEvent(PAYMENT_CREATED)` na mesma transação via `uow.run()`
3. Retorna imediatamente com `status: 'PROCESSING'` e `pollUrl`

**Não chama o gateway.** Isso é responsabilidade exclusiva do `PaymentWorker`.

### 4.2 O que a API retorna ao cliente

Sempre `201` com `status: 'PROCESSING'` — nunca o resultado final. O cliente obtém o resultado via polling em `GET /payments/:id` ou via webhook de saída.

### 4.3 Race condition entre webhook e resposta do gateway

Webhook pode chegar antes da resposta síncrona da chamada ao gateway pelo `PaymentWorker`. Tratado via `SELECT FOR UPDATE` no `ProcessWebhookUseCase` — o segundo processamento vê o estado já atualizado e retorna ok idempotente.

---

## 5. Split de pagamentos

### 5.1 Cálculo padrão (dois destinatários)

```
platform = Math.floor(totalCents × commissionRate)
seller   = totalCents - platform
```

O vendedor **sempre** recebe o remainder. A plataforma **sempre** recebe o `Math.floor`.

**Invariante obrigatório:** `platform + seller === totalCents`. Se falhar, é erro crítico lançado imediatamente — não um `Result.err()`.

### 5.2 Cálculo para múltiplos vendedores (multi-seller)

1. Cada parte calculada com `Math.floor(total × rate)`
2. O remainder (`total - soma_das_partes`) vai para o **último destinatário da lista**
3. **Invariante obrigatório:** `soma_das_partes === total`

### 5.3 Cálculo de split em estorno

O estorno usa **as mesmas proporções do split original** (mesma `commissionRate`):

```
platformRefund = Math.floor(refundAmountCents × commissionRate)
sellerRefund   = refundAmountCents - platformRefund
```

**Invariante obrigatório:** `platformRefund + sellerRefund === refundAmountCents`.

### 5.4 Estornos parciais múltiplos — impossível na state machine atual

`PARTIALLY_REFUNDED → PARTIALLY_REFUNDED` **não é uma transição válida**. O único caminho possível é:

```
CAPTURED → PARTIALLY_REFUNDED → REFUNDED
```

Ou seja: um único estorno parcial, depois o estorno do restante. Não existem múltiplos estornos parciais encadeados em v1.

---

## 6. Estorno (Refund)

### 6.1 Quem chama `gateway.refund()`

**O `RefundPaymentUseCase` não chama o gateway.** O use case:
1. Valida que o estado atual permite estorno (CAPTURED, SETTLED ou PARTIALLY_REFUNDED)
2. Calcula o split proporcional do estorno
3. Valida o valor máximo estornável (ver 6.3)
4. Transiciona o estado via `payment.transition()`
5. Salva `OutboxEvent(PAYMENT_REFUNDED)` com o split no payload

A chamada ao `gateway.refund()` é responsabilidade do **`PaymentWorker`**, que escuta o evento `PAYMENT_REFUNDED` no Outbox — o mesmo worker que já trata `PAYMENT_CREATED` e tem o gateway adapter e o circuit breaker configurados. Isso preserva o fluxo padrão: Use Case → OutboxEvent → Worker → gateway → novo OutboxEvent.

### 6.2 Comportamento quando `refundAmountCents` é omitido

`undefined` significa **estorno total**. O use case usa `payment.amount` como valor do estorno e transiciona para `REFUNDED` (não `PARTIALLY_REFUNDED`).

### 6.3 Validação de valor máximo

A validação depende do estado atual do pagamento:

**De CAPTURED ou SETTLED** (nenhum estorno anterior):
```
refundAmountCents ≤ payment.amount
```

**De PARTIALLY_REFUNDED** (um estorno parcial já ocorreu):

A entidade `Payment` não armazena o valor já estornado em v1. A state machine garante que neste estado só existe um estorno parcial anterior. O `RefundPaymentUseCase` valida apenas `refundAmountCents ≤ payment.amount`. O rastreamento preciso do valor restante estornável está fora do escopo v1 (ver seção 13).

Em todos os casos, exceder `payment.amount` retorna `BusinessRuleError`.

### 6.4 Quem absorve o prejuízo em chargeback perdido

A **plataforma absorve o valor total**. O vendedor não é debitado automaticamente. Registrado como `Expense Chargeback Loss` (conta 4001).

### 6.5 Entradas do Ledger no estorno

```
Estorno (solicitado):
DEBIT   3001 Revenue Platform      platformRefundCents
DEBIT   2001 Payable Seller        sellerRefundCents
CREDIT  2002 Payable Refund        refundAmountCents

Estorno confirmado pelo gateway:
DEBIT   2002 Payable Refund        refundAmountCents
CREDIT  1001 Receivable Gateway    refundAmountCents
```

---

## 7. Plano de contas (Chart of Accounts)

7 contas fixas e imutáveis. Nenhuma conta pode ser criada em runtime.

| Código | Nome | Tipo |
|---|---|---|
| 1001 | Receivable Gateway | ASSET |
| 2001 | Payable Seller | LIABILITY |
| 2002 | Payable Refund | LIABILITY |
| 3001 | Revenue Platform | REVENUE |
| 3002 | Revenue Chargeback Fee | REVENUE |
| 4001 | Expense Chargeback Loss | EXPENSE |
| 4002 | Expense Gateway Fee | EXPENSE |

### 7.1 Entradas do Ledger no fluxo principal (PaymentCaptured)

```
DEBIT   1001 Receivable Gateway    amountCents
CREDIT  2001 Payable Seller        sellerAmountCents
CREDIT  3001 Revenue Platform      platformAmountCents
```

Balanço: `amountCents = sellerAmountCents + platformAmountCents` ✓

---

## 8. Idempotência nos use cases de Ledger

`RecordDoubleEntryUseCase` e `RecordRefundEntryUseCase` verificam idempotência **antes** de abrir o `uow.run()` — evita o overhead de abrir transação para um caso que não vai escrever nada.

O repositório é injetado separadamente no construtor do use case (sem transação):

```typescript
// journalEntryRepo é injetado no construtor — sem transação
const alreadyProcessed = await this.journalEntryRepo.existsByOutboxEventId(outboxEventId)
if (alreadyProcessed) return ok(undefined)  // sai sem abrir UoW

await this.uow.run(async (repos) => {
  // só chega aqui se ainda não foi processado
  await repos.journalEntries.save(entry)
})
```

Usa a coluna `source_event_id` em `journal_entries` (migration 013) — não o `IdempotencyStore` (Redis).

---

## 9. Settlement

### 9.1 Schedules disponíveis

| Schedule | Dias | Uso |
|---|---|---|
| D+1 | 1 dia | Vendedores verificados, alto volume |
| D+2 | 2 dias | Vendedores estabelecidos |
| D+14 | 14 dias | **Padrão para novos vendedores** |
| D+30 | 30 dias | Alto risco ou monitoramento |

### 9.2 Dias corridos, não dias úteis

O cálculo usa **dias corridos**. Feriados nacionais, regionais e bancários não são considerados em v1. Se `payout_date` cair em fim de semana, o gateway tentará no próximo dia útil — isso cria pequena divergência entre a data calculada e o payout efetivo.

### 9.3 Normalização da data de payout

`payout_date` é sempre normalizada para **meia-noite UTC**:
```typescript
payoutDate.setUTCHours(0, 0, 0, 0)
```

### 9.4 Quando o SettlementWorker roda

Diariamente às **06:00 UTC** via cron job no BullMQ. Processa todos os `settlement_items` com `payout_date <= hoje` e `status = 'PENDING'`.

### 9.5 Retry em caso de falha do payout

Não há retry via BullMQ para `ProcessSettlementUseCase`. O mecanismo é:
- Falha → `uow.run()` faz rollback → item permanece `PENDING`
- Cron do dia seguinte encontra o item como `PENDING` e reprocessa

### 9.6 ConflictError no ScheduleSettlementUseCase

Um pagamento gera **exatamente um** `settlement_item` (`UNIQUE(payment_id)` no banco). Tentar criar um segundo retorna `ConflictError`.

---

## 10. Outbox Pattern — regra universal

**Toda publicação de evento deve ser atômica com a escrita no banco.** Sem exceções.

```typescript
await uow.run(async (repos) => {
  await repos.payments.save(payment)      // escrita principal
  await repos.outbox.save(outboxEvent)    // evento — mesma transação
})
// Se qualquer um falhar: ambos revertidos
```

**Nunca** chamar `queue.add()` diretamente dentro de um use case ou worker. Isso seria dual-write.

Entrega é **at-least-once**: o mesmo evento pode ser entregue mais de uma vez. Todo worker deve ser idempotente.

---

## 11. Audit Log

### 11.1 Ações que geram registro obrigatório

`payment.created`, `payment.captured`, `payment.cancelled`, `payment.refunded`, `payment.disputed`, `split_rule.created`, `split_rule.updated`, `split_rule.deleted`, `seller.created`, `seller.bank_account_updated`, `seller.suspended`, `seller.settlement_schedule_changed`, `admin.payment_status_forced`, `admin.ledger_entry_reversed`, `admin.job_reprocessed`, `seller.pii_accessed`, `payment.full_details_accessed`.

### 11.2 Imutabilidade

A role `payment_app_role` tem `UPDATE` e `DELETE` revogados na tabela `audit_logs`. Apenas `INSERT` e `SELECT` são permitidos. Retenção: **7 anos**.

### 11.3 Dados sensíveis no audit log

`previousState` e `newState` passam pelo `SensitiveDataMasker` antes de serem persistidos. Nenhum dado sensível (CPF, PAN, dados bancários) aparece no audit log.

---

## 12. Regras de validação por camada

**Controllers (Fase 6 — Zod):** validam a fronteira HTTP — formato, tipos, campos obrigatórios. Erros retornam `400` antes de chegar no use case.

**Use cases:** validam regras de domínio. Retornam `Result.err()` com `ValidationError` ou `BusinessRuleError` — nunca `throw`.

As duas camadas validam coisas diferentes e são complementares.

| Campo | Camada | Regra |
|---|---|---|
| `sellerId` | Use case | UUID válido |
| `amountCents` | Use case | > 0 |
| `idempotencyKey` | Use case | ≥ 8 caracteres |
| `commissionRate` | Use case | ≥ 0 e ≤ 1 |
| `refundAmountCents` | Use case | > 0 e ≤ `payment.amount` |
| `schedule` | Use case | Um de: 'D+1', 'D+2', 'D+14', 'D+30' |

---

## 13. O que está indefinido / fora do escopo v1

| Tópico | Status |
|---|---|
| Dias úteis no settlement | Fora do escopo — dias corridos em v1 |
| Rastreamento do valor já estornado em estornos parciais | Fora do escopo — `Payment` não armazena `refundedAmountCents` em v1 |
| Recuperação de débito de vendedor em saldo insuficiente | Fora do escopo — tratado como Expense temporariamente |
| gateway.refund() — quem chama e quando | Responsabilidade do `PaymentWorker`, que escuta o evento `PAYMENT_REFUNDED` no Outbox |
| Multi-tenancy | Fora do escopo — uma instância por marketplace |
| Suporte a moedas além de BRL | Fora do escopo v1 |
| Estorno de chargeback com débito automático do vendedor | Fora do escopo — processo manual |
