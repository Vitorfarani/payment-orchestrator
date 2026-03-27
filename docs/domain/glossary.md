# Glossário — Linguagem Ubíqua do Payment Orchestrator

> Fonte de verdade para os termos de domínio usados no código, nos ADRs e nas regras de negócio.
> Onde há conflito entre este documento e um ADR, o ADR prevalece.
> Onde há conflito entre um ADR e o código implementado, o código prevalece.

---

## Índice

- [Payment (Contexto de Pagamento)](#payment-contexto-de-pagamento)
- [Ledger (Contexto Contábil)](#ledger-contexto-contábil)
- [Split (Contexto de Divisão de Receita)](#split-contexto-de-divisão-de-receita)
- [Settlement (Contexto de Liquidação)](#settlement-contexto-de-liquidação)
- [Webhook (Contexto de Callbacks)](#webhook-contexto-de-callbacks)
- [Transversal — Tipos, Erros e Infraestrutura](#transversal--tipos-erros-e-infraestrutura)

---

## Payment (Contexto de Pagamento)

### Payment
Entidade central do sistema. Representa uma intenção de cobrança de um comprador em favor de um vendedor, intermediada pela plataforma. Um `Payment` tem um ciclo de vida controlado por uma State Machine de 13 estados. Cada transição de estado dispara exatamente um Domain Event.

Ver: `src/domain/payment/Payment.ts`, [ADR-004](../adr/ADR-004-payment-state-machine.md)

---

### PaymentStatus
O estado atual de um `Payment`. Existem 13 estados possíveis, nomeados como discriminated union TypeScript. O compilador garante que todo novo estado adicionado force atualização de todos os `switch` no código via `assertNever`.

Estados:

| Status | Significado |
|---|---|
| `PENDING` | Pagamento criado; aguardando envio ao gateway |
| `PROCESSING` | Enviado ao gateway; aguardando resposta |
| `REQUIRES_ACTION` | Gateway exige ação adicional do comprador (ex: autenticação 3DS) |
| `AUTHORIZED` | Fundos reservados no cartão; ainda não capturados |
| `CAPTURED` | Cobrança efetivada. Dinheiro garantido. Gera `JournalEntry` no Ledger |
| `SETTLED` | Gateway liquidou o valor na conta da plataforma |
| `REFUNDED` | Estornado totalmente ao comprador |
| `PARTIALLY_REFUNDED` | Estornado parcialmente |
| `FAILED` | Falha no processamento; sem cobrança |
| `CANCELLED` | Cancelado antes de ser processado; sem cobrança |
| `DISPUTED` | Chargeback aberto pelo comprador |
| `CHARGEBACK_WON` | Disputa resolvida em favor da plataforma |
| `CHARGEBACK_LOST` | Disputa perdida; prejuízo registrado no Ledger |

Ver: [ADR-004](../adr/ADR-004-payment-state-machine.md), [business-rules.md §3](../business-rules.md)

---

### Estado Terminal
Estado do qual não existe nenhuma transição de saída. Uma vez atingido, o `Payment` não pode mais mudar de status.

Estados terminais: `REFUNDED`, `FAILED`, `CANCELLED`, `CHARGEBACK_WON`, `CHARGEBACK_LOST`.

Ver: [ADR-004](../adr/ADR-004-payment-state-machine.md)

---

### State Machine (Máquina de Estados)
Implementação na entidade `Payment` que controla quais transições de status são válidas. O mapa de transições é declarado como constante `VALID_TRANSITIONS` — única fonte de verdade. Transições inválidas retornam `Result.err()` com `BusinessRuleError`; nunca lançam exceção.

```
PENDING → PROCESSING → AUTHORIZED → CAPTURED → SETTLED
                    ↘ REQUIRES_ACTION  ↘ CANCELLED  ↓         ↓
                    ↘ FAILED                  REFUNDED  PARTIALLY_REFUNDED → REFUNDED
                                              DISPUTED → CHARGEBACK_WON
                                                       → CHARGEBACK_LOST
```

Ver: [ADR-004](../adr/ADR-004-payment-state-machine.md)

---

### assertNever
Função utilitária usada em `switch/case` sobre `PaymentStatus`. Se um novo estado for adicionado ao tipo e o `switch` não for atualizado, o TypeScript recusa compilar. Garante cobertura total de estados em tempo de compilação.

Ver: `src/domain/payment/value-objects/PaymentStatus.ts`, [ADR-004](../adr/ADR-004-payment-state-machine.md)

---

### Domain Event
Registro imutável de algo que aconteceu no domínio. Cada transição de `PaymentStatus` dispara exatamente um Domain Event correspondente (ex: `PaymentCapturedEvent`, `PaymentRefundedEvent`). Eventos são o mecanismo de comunicação entre o `PaymentContext` e o `LedgerContext` — o Payment não conhece o Ledger diretamente.

Eventos também existem fora de transições: `PaymentCreatedEvent` é disparado no momento da criação da entidade, antes de qualquer transição de estado.

Ver: `src/domain/payment/events/`, [ADR-004](../adr/ADR-004-payment-state-machine.md)

---

### payment_status_history
Tabela que registra cada transição de status com timestamp e metadados do evento que a causou. Permite reconstituir o histórico completo de um pagamento para auditoria e debugging.

Ver: `docs/architecture/data-model.md`

---

### Chargeback
Contestação de cobrança iniciada pelo comprador junto ao banco emissor ou operadora de cartão, sem envolvimento da plataforma. Diferente de um estorno voluntário (`Refund`), o chargeback é imposto externamente. Transiciona o `Payment` para `DISPUTED`, com resolução em `CHARGEBACK_WON` ou `CHARGEBACK_LOST`.

Em caso de `CHARGEBACK_LOST`, a plataforma absorve o valor total e registra como `Expense Chargeback Loss` (conta 4001). O vendedor não é debitado automaticamente. Ver: [ADR-006](../adr/ADR-006-refund-strategy.md)

---

### Refund (Estorno)
Devolução de valor ao comprador, iniciada pela plataforma ou pelo vendedor. Diferente do Chargeback, é um ato voluntário. O valor estornado é revertido proporcionalmente ao split original: plataforma devolve sua comissão, vendedor devolve sua parte.

Dois tipos:
- **Estorno total**: `refundAmountCents` omitido ou igual ao valor original → transição para `REFUNDED`
- **Estorno parcial**: `refundAmountCents` menor que o valor original → transição para `PARTIALLY_REFUNDED`

Ver: [ADR-006](../adr/ADR-006-refund-strategy.md), [business-rules.md §6](../business-rules.md)

---

### Idempotency Key (`x-idempotency-key`)
Chave gerada pelo cliente e enviada no header HTTP de requisições que modificam estado (`POST /payments`, `POST /payments/:id/refund`). Garante que a operação seja processada exatamente uma vez, independente de quantas vezes a requisição for enviada.

- Mínimo 8 caracteres, recomendado UUID v4
- Válida por 24 horas no cache Redis; registro permanente no PostgreSQL
- Internamente prefixada com `merchant_id` para isolamento entre clientes

Estados de uma chave:
- `PROCESSING`: operação em andamento → retorna `409 IDEMPOTENCY_CONFLICT`
- `COMPLETED`: operação concluída → retorna resultado original sem reprocessar

Ver: [ADR-002](../adr/ADR-002-idempotency-storage.md), [business-rules.md §2](../business-rules.md)

---

### poll_url
URL retornada no corpo da resposta `201` de `POST /payments`. Como o processamento é assíncrono, o cliente usa essa URL (`GET /payments/:id`) para consultar o status atual do pagamento enquanto aguarda o resultado final.

Ver: [ADR-003](../adr/ADR-003-sync-async-processing.md)

---

### Gateway
Provedor externo de processamento de pagamentos — Stripe ou Asaas (modo sandbox). Responsável por autorizar, capturar e liquidar cobranças junto às operadoras de cartão. O sistema se protege de instabilidades do gateway via Circuit Breaker.

Ver: [ADR-008](../adr/ADR-008-circuit-breaker.md)

---

### PaymentWorker
Worker BullMQ responsável por toda comunicação com o gateway externo. Consome dois tipos de evento do Outbox:

- **`payment.created`**: executa a cobrança (`gateway.charge()`), transiciona o status para `AUTHORIZED` ou `FAILED`, e publica o resultado de volta no Outbox.
- **`payment.refunded`**: executa o estorno (`gateway.refund()`), cujo resultado é publicado no Outbox para atualização de status e registro no Ledger.

Nunca publica diretamente na fila BullMQ — toda publicação de resultado é feita via Outbox na mesma transação. É onde o Circuit Breaker e o retry com backoff estão configurados.

Ver: `src/infrastructure/queue/workers/PaymentWorker.ts`, [ADR-003](../adr/ADR-003-sync-async-processing.md), [ADR-006](../adr/ADR-006-refund-strategy.md)

---

### Circuit Breaker
Padrão de resiliência implementado com a biblioteca `opossum`. Protege o sistema quando o gateway está degradado: após 5 falhas em janela de 10 chamadas, o circuito abre por 30 segundos, e requisições falham imediatamente sem esperar timeout. Há um circuito independente por gateway (`stripe-circuit`, `asaas-circuit`).

Estados: `CLOSED` (normal) → `OPEN` (protegido) → `HALF-OPEN` (testando recuperação) → `CLOSED`.

Ver: [ADR-008](../adr/ADR-008-circuit-breaker.md)

---

### CreatePaymentUseCase
Use case que recebe a requisição de criação de pagamento. Sua responsabilidade é: criar a entidade `Payment` com status `PENDING`, persistir o payment e o `OutboxEvent(payment.created)` na mesma transação, e retornar o DTO ao controller. **Não chama o gateway** — isso é responsabilidade do `PaymentWorker`.

O controller (`PaymentController`) é quem formata a resposta HTTP `201` com `status: "PROCESSING"` e `poll_url`. O use case retorna a entidade com status `PENDING`; o `PROCESSING` na resposta é uma representação do estado do processamento para o cliente, não o status interno do Payment.

Ver: `src/application/payment/CreatePaymentUseCase.ts`, [ADR-003](../adr/ADR-003-sync-async-processing.md)

---

### RefundPaymentUseCase
Use case que processa estornos. Valida que o estado atual permite estorno (`CAPTURED`, `SETTLED` ou `PARTIALLY_REFUNDED`), calcula o split proporcional do estorno, transiciona o status via `payment.transition()`, persiste o novo estado e o `OutboxEvent(payment.refunded)` na mesma transação. **Não chama `gateway.refund()` diretamente** — a chamada ao gateway é responsabilidade do `PaymentWorker` ao consumir o evento `payment.refunded` do Outbox.

Ver: `src/application/payment/RefundPaymentUseCase.ts`, [ADR-006](../adr/ADR-006-refund-strategy.md), [business-rules.md §6.1](../business-rules.md)

---

## Ledger (Contexto Contábil)

### Ledger (Razão)
O registro contábil de todas as movimentações financeiras do sistema. Implementa contabilidade de dupla entrada (double-entry bookkeeping): toda movimentação gera ao menos duas entradas, garantindo que a soma de todos os débitos sempre iguala a soma de todos os créditos.

O Ledger é a **fonte de verdade financeira** do sistema. Qualquer valor pode ser reconstituído a partir do histórico imutável de entradas.

Ver: [ADR-010](../adr/ADR-010-chart-of-accounts.md)

---

### Double-Entry Bookkeeping (Contabilidade de Dupla Entrada)
Sistema contábil onde toda movimentação é registrada em ao menos duas contas: uma a débito e outra a crédito, de valor equivalente. Invariante obrigatório: `SUM(DEBIT) = SUM(CREDIT)` em toda `JournalEntry`. Este invariante é validado em dois níveis: na aplicação e por um trigger `DEFERRABLE INITIALLY DEFERRED` no PostgreSQL.

Ver: [ADR-010](../adr/ADR-010-chart-of-accounts.md), [ADR-016](../adr/ADR-016-database-constraints.md)

---

### JournalEntry (Lançamento Contábil)
Registro de um evento financeiro no Ledger. Agrupa um conjunto de `LedgerEntry` (as linhas de débito e crédito individuais) sob uma descrição e timestamp comum. **Imutável por design**: nunca sofre `UPDATE` ou `DELETE`. Erros são corrigidos com reversing entries.

Campos chave: `payment_id`, `description`, `occurred_at` (quando o evento aconteceu), `created_at` (quando foi inserido).

Ver: `docs/architecture/data-model.md`

---

### LedgerEntry (Linha de Lançamento)
Linha individual de um `JournalEntry`. Representa um débito ou crédito em uma conta específica (`account_code`) por um valor em centavos. Toda `JournalEntry` tem ao menos duas `LedgerEntry`.

Campos: `journal_entry_id`, `account_code`, `entry_type` (`DEBIT` ou `CREDIT`), `amount_cents`.

Ver: `docs/architecture/data-model.md`

---

### Debit (Débito)
Em contabilidade de dupla entrada:
- **Aumenta** contas do tipo ASSET e EXPENSE
- **Diminui** contas do tipo LIABILITY e REVENUE

Exemplo: ao capturar um pagamento, a conta `1001 Receivable Gateway` (ASSET) é **debitada** — o valor a receber do gateway aumenta.

---

### Credit (Crédito)
Em contabilidade de dupla entrada:
- **Aumenta** contas do tipo LIABILITY e REVENUE
- **Diminui** contas do tipo ASSET e EXPENSE

Exemplo: ao capturar um pagamento, a conta `3001 Revenue Platform` (REVENUE) é **creditada** — a receita da plataforma aumenta.

---

### Reversing Entry (Lançamento de Estorno)
Técnica contábil usada para corrigir um `JournalEntry` incorreto sem modificar o registro original. Cria-se um novo lançamento com os débitos e créditos invertidos (anulando o efeito do original), seguido de um novo lançamento correto se necessário. **A única forma aceita de corrigir entradas contábeis neste sistema.**

Ver: [ADR-010](../adr/ADR-010-chart-of-accounts.md)

---

### Chart of Accounts (Plano de Contas)
Conjunto fixo e versionado das 7 contas contábeis reconhecidas pelo sistema. Nenhuma conta pode ser criada em runtime — toda nova conta requer uma migration e atualização do enum de domínio.

| Código | Nome | Tipo |
|---|---|---|
| 1001 | Receivable Gateway | ASSET |
| 2001 | Payable Seller | LIABILITY |
| 2002 | Payable Refund | LIABILITY |
| 3001 | Revenue Platform | REVENUE |
| 3002 | Revenue Chargeback Fee | REVENUE |
| 4001 | Expense Chargeback Loss | EXPENSE |
| 4002 | Expense Gateway Fee | EXPENSE |

Ver: [ADR-010](../adr/ADR-010-chart-of-accounts.md), [chart-of-accounts.md](chart-of-accounts.md)

---

### AccountType (Tipo de Conta)
Classificação contábil de uma conta. Define o comportamento de débitos e créditos sobre ela.

| Tipo | Descrição |
|---|---|
| `ASSET` | O que a plataforma tem a receber ou possui |
| `LIABILITY` | O que a plataforma deve a terceiros |
| `REVENUE` | Ganhos da operação da plataforma |
| `EXPENSE` | Custos operacionais da plataforma |

---

### CQRS (Command Query Responsibility Segregation)
Padrão aplicado ao Ledger para separar o modelo de escrita do modelo de leitura. O **write model** é normalizado (tabelas `accounts`, `journal_entries`, `ledger_entries`) e otimizado para integridade ACID. O **read model** é uma `MATERIALIZED VIEW` (`ledger_summary`) pré-agregada para queries do dashboard de conciliação.

O dashboard **nunca consulta as tabelas normalizadas diretamente**.

Ver: [ADR-007](../adr/ADR-007-ledger-cqrs.md)

---

### ledger_summary
`MATERIALIZED VIEW` do PostgreSQL que constitui o read model do Ledger. Contém uma linha por combinação de `(seller_id, date, account_code)` com totais de débitos, créditos e contagem de lançamentos pré-calculados. Atualizada pelo `LedgerWorker` após cada `JournalEntry` processada, com fallback de job a cada 5 minutos.

Ver: `docs/architecture/data-model.md`, [ADR-007](../adr/ADR-007-ledger-cqrs.md)

---

### LedgerWorker
Worker BullMQ responsável por processar eventos do Outbox que requerem registro contábil (ex: `payment.captured`, `payment.refunded`, `chargeback.lost`). Cria as `JournalEntry` e `LedgerEntry` correspondentes e dispara o refresh do `ledger_summary`. Idempotente via `source_event_id`. Configurado com 8 tentativas de retry (mais que o padrão de 5), por ser o worker de maior criticidade.

Ver: `src/infrastructure/queue/workers/LedgerWorker.ts`

---

### occurred_at vs created_at (em JournalEntry)
`occurred_at`: timestamp do evento financeiro que originou o lançamento (quando o pagamento foi capturado, quando o estorno foi solicitado). `created_at`: timestamp de quando o registro foi inserido no banco. São campos distintos para suportar lançamentos retroativos — como estornos referentes a datas passadas.

Ver: `docs/architecture/data-model.md`

---

### LedgerBalanceDiscrepancy
Métrica Prometheus `ledger_balance_discrepancy_total`. Qualquer valor maior que zero representa inconsistência financeira e é tratado como incidente crítico — exige parar novos processamentos e executar o runbook `docs/runbooks/ledger-discrepancy.md` imediatamente.

---

## Split (Contexto de Divisão de Receita)

### Split
Divisão do valor de um pagamento entre a plataforma e o(s) vendedor(es), conforme as regras de comissão configuradas. O split é calculado no momento da captura e registrado no Ledger como parte do `JournalEntry` de captura.

---

### SplitRule (Regra de Split)
Configuração de comissão associada a um vendedor. Define a `commission_rate` (percentual da plataforma) e opcionalmente um `flat_fee_cents` (taxa fixa). Persiste no banco; cada vendedor pode ter múltiplas regras, mas apenas uma ativa por vez.

Ver: `docs/architecture/data-model.md`

---

### CommissionRate (Taxa de Comissão)
Proporção do valor total do pagamento que pertence à plataforma. Branded Type `number` no intervalo `[0.0, 1.0]`. Exemplo: `0.08` = 8% de comissão.

Ver: `src/domain/shared/types.ts`, [ADR-015](../adr/ADR-015-branded-types-strict.md)

---

### SplitCalculator
Classe de domínio com um único método `calculate()` responsável por todo cálculo de split. É o único lugar no sistema onde o split é calculado — não existe cálculo de split em outro lugar. Implementa a estratégia de arredondamento definida em [ADR-005](../adr/ADR-005-split-rounding.md).

Ver: `src/domain/split/SplitCalculator.ts`

---

### SplitResult
Resultado imutável de um cálculo de split. Contém: `platform` (centavos para a plataforma), `seller` (centavos para o vendedor), `total` (valor original) e `rate` (taxa aplicada). Invariante obrigatória: `platform + seller === total`. Se esta invariante falhar, é um erro crítico imediato — não um `Result.err()`.

Ver: [ADR-005](../adr/ADR-005-split-rounding.md)

---

### Estratégia "Truncate and Assign Remainder"
Regra de arredondamento do split: a plataforma recebe `Math.floor(total × rate)` (sempre truncado para baixo); o vendedor recebe `total - platform` (o remainder). O centavo fracionário que sobra **sempre vai para o vendedor**.

Para multi-seller: cada parte calculada com `Math.floor`; o remainder vai para o **último destinatário da lista**.

Ver: [ADR-005](../adr/ADR-005-split-rounding.md)

---

### Multi-Seller
Cenário onde um único pagamento é dividido entre mais de dois destinatários (plataforma + múltiplos vendedores, em pedidos compostos). `SplitCalculator.calculateMulti()` garante que `soma_das_partes === total` em todo cenário.

Ver: [ADR-005](../adr/ADR-005-split-rounding.md), [business-rules.md §5.2](../business-rules.md)

---

### Estorno Proporcional
Estratégia de cálculo do split em caso de estorno: as mesmas proporções do split original são aplicadas ao valor estornado. A plataforma devolve `Math.floor(refundAmount × commissionRate)` e o vendedor devolve o remainder.

Ver: [ADR-006](../adr/ADR-006-refund-strategy.md), [business-rules.md §5.3](../business-rules.md)

---

## Settlement (Contexto de Liquidação)

### Settlement (Liquidação)
Transferência do valor do vendedor da plataforma para a conta bancária do vendedor, após o período de hold. O momento do settlement é determinado pelo `SettlementSchedule` configurado para cada vendedor.

---

### SettlementSchedule (Agenda de Liquidação)
Configuração de prazo entre a captura de um pagamento e o payout ao vendedor. Configurável por vendedor.

| Schedule | Dias (corridos) | Uso |
|---|---|---|
| D+1 | 1 | Vendedores verificados, alto volume |
| D+2 | 2 | Vendedores estabelecidos |
| D+14 | 14 | **Padrão para novos vendedores** |
| D+30 | 30 | Alto risco ou monitoramento |

O cálculo usa **dias corridos** (não dias úteis). Se `payout_date` cair em fim de semana, o gateway tentará no próximo dia útil, criando pequena divergência entre a data calculada e o payout efetivo — comportamento aceito e documentado como trade-off de v1.

Ver: [ADR-011](../adr/ADR-011-settlement-schedule.md)

---

### SettlementItem
Registro criado no momento da captura de um pagamento, representando o payout futuro a ser executado para o vendedor. Tem status próprio: `PENDING`, `PROCESSING`, `PROCESSED`, `FAILED`. Um pagamento gera exatamente um `settlement_item` (constraint `UNIQUE(payment_id)` no banco).

Ver: `docs/architecture/data-model.md`, [ADR-011](../adr/ADR-011-settlement-schedule.md)

---

### payout_date
Data calculada para execução do payout ao vendedor, normalizada para meia-noite UTC: `captured_at + N dias corridos`. Calculada no momento da captura pelo `SettlementScheduler`.

Ver: [ADR-011](../adr/ADR-011-settlement-schedule.md)

---

### Hold Period
Período entre a captura de um pagamento e o payout ao vendedor, durante o qual o valor fica retido na plataforma. Protege contra chargebacks dentro da janela de hold. Determinado pelo `SettlementSchedule`.

---

### SettlementWorker
Worker BullMQ que roda diariamente às **06:00 UTC** via cron job. Processa todos os `settlement_items` com `payout_date <= hoje` e `status = PENDING`. Usa `SELECT FOR UPDATE` para evitar processamento duplicado por múltiplas instâncias. Falhas fazem rollback e o item permanece `PENDING` para ser reprocessado no próximo dia.

Ver: `src/infrastructure/queue/workers/SettlementWorker.ts`, [ADR-011](../adr/ADR-011-settlement-schedule.md)

---

### PayoutBatch

> ⚠️ A definir — o conceito de agrupamento de múltiplos `settlement_items` em um único payout ao gateway não está implementado em v1. Cada item gera um payout individual.

---

## Webhook (Contexto de Callbacks)

### Webhook (Entrada)
Notificação HTTP enviada pelo gateway externo (Stripe/Asaas) para a API do sistema informando mudanças de status de pagamentos. Todo webhook recebido passa por quatro etapas obrigatórias: (1) validação de assinatura HMAC-SHA256, (2) verificação de idempotência por `event_id`, (3) processamento dentro de transação ACID com `SELECT FOR UPDATE`, (4) marcação como processado atomicamente via Outbox.

Ver: `src/application/webhook/ProcessWebhookUseCase.ts`, [ADR-004](../adr/ADR-004-payment-state-machine.md)

---

### event_id
Identificador único do evento enviado pelo gateway no payload do webhook. Usado como chave de idempotência no `ProcessWebhookUseCase` — garante que o mesmo webhook processado duas vezes não cause dupla transição de estado.

---

### HMAC-SHA256
Algoritmo de validação de assinatura usado para verificar a autenticidade de webhooks recebidos. O gateway assina o payload com uma chave secreta compartilhada; o sistema valida a assinatura antes de qualquer processamento. Webhooks sem assinatura válida são rejeitados com `401`.

---

### WebhookMapper
Componente responsável por converter os status internos do gateway (ex: `payment_intent.succeeded` do Stripe) para os `PaymentStatus` internos do sistema. Status desconhecidos são mapeados para `FAILED` com log de warning — nunca ignorados silenciosamente.

Ver: [ADR-004](../adr/ADR-004-payment-state-machine.md)

---

### Race Condition (Webhook vs Gateway Response)
Cenário documentado onde o webhook do gateway chega antes da resposta síncrona da chamada ao gateway pelo `PaymentWorker`. O `ProcessWebhookUseCase` trata isso com `SELECT FOR UPDATE` no pagamento: o segundo processamento encontra o estado já atualizado pelo primeiro e retorna sucesso idempotente sem reprocessar.

Ver: [ADR-003](../adr/ADR-003-sync-async-processing.md), [business-rules.md §4.3](../business-rules.md)

---

### Webhook (Saída)

> ⚠️ A definir — o `NotificationContext` (webhooks de saída para sistemas externos dos merchants) está referenciado na arquitetura mas não tem ADR próprio nem implementação detalhada documentada nas fontes disponíveis.

---

## Transversal — Tipos, Erros e Infraestrutura

### Cents
Branded Type sobre `number` que representa valores monetários em centavos. **Nunca se usa `number` solto para valores monetários.** Garante em compile-time que centavos não são confundidos com outros números. Valores sempre inteiros e não-negativos — o construtor `Cents.of()` rejeita frações e negativos com `ValidationError`.

```typescript
const amount: Cents = Cents.of(10000)  // R$ 100,00
const wrong:  number = 10000           // ERRADO — compilador rejeita atribuição a Cents
```

Ver: `src/domain/shared/types.ts`, [ADR-001](../adr/ADR-001-monetary-precision.md), [ADR-015](../adr/ADR-015-branded-types-strict.md)

---

### Branded Type (Tipo Nominal)
Padrão TypeScript usado no domínio financeiro para criar tipos distintos a partir de primitivos, impedindo confusão acidental em compile-time. O compilador rejeita a passagem de um `SellerId` onde um `PaymentId` é esperado, mesmo sendo ambos `string` internamente.

Branded Types do domínio: `PaymentId`, `SellerId`, `AccountId`, `JournalEntryId`, `LedgerEntryId`, `SplitRuleId`, `IdempotencyKey`, `RequestId`, `Cents`, `CommissionRate`.

Ver: `src/domain/shared/types.ts`, [ADR-015](../adr/ADR-015-branded-types-strict.md)

---

### Result Type
Padrão para tratamento de erros esperados no domínio. Use cases e entidades **nunca lançam exceções** para erros de negócio — retornam `Result<T, DomainError>`. Exceções ficam reservadas para falhas de infraestrutura (banco indisponível, memória esgotada).

```typescript
// Correto
return Result.fail(new InsufficientFundsError(...))

// Errado — nunca em código de domínio ou application
throw new Error('Insufficient funds')
```

Ver: `src/domain/shared/Result.ts`, [ADR-014](../adr/ADR-014-result-type.md)

---

### DomainError
Classe base da hierarquia de erros de domínio. Subclasses:

| Classe | Código | Mapeamento HTTP |
|---|---|---|
| `ValidationError` | `VALIDATION_ERROR` | 400 |
| `BusinessRuleError` | `BUSINESS_RULE_ERROR` | 422 |
| `NotFoundError` | `NOT_FOUND` | 404 |
| `ConflictError` | `CONFLICT` | 409 |

Ver: `src/domain/shared/errors/`, [ADR-014](../adr/ADR-014-result-type.md)

---

### Outbox Pattern
Padrão que elimina o dual-write entre banco de dados e fila de mensagens. Todo evento de domínio é persistido na tabela `outbox_events` **dentro da mesma transação** que persiste a mudança de estado. Um processo separado (`OutboxRelay`) lê a tabela e publica no BullMQ de forma eventual.

Garantia central: se o banco commita, o evento será publicado eventualmente. Se o banco faz rollback, o evento não é publicado. Não existe estado intermediário.

Ver: `src/infrastructure/outbox/OutboxRelay.ts`, [ADR-009](../adr/ADR-009-outbox-pattern.md)

---

### OutboxRelay
Processo que faz polling da tabela `outbox_events` a cada 1 segundo, buscando eventos com `processed = false`. Para cada evento, publica no BullMQ e marca como `processed = true`. Usa `SELECT FOR UPDATE SKIP LOCKED` para suportar múltiplas instâncias sem processamento duplicado.

Ver: `src/infrastructure/outbox/OutboxRelay.ts`, [ADR-009](../adr/ADR-009-outbox-pattern.md)

---

### Dual-Write
Anti-padrão que este sistema **nunca usa**. Ocorre quando uma operação escreve em dois sistemas diferentes (ex: banco + fila) sem garantia atômica entre as duas escritas. Uma falha entre as duas escritas resulta em inconsistência irreparável. O Outbox Pattern substitui o dual-write.

Ver: [ADR-009](../adr/ADR-009-outbox-pattern.md)

---

### At-Least-Once Delivery
Garantia de entrega do Outbox Pattern: o mesmo evento pode ser entregue ao worker mais de uma vez (em caso de falha após publicação mas antes de marcar como processado). Por isso, **todos os workers devem ser idempotentes** — processar o mesmo evento duas vezes produz o mesmo resultado que processar uma vez.

Ver: [ADR-009](../adr/ADR-009-outbox-pattern.md)

---

### Unit of Work (`uow.run()`)
Abstração que encapsula uma transação de banco de dados. Garante que múltiplas operações de escrita (ex: salvar Payment + salvar OutboxEvent) são atômicas — ou todas commitam, ou nenhuma. Uso padrão em todos os use cases que produzem efeitos colaterais.

Ver: `src/application/shared/UnitOfWork.ts`

---

### Audit Log (Log de Auditoria)
Tabela `audit_logs` no PostgreSQL que registra toda ação sensível do sistema: criação de pagamentos, estornos, chargebacks, alterações de split rule, acesso a dados pessoais, e intervenções administrativas. **Imutável**: a role da aplicação (`payment_app_role`) tem `UPDATE` e `DELETE` revogados nessa tabela. Retenção: 7 anos.

Diferente dos logs operacionais (Pino): o audit log responde "quem fez o quê e quando?" — os logs operacionais respondem "o que aconteceu tecnicamente?".

Ver: [ADR-018](../adr/ADR-018-audit-log.md)

---

### SensitiveDataMasker
Componente de infraestrutura que mascara dados sensíveis antes de qualquer serialização em logs ou audit log. Inspeciona tanto nomes de campos (blocklist) quanto valores por regex (ex: formato de CPF, formato de PAN). Uma das três camadas de proteção contra vazamento de dados.

Ver: `src/infrastructure/security/SensitiveDataMasker.ts`, [ADR-019](../adr/ADR-019-sensitive-data-masking.md)

---

### PAN (Primary Account Number)
Número do cartão de crédito/débito. Dado altamente sensível classificado como PCI-DSS. Nunca aparece em logs — mascarado para mostrar apenas os últimos 4 dígitos (`****-****-****-1111`).

Ver: [ADR-019](../adr/ADR-019-sensitive-data-masking.md)

---

### Dead Letter Queue (DLQ)
Destino de jobs BullMQ que esgotaram todas as tentativas de retry (5 padrão; 8 para o LedgerWorker). Jobs na DLQ ficam no `failed` set com alerta automático e requerem intervenção manual. Reprocessamento manual é registrado como `admin.job_reprocessed` no audit log.

Ver: [ADR-012](../adr/ADR-012-dlq-policy.md)

---

### Graceful Shutdown
Processo de encerramento controlado da aplicação ao receber `SIGTERM`. Sequência: para o servidor HTTP (aguarda requests em andamento por até 30s) → drena workers BullMQ (até 60s) → fecha conexões (banco, Redis). Timeout total: 90 segundos.

Ver: [ADR-013](../adr/ADR-013-graceful-shutdown.md)

---

### request_id / trace_id
Campos obrigatórios em todo registro de log. `request_id` identifica unicamente um request HTTP de entrada (gerado pelo middleware de entrada). `trace_id` é o identificador do trace OpenTelemetry, propagado do request HTTP até os workers e as chamadas ao gateway.

Ver: [ADR-017](../adr/ADR-017-observability-strategy.md)

---

### SELECT FOR UPDATE
Comando SQL usado em operações críticas que exigem lock exclusivo sobre uma linha antes de modificá-la. Garante que dois processos concorrentes não processem o mesmo registro simultaneamente. Usado no `ProcessWebhookUseCase` (previne race condition de webhooks duplicados) e no `SettlementWorker` (previne payout duplicado).

---

### SELECT FOR UPDATE SKIP LOCKED
Variante do `SELECT FOR UPDATE` que pula linhas já bloqueadas por outras transações em vez de aguardar. Permite que múltiplas instâncias do `OutboxRelay` operem em paralelo sem bloqueio mútuo, cada instância processando um subconjunto diferente de eventos.

Ver: [ADR-009](../adr/ADR-009-outbox-pattern.md)
