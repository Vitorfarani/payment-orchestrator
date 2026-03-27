# Bounded Contexts — Context Map

> Context map detalhado do Payment Orchestrator.
> Base: [overview.md](../overview.md) e os ADRs de cada contexto.
> Onde há conflito entre este documento e um ADR, o ADR prevalece.

---

## Visão geral

O sistema é organizado em 7 bounded contexts com responsabilidades distintas e não sobrepostas. A comunicação entre contextos é feita **exclusivamente via Domain Events publicados pelo Outbox Pattern** — nenhum contexto chama diretamente o repositório de outro. A única exceção é o `SplitContext`, que expõe um serviço de cálculo (`SplitCalculator`) consumido de forma síncrona em-processo por use cases do `PaymentContext`.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Contextos e dependências                          │
└─────────────────────────────────────────────────────────────────────────────┘

  [Gateway Externo]
       │ webhooks HMAC-SHA256
       ▼
 ┌─────────────────┐   transições de status    ┌──────────────────┐
 │  WebhookContext │ ────────────────────────► │  PaymentContext  │
 └─────────────────┘                           └────────┬─────────┘
                                                        │
                              ┌─────────────────────────┼────────────────────┐
                              │ (síncrono, em-processo) │ (via Domain Events)│
                              ▼                         │                    │
                     ┌────────────────┐                 │                    │
                     │  SplitContext  │                 │                    │
                     └────────────────┘                 │                    │
                                                        │                    │
                                          ┌─────────────▼──────┐  ┌─────────▼──────────┐
                                          │   LedgerContext    │  │ SettlementContext  │
                                          └────────────────────┘  └────────────────────┘
                                                        ▲                    │
                                                        └────────────────────┘
                                                          settlement.processed

 ┌─────────────────┐   lê SplitRule, SettlementSchedule
 │  SellerContext  │ ──────────────────────────────────► PaymentContext, SettlementContext
 └─────────────────┘

 ┌──────────────────────┐   consome eventos de status
 │ NotificationContext  │ ◄── PaymentContext (webhooks de saída para merchants)
 └──────────────────────┘
```

**Mecanismo de integração assíncrona:** todos os Domain Events cruzam fronteiras de contexto via tabela `outbox_events`. O `OutboxRelay` lê eventos não processados e os publica no BullMQ. Workers do contexto destino consomem esses eventos de forma idempotente. Ver [ADR-009](../adr/ADR-009-outbox-pattern.md).

---

## PaymentContext

### Responsabilidades

- Gerenciar o ciclo de vida completo de um pagamento, do estado `PENDING` ao estado terminal
- Implementar e validar a State Machine de 13 estados com transições explícitas
- Coordenar a chamada ao gateway externo (via `PaymentWorker`) — tanto para cobranças quanto para estornos
- Garantir idempotência em todas as fronteiras: API (`x-idempotency-key`) e workers (`job_id`)
- Emitir Domain Events para cada transição de estado

### Entidades e Value Objects principais

| Tipo | Nome | Descrição |
|---|---|---|
| Entidade | `Payment` | Entidade raiz do contexto. Implementa a State Machine |
| Value Object | `PaymentStatus` | Discriminated union dos 13 estados; inclui `VALID_TRANSITIONS` |
| Value Object | `Cents` | Valor monetário em centavos (Branded Type) |
| Value Object | `IdempotencyKey` | Chave de idempotência do cliente (Branded Type) |
| Value Object | `Currency` | Moeda da transação — exclusivamente `BRL` em v1 |
| Tabela de suporte | `payment_status_history` | Histórico de cada transição com timestamp e metadados |
| Tabela de suporte | `idempotency_keys` | Registro durável de chaves de idempotência (PostgreSQL) |

### Eventos emitidos

Cada transição de estado dispara exatamente um Domain Event. Os eventos são publicados atomicamente via Outbox.

| Evento (Outbox `event_type`) | Disparado quando | Ação nos contextos consumidores |
|---|---|---|
| `payment.created` | Payment criado com status `PENDING` | `PaymentWorker` chama `gateway.charge()` |
| `payment.authorized` | Gateway autorizou a cobrança | Nenhuma ação downstream documentada em v1 |
| `payment.captured` | Cobrança efetivada | `LedgerContext` cria JournalEntry; `SettlementContext` cria SettlementItem |
| `payment.refunded` | Estorno total solicitado | `PaymentWorker` chama `gateway.refund()`; `LedgerContext` cria JournalEntry de reversão |
| `payment.partially_refunded` | Estorno parcial solicitado | `PaymentWorker` chama `gateway.refund()`; `LedgerContext` cria JournalEntry de reversão parcial |
| `payment.failed` | Falha no processamento pelo gateway | Nenhuma ação no Ledger (nunca houve cobrança) |
| `payment.cancelled` | Cancelado antes do processamento | Nenhuma ação no Ledger |
| `payment.disputed` | Chargeback aberto pelo comprador | Nenhuma ação imediata documentada |
| `chargeback.won` | Disputa resolvida a favor da plataforma | `LedgerContext` libera reserva de disputa |
| `chargeback.lost` | Disputa perdida — prejuízo da plataforma | `LedgerContext` cria JournalEntry de prejuízo (conta 4001) |
| `payment.settled` | Gateway liquidou na conta da plataforma | `LedgerContext` atualiza read model |

### Eventos consumidos

| Evento (origem) | Fonte | Ação interna |
|---|---|---|
| Webhook do gateway (mapeado pelo `WebhookMapper`) | `WebhookContext` | Transiciona o `PaymentStatus` via `payment.transition()` com `SELECT FOR UPDATE` |

### Dependências entre contextos

| Contexto | Tipo de dependência | Detalhe |
|---|---|---|
| `SplitContext` | Síncrona, em-processo | `RefundPaymentUseCase` chama `SplitCalculator.calculate()` para calcular o split proporcional do estorno |
| `SellerContext` | Leitura de configuração | `CreatePaymentUseCase` lê a `SplitRule` ativa do vendedor para incluir no payload do Outbox Event |
| `LedgerContext` | Assíncrona via Domain Events | `payment.captured`, `payment.refunded`, `chargeback.lost` disparam criação de JournalEntries |
| `SettlementContext` | Assíncrona via Domain Events | `payment.captured` dispara criação de `SettlementItem` |
| `WebhookContext` | Recebe transições | `ProcessWebhookUseCase` transiciona o Payment ao processar webhooks do gateway |

### ADRs de referência

[ADR-002](../adr/ADR-002-idempotency-storage.md) · [ADR-003](../adr/ADR-003-sync-async-processing.md) · [ADR-004](../adr/ADR-004-payment-state-machine.md) · [ADR-006](../adr/ADR-006-refund-strategy.md) · [ADR-008](../adr/ADR-008-circuit-breaker.md) · [ADR-009](../adr/ADR-009-outbox-pattern.md)

---

## LedgerContext

### Responsabilidades

- Manter a integridade contábil de todas as movimentações financeiras do sistema
- Implementar double-entry bookkeeping: toda movimentação registrada em ao menos duas contas, com `SUM(DEBIT) = SUM(CREDIT)` garantida em nível de banco
- Garantir imutabilidade de `JournalEntry` e `LedgerEntry` — nunca `UPDATE` ou `DELETE`
- Corrigir erros exclusivamente via reversing entries
- Manter o read model (`ledger_summary`) atualizado para o dashboard de conciliação

### Entidades e Value Objects principais

| Tipo | Nome | Descrição |
|---|---|---|
| Entidade | `Account` | Conta contábil do plano de contas (7 fixas) |
| Entidade | `JournalEntry` | Lançamento contábil. Agrupa as linhas de débito/crédito de um evento |
| Entidade | `LedgerEntry` | Linha individual de um lançamento: conta, tipo (DEBIT/CREDIT) e valor |
| Value Object | `AccountCode` | Enum tipado dos 7 códigos de conta: `1001`..`4002` |
| Value Object | `AccountType` | `ASSET`, `LIABILITY`, `REVENUE`, `EXPENSE` |
| View | `ledger_summary` | MATERIALIZED VIEW — read model CQRS para o dashboard |

### Eventos consumidos

| Evento | Origem | Ação no LedgerContext |
|---|---|---|
| `payment.captured` | `PaymentContext` | DEBIT 1001 / CREDIT 3001 + 2001 (split da captura) |
| `payment.refunded` | `PaymentContext` | DEBIT 3001 + 2001 / CREDIT 2002 (reserva de estorno) |
| `payment.partially_refunded` | `PaymentContext` | Mesma lógica do estorno, proporcional ao valor parcial |
| `chargeback.lost` | `PaymentContext` | DEBIT 4001 / CREDIT 1001 (prejuízo da plataforma) |
| `chargeback.won` | `PaymentContext` | Libera reserva de disputa |
| `settlement.processed` | `SettlementContext` | DEBIT 2001 / CREDIT 1001 (zerando dívida com o vendedor) |
| `payment.settled` | `PaymentContext` | Dispara refresh do `ledger_summary` |

### Eventos emitidos

| Evento | Disparado quando | Consumidor |
|---|---|---|
| `ledger.entry_recorded` | Após persistir um `JournalEntry` | `LedgerWorker` executa `REFRESH MATERIALIZED VIEW CONCURRENTLY ledger_summary` |

### Dependências entre contextos

| Contexto | Tipo de dependência | Detalhe |
|---|---|---|
| `PaymentContext` | Assíncrona via Domain Events | Consome eventos de captura, estorno e chargeback |
| `SettlementContext` | Assíncrona via Domain Events | Consome `settlement.processed` para registrar o payout |

O `LedgerContext` **não tem dependência de saída** — nenhum outro contexto é chamado diretamente por ele. É o contexto mais isolado do sistema.

### Invariante crítica

O trigger PostgreSQL `verify_journal_entry_balance` (`DEFERRABLE INITIALLY DEFERRED`) valida ao final de cada transação que `SUM(DEBIT) = SUM(CREDIT)` para cada `journal_entry_id`. Se a invariante falhar, a transação inteira é revertida. A aplicação também verifica a invariante antes de chegar ao banco.

A métrica `ledger_balance_discrepancy_total > 0` é o alerta mais crítico do sistema — indica inconsistência financeira e exige interrupção imediata de novos processamentos.

### ADRs de referência

[ADR-001](../adr/ADR-001-monetary-precision.md) · [ADR-005](../adr/ADR-005-split-rounding.md) · [ADR-007](../adr/ADR-007-ledger-cqrs.md) · [ADR-010](../adr/ADR-010-chart-of-accounts.md) · [ADR-016](../adr/ADR-016-database-constraints.md)

---

## SplitContext

### Responsabilidades

- Calcular a divisão do valor de um pagamento entre plataforma e vendedor(es)
- Calcular a divisão proporcional em caso de estorno
- Persistir e gerenciar as regras de comissão (`SplitRule`) por vendedor
- Garantir o invariante `sum(parts) === total` em todo cálculo

O `SplitContext` é o único contexto que **não se comunica via eventos assíncronos**. Seu serviço de cálculo (`SplitCalculator`) é consumido de forma síncrona, em-processo, pelos use cases do `PaymentContext`. Não há Domain Events emitidos ou consumidos pelo `SplitContext`.

### Entidades e Value Objects principais

| Tipo | Nome | Descrição |
|---|---|---|
| Entidade | `SplitRule` | Regra de comissão de um vendedor: `commission_rate` e `flat_fee_cents`. Apenas uma ativa por vendedor por vez |
| Value Object | `CommissionRate` | Branded Type `number` no intervalo `[0.0, 1.0]` |
| Serviço de domínio | `SplitCalculator` | Único ponto de cálculo de split no sistema. Expõe `calculate()` e `calculateMulti()` |
| DTO | `SplitResult` | Resultado imutável: `{ platform: Cents, seller: Cents, total: Cents, rate: CommissionRate }` |

### Estratégia de cálculo

**Padrão (dois destinatários):**
```
platform = Math.floor(totalCents × commissionRate)
seller   = totalCents - platform        ← recebe o remainder
```

**Multi-seller:**
```
Cada parte = Math.floor(totalCents × rate_i)
remainder  = total - soma_das_partes    → adicionado ao último destinatário
```

Invariante obrigatória em ambos os casos: `sum(parts) === total`. Falha nessa invariante é erro crítico imediato — não um `Result.err()`. Ver [ADR-005](../adr/ADR-005-split-rounding.md).

### Dependências entre contextos

| Contexto | Tipo de dependência | Detalhe |
|---|---|---|
| `PaymentContext` | É consumido por | `RefundPaymentUseCase` chama `SplitCalculator` de forma síncrona para calcular o split do estorno |
| `SellerContext` | Lê configuração de | `SplitRule` é persistida pelo `SellerContext`; o `PaymentContext` lê a regra ativa do vendedor |

### ADRs de referência

[ADR-001](../adr/ADR-001-monetary-precision.md) · [ADR-005](../adr/ADR-005-split-rounding.md) · [ADR-006](../adr/ADR-006-refund-strategy.md)

---

## SettlementContext

### Responsabilidades

- Calcular a data de payout de cada pagamento capturado com base no `SettlementSchedule` do vendedor
- Criar e gerenciar `SettlementItem` para cada pagamento capturado
- Executar payouts diários via gateway externo (diariamente às 06:00 UTC)
- Emitir evento de settlement processado para o `LedgerContext` registrar a saída financeira

### Entidades e Value Objects principais

| Tipo | Nome | Descrição |
|---|---|---|
| Entidade | `SettlementItem` | Representa um payout futuro. Status: `PENDING`, `PROCESSING`, `PROCESSED`, `FAILED` |
| Value Object | `SettlementSchedule` | Prazo de liquidação: `D+1`, `D+2`, `D+14` (padrão novos vendedores), `D+30` |
| Serviço de domínio | `SettlementScheduler` | Calcula `payout_date = captured_at + N dias corridos`, normalizada para meia-noite UTC |

### Eventos consumidos

| Evento | Origem | Ação no SettlementContext |
|---|---|---|
| `payment.captured` | `PaymentContext` | Cria `SettlementItem` com `payout_date` calculada e status `PENDING` |

### Eventos emitidos

| Evento | Disparado quando | Consumidor |
|---|---|---|
| `settlement.processed` | Payout executado com sucesso pelo `SettlementWorker` | `LedgerContext` registra DEBIT 2001 / CREDIT 1001 |

### Dependências entre contextos

| Contexto | Tipo de dependência | Detalhe |
|---|---|---|
| `PaymentContext` | Assíncrona via Domain Events | Consome `payment.captured` para criar `SettlementItem` |
| `LedgerContext` | Assíncrona via Domain Events | Emite `settlement.processed`; Ledger registra a saída financeira |
| `SellerContext` | Lê configuração de | Lê o `SettlementSchedule` configurado por vendedor para calcular `payout_date` |

### Comportamento em falha

Não existe retry via BullMQ para o `ProcessSettlementUseCase`. Ao falhar, `uow.run()` faz rollback e o `SettlementItem` permanece com status `PENDING`. O cron do dia seguinte (06:00 UTC) encontra o item vencido e reprocessa. A métrica `settlement_items_overdue_total > 0` dispara alerta.

### ADRs de referência

[ADR-009](../adr/ADR-009-outbox-pattern.md) · [ADR-010](../adr/ADR-010-chart-of-accounts.md) · [ADR-011](../adr/ADR-011-settlement-schedule.md)

---

## WebhookContext

### Responsabilidades

- Receber e validar callbacks do gateway externo (Stripe/Asaas)
- Garantir autenticidade via HMAC-SHA256
- Garantir idempotência via `event_id` do gateway
- Mapear status internos do gateway para `PaymentStatus` do sistema
- Processar cada webhook dentro de transação ACID com `SELECT FOR UPDATE`

O `WebhookContext` é o ponto de entrada de eventos externos do gateway. Sua única saída é a transição de estado de um `Payment` — o que o torna um contexto de integração, não de negócio próprio.

### Entidades e Value Objects principais

O `WebhookContext` não define entidades próprias. Opera sobre entidades do `PaymentContext`.

| Componente | Descrição |
|---|---|
| `ProcessWebhookUseCase` | Valida assinatura, verifica idempotência por `event_id`, e executa a transição de status com lock |
| `WebhookMapper` | Converte status do gateway (ex: `payment_intent.succeeded`) para `PaymentStatus` interno. Status desconhecidos mapeados para `FAILED` — nunca ignorados silenciosamente |

### Eventos consumidos

| Fonte | Evento | Ação |
|---|---|---|
| Gateway externo (HTTP POST) | Qualquer status de pagamento (ex: `payment_intent.succeeded`, `charge.dispute.created`) | `WebhookMapper` mapeia para `PaymentStatus`; `payment.transition()` executada com `SELECT FOR UPDATE` |

### Eventos emitidos

O `WebhookContext` não emite eventos próprios. A transição de status disparada por ele produz um Domain Event do `PaymentContext` (ex: `PaymentCapturedEvent`), que é então publicado via Outbox pelo `PaymentContext`.

### Dependências entre contextos

| Contexto | Tipo de dependência | Detalhe |
|---|---|---|
| `PaymentContext` | Modifica diretamente | `ProcessWebhookUseCase` transiciona o `Payment` via `payment.transition()` |

### Race condition documentada

Webhook pode chegar antes da resposta síncrona do gateway ao `PaymentWorker`. O `SELECT FOR UPDATE` garante que apenas um dos dois processos executa a transição. O segundo encontra o estado já atualizado e retorna sucesso idempotente. Ver [ADR-003](../adr/ADR-003-sync-async-processing.md), [business-rules.md §4.3](../business-rules.md).

### ADRs de referência

[ADR-002](../adr/ADR-002-idempotency-storage.md) · [ADR-003](../adr/ADR-003-sync-async-processing.md) · [ADR-004](../adr/ADR-004-payment-state-machine.md)

---

## SellerContext

### Responsabilidades

- Cadastrar e gerenciar vendedores (merchants) da plataforma
- Persistir configurações financeiras por vendedor: `SplitRule` (comissão) e `SettlementSchedule` (prazo de liquidação)
- Gerenciar contas bancárias para payout
- Controlar o status do vendedor (`ACTIVE`, `SUSPENDED`, `PENDING_VERIFICATION`)

### Entidades e Value Objects principais

| Tipo | Nome | Descrição |
|---|---|---|
| Entidade | `Seller` | Vendedor. Status: `ACTIVE`, `SUSPENDED`, `PENDING_VERIFICATION`. Ver `sellers` no data-model |
| Entidade | `SplitRule` | Regra de comissão ativa do vendedor. Pertence ao `SplitContext` conceitualmente; persistida em tabela própria |
| Value Object | `BankAccount` | Dados bancários para payout (armazenados como JSONB — campo sensível mascarado nos logs) |
| Value Object | `SettlementSchedule` | Prazo de liquidação configurado para o vendedor |

### Eventos emitidos

> ⚠️ A definir — eventos de domínio emitidos pelo `SellerContext` (ex: `seller.created`, `seller.suspended`) não estão detalhados nas fontes disponíveis. As ações auditáveis (`seller.created`, `seller.bank_account_updated`, `seller.suspended`, `seller.settlement_schedule_changed`) estão listadas em [ADR-018](../adr/ADR-018-audit-log.md), mas sem especificação de eventos para consumo por outros contextos.

### Dependências entre contextos

| Contexto | Tipo de dependência | Detalhe |
|---|---|---|
| `SplitContext` | Fornece configuração para | `SplitRule` ativa do vendedor é lida pelo `PaymentContext` ao criar um pagamento |
| `SettlementContext` | Fornece configuração para | `SettlementSchedule` do vendedor é lido ao calcular `payout_date` |

### ADRs de referência

[ADR-018](../adr/ADR-018-audit-log.md) · [ADR-019](../adr/ADR-019-sensitive-data-masking.md)

---

## NotificationContext

### Responsabilidades

- Emitir webhooks de saída (outbound) para sistemas externos dos merchants quando eventos relevantes ocorrem no sistema (ex: pagamento capturado, estorno confirmado)

> ⚠️ A definir — o `NotificationContext` está referenciado na arquitetura (README.md, overview.md) mas não possui ADR próprio nem implementação detalhada documentada nas fontes disponíveis. Os detalhes abaixo são derivados exclusivamente do que está explicitamente mencionado.

### Dependências entre contextos

| Contexto | Tipo de dependência | Detalhe |
|---|---|---|
| `PaymentContext` | Consome eventos de | Recebe Domain Events de transição de status para notificar merchants externos |

---

## Tabela de dependências entre contextos

Resumo das relações de dependência. Leitura: a linha depende da coluna.

| | Payment | Ledger | Split | Settlement | Webhook | Seller | Notification |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Payment** | — | emite → | chama sync | emite → | recebe ← | lê config | emite → |
| **Ledger** | consome ← | — | — | consome ← | — | — | — |
| **Split** | — | — | — | — | — | lê config | — |
| **Settlement** | consome ← | emite → | — | — | — | lê config | — |
| **Webhook** | modifica → | — | — | — | — | — | — |
| **Seller** | — | — | fornece → | fornece → | — | — | — |
| **Notification** | consome ← | — | — | — | — | — | — |

**Legenda:** `emite →` = publica evento para; `consome ←` = consome evento de; `chama sync` = chamada síncrona em-processo; `lê config` = lê dados de configuração; `modifica →` = modifica entidade de; `fornece →` = fornece configuração para.

---

## Princípios de integração entre contextos

1. **Sem chamada direta entre repositórios**: nenhum use case de um contexto importa o repositório de outro. A única exceção aceita é a leitura de configuração do `SellerContext` (SplitRule, SettlementSchedule), que é necessária no início do fluxo de pagamento.

2. **Eventos como contratos**: o payload de um Outbox Event é o contrato entre contextos. Mudanças no payload exigem versionamento ou tratamento retrocompatível no consumidor.

3. **Idempotência no consumidor**: todo worker que consome eventos do Outbox deve verificar o `event_id` (ou `source_event_id` em `journal_entries`) antes de processar. Entrega at-least-once é garantida pelo Outbox; exatamente-uma-vez é responsabilidade do consumidor. Ver [ADR-009](../adr/ADR-009-outbox-pattern.md).

4. **Sem estado compartilhado**: contextos diferentes não compartilham tabelas. Cada contexto é dono exclusivo das suas tabelas. Leituras cruzadas acontecem apenas para configuração (SplitRule, SettlementSchedule) e são leituras, não escritas.
