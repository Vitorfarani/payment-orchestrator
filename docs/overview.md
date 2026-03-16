# Visão geral da arquitetura

> Este documento descreve as decisões estruturais do Payment Orchestrator.
> Para o *porquê* de cada decisão individual, consulte os ADRs linkados.

---

## Contexto do problema

Um marketplace precisa garantir que, para cada pagamento processado:

1. O dinheiro seja **dividido corretamente** entre plataforma e vendedor
2. Cada centavo seja **rastreado contabilmente** — nunca some, nunca duplica
3. Nenhuma transação seja **processada duas vezes** mesmo com falhas de rede
4. O sistema seja **auditável** — qualquer valor pode ser reconstituído a partir do histórico
5. Dados sensíveis **nunca vazem** em logs, traces ou mensagens de erro

Esses cinco requisitos determinam praticamente todas as decisões de arquitetura deste projeto.

---

## Princípios de design

**1. O domínio não conhece infraestrutura**
Entidades de domínio (`Payment`, `JournalEntry`, `SplitRule`) não importam nada de fora da camada `domain/`. Nem Knex, nem Express, nem Redis. Isso garante que a lógica de negócio pode ser testada em isolamento total e substituída sem impactar o domínio.

**2. Dinheiro é um tipo, não um número**
`Cents` é um Branded Type sobre `number`. O compilador TypeScript rejeita a confusão acidental de valores monetários com outros números. No banco, `BIGINT NOT NULL CHECK (amount > 0)` — nunca `DECIMAL` ou `FLOAT`. ([ADR-001](../adr/ADR-001-monetary-precision.md), [ADR-015](../adr/ADR-015-branded-types-strict.md))

**3. Erros de domínio são valores, não exceções**
Use cases e entidades de domínio retornam `Result<T, DomainError>` — nunca lançam exceções para erros de negócio previsíveis. Exceções ficam reservadas para falhas de infraestrutura (banco indisponível, memória esgotada). Isso torna os contratos das funções honestos e força o tratamento explícito de erros. ([ADR-014](../adr/ADR-014-result-type.md))

**4. Eventos são persistidos antes de publicados**
O Outbox Pattern garante que a publicação de eventos é atômica com a escrita no banco. Não existe dual-write em nenhuma parte do sistema — nem na API, nem nos workers. ([ADR-009](../adr/ADR-009-outbox-pattern.md))

**5. O Ledger é a fonte de verdade financeira**
Cada movimentação financeira gera um `JournalEntry` de dupla entrada. A soma de todos os débitos sempre iguala a soma de todos os créditos. Entradas são imutáveis — erros são corrigidos com reversing entries, nunca com `UPDATE`. ([ADR-010](../adr/ADR-010-chart-of-accounts.md))

**6. O banco é a segunda linha de defesa**
A aplicação valida primeiro (Branded Types, Result Type, State Machine). O banco valida novamente com `CHECK` constraints e um trigger `DEFERRABLE INITIALLY DEFERRED` que impõe o invariante de double-entry. A falha de uma camada não anula a outra. ([ADR-016](../adr/ADR-016-database-constraints.md))

**7. Idempotência em todas as fronteiras**
API (via `x-idempotency-key`), workers (via `job_id` no BullMQ) e webhook processor (via `event_id` do gateway) são todos idempotentes. Um pagamento pode ser submetido N vezes — será processado exatamente uma vez. ([ADR-002](../adr/ADR-002-idempotency-storage.md))

**8. Ações sensíveis são imutavelmente auditadas**
Todo use case que envolve criação de pagamento, estorno, chargeback, alteração de split rule ou acesso a dados pessoais gera um registro em `audit_logs`. A role da aplicação no PostgreSQL tem `DELETE` revogado nessa tabela — nem código com bug nem script manual pode apagar um registro de auditoria. ([ADR-018](../adr/ADR-018-audit-log.md))

**9. Dados sensíveis nunca aparecem em logs**
Três camadas independentes de proteção garantem que PAN, CVV, CPF e dados bancários não aparecem em nenhum log operacional ou de auditoria. A falha de qualquer camada não expõe o dado. ([ADR-019](../adr/ADR-019-sensitive-data-masking.md))

---

## Diagrama de containers (C4 Level 2)

```
┌──────────────────────────────────────────────────────────────────────┐
│  Usuários externos                                                   │
│  [Comprador]      [Vendedor / Merchant]      [Admin da plataforma]  │
└──────┬──────────────────────┬──────────────────────────┬────────────┘
       │                      │                          │
       ▼                      ▼                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Next.js Frontend                                                   │
│  Checkout de teste · Dashboard de conciliação · Relatórios          │
└─────────────────────────────┬───────────────────────────────────────┘
                              │ HTTPS
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  API (Node.js + Express)                                            │
│  Auth (JWT) · Rate limiting · Idempotency middleware                │
│  Request-ID tracing · Webhook HMAC validation · Audit logging       │
└───┬───────────┬────────────────┬───────────────┬────────────────────┘
    │           │                │               │
    ▼           ▼                ▼               ▼
┌────────┐ ┌────────┐  ┌──────────────┐  ┌──────────────┐
│Postgres│ │ Redis  │  │   BullMQ     │  │Stripe/Asaas  │
│Payments│ │Idempot.│  │Workers:      │  │  Sandbox     │
│Ledger  │ │keys    │  │- Payment     │  │              │
│Outbox  │ │Sessions│  │- Ledger      │  │  ▲ webhooks  │
│Audit   │ │        │  │- Settlement  │  │  │           │
│Settlers│ │        │  │- OutboxRelay │  └──────────────┘
└────────┘ └────────┘  └──────────────┘
```

---

## Bounded Contexts e responsabilidades

### PaymentContext
Ciclo de vida completo de um pagamento — do `PENDING` ao estado terminal.

Entidades: `Payment`, `PaymentAttempt`
Value Objects: `Cents`, `Currency`, `IdempotencyKey`, `PaymentStatus`
Eventos emitidos: `PaymentCreated`, `PaymentAuthorized`, `PaymentCaptured`, `PaymentFailed`, `PaymentRefunded`, `ChargebackLost`

A state machine de `PaymentStatus` é o coração deste contexto. 13 estados, transições validadas em compile-time via `assertNever`, cada transição dispara um Domain Event. ([ADR-004](../adr/ADR-004-payment-state-machine.md))

```
PENDING → PROCESSING → AUTHORIZED → CAPTURED → SETTLED
                    ↘ REQUIRES_ACTION  ↘ CANCELLED  ↓         ↓
                    ↘ FAILED                  REFUNDED  PARTIALLY_REFUNDED
                                              DISPUTED → CHARGEBACK_WON
                                                       → CHARGEBACK_LOST
```

### LedgerContext
Integridade contábil de todas as movimentações financeiras.

Entidades: `Account`, `JournalEntry`, `LedgerEntry`
Princípio: **imutabilidade total**. Entradas nunca são deletadas ou alteradas.

Plano de contas (7 contas fixas e versionadas):
```
1001 Receivable Gateway   ASSET      — a receber do gateway após captura
2001 Payable Seller       LIABILITY  — devido ao vendedor após split
2002 Payable Refund       LIABILITY  — reserva para estornos pendentes
3001 Revenue Platform     REVENUE    — comissão da plataforma
3002 Revenue Chargeback   REVENUE    — taxa de chargeback cobrada do vendedor
4001 Expense Chargeback   EXPENSE    — prejuízo de chargeback perdido
4002 Expense Gateway Fee  EXPENSE    — taxa cobrada pelo gateway
```

Implementa CQRS: write model normalizado para integridade, read model (`MATERIALIZED VIEW`) para o dashboard de conciliação. ([ADR-007](../adr/ADR-007-ledger-cqrs.md), [ADR-010](../adr/ADR-010-chart-of-accounts.md))

### SplitContext
Cálculo e configuração de comissões.

Entidades: `SplitRule`, `Commission`, `SplitResult`
Regra de arredondamento: `Math.floor` para plataforma, remainder ao vendedor. Multi-seller: remainder vai para o último destinatário. Invariante: `sum(parts) === total` sempre. ([ADR-005](../adr/ADR-005-split-rounding.md))

### SettlementContext
Quando e como o dinheiro sai da plataforma para o vendedor.

Conceitos: `SettlementSchedule` (D+1, D+2, D+14, D+30), `SettlementItem`, `PayoutBatch`
Default para novos vendedores: D+14 (dias corridos). Calculado no momento da captura, processado pelo `SettlementWorker` diariamente às 06:00 UTC. ([ADR-011](../adr/ADR-011-settlement-schedule.md))

### WebhookContext
Recebimento e processamento confiável de callbacks do gateway.

Todo webhook recebido: (1) validado por assinatura HMAC-SHA256, (2) verificado por idempotência via `event_id`, (3) processado dentro de transação ACID com `SELECT FOR UPDATE`, (4) marcado como processado atomicamente via Outbox.

Race condition documentada: webhook pode chegar antes da resposta síncrona da chamada ao gateway. Tratado via `SELECT FOR UPDATE` — segundo processamento vê o estado já atualizado e retorna sucesso idempotente.

---

## Padrões de resiliência

### Outbox Pattern
Garante atomicidade entre escrita no banco e publicação de eventos. O `OutboxRelay` usa polling de 1s com `SELECT FOR UPDATE SKIP LOCKED` para suportar múltiplas instâncias sem duplicatas. Entrega at-least-once — workers são idempotentes por design. ([ADR-009](../adr/ADR-009-outbox-pattern.md))

### Circuit Breaker (`opossum`)
Protege o sistema quando o Stripe/Asaas está degradado. Após 5 falhas em janela de 10 chamadas, o circuito abre por 30 segundos. Workers enfileiram para retry — o sistema continua aceitando novos pagamentos mesmo com gateway fora. ([ADR-008](../adr/ADR-008-circuit-breaker.md))

### Retry com backoff exponencial + jitter
Todos os workers usam backoff exponencial com jitter para evitar thundering herd. Configurações específicas por worker (LedgerWorker tem 8 tentativas vs 5 padrão — é o mais crítico). Jobs que esgotam retries vão para o `failed` set (DLQ) com alerta automático. ([ADR-012](../adr/ADR-012-dlq-policy.md))

### Graceful Shutdown
`SIGTERM` → para HTTP (30s) → drena workers (60s) → fecha conexões. Timeout máximo de 90s. `stop_grace_period: 120s` no Docker Compose garante que o orquestrador espera o suficiente. ([ADR-013](../adr/ADR-013-graceful-shutdown.md))

---

## Observabilidade

### Logs (Pino)
JSON estruturado. Campos obrigatórios em todo log: `request_id`, `trace_id`, `service`, `version`. Dados sensíveis mascarados em 3 camadas independentes antes de qualquer serialização. `debug` desabilitado em produção. ([ADR-017](../adr/ADR-017-observability-strategy.md), [ADR-019](../adr/ADR-019-sensitive-data-masking.md))

### Traces (OpenTelemetry)
Contexto propagado do request HTTP até o worker até a chamada ao gateway. Instrumentação automática para Express, Knex e HTTP clients. Exporta para Jaeger em desenvolvimento (`http://localhost:16686`).

### Métricas (Prometheus + Grafana)
Expostas em `GET /metrics`. Dashboard Grafana pré-configurado em `infra/grafana/dashboards/`.

**Alerta mais crítico do sistema:**
```yaml
- alert: LedgerBalanceDiscrepancy
  expr: ledger_balance_discrepancy_total > 0
  for: 1m
  severity: critical
  # Se disparar: parar novos processamentos e executar runbook imediatamente
```

---

## Segurança

| Mecanismo | Implementação | ADR |
|---|---|---|
| Autenticação | JWT com rotação de refresh tokens | — |
| Validação de webhooks | HMAC-SHA256 da assinatura do gateway | — |
| Mascaramento de dados | Pino redact + SensitiveDataMasker + HTTP allowlist | [ADR-019](../adr/ADR-019-sensitive-data-masking.md) |
| Audit log | Imutável, 7 anos, REVOKE DELETE na role | [ADR-018](../adr/ADR-018-audit-log.md) |
| Rate limiting | Por IP e por `merchant_id` | — |
| Secrets | `.env.example` sem valores reais, secretlint no CI | — |

---

## Estratégia de testes

Quatro camadas com propósitos distintos. Nenhuma substitui a outra. ([ADR-020](../adr/ADR-020-testing-strategy.md))

```
E2E (Supertest)            ← ~10 cenários. Fluxos críticos completos.
Contract (Pact)            ← 1 por endpoint do gateway. Detecta breaking changes.
Integration (Testcontainers) ← PostgreSQL e Redis reais. Sem mocks do banco.
Unit (Jest + TDD)          ← >90% cobertura em domain/ e application/.
```

Quality gates no CI — nenhum merge sem todos verdes:
- `tsc --noEmit` — zero erros de tipo
- `eslint --max-warnings 0` — zero warnings
- Coverage gates por camada
- `npm audit --audit-level=high` — zero vulnerabilidades críticas
- `secretlint` — zero secrets no código

---

## Decisões futuras — fora do escopo atual

O design atual não bloqueia nenhuma dessas evoluções:

- **CDC com Debezium:** substituição do Outbox polling por Change Data Capture — mudança de infraestrutura, sem alterar domínio
- **Event Sourcing no Ledger:** `journal_entries` imutáveis são compatíveis — migração sem breaking changes no schema
- **Multi-tenancy:** schema-per-tenant no PostgreSQL — próximo passo natural
- **Kafka:** substituição do BullMQ para volumes maiores — o Outbox Pattern é agnóstico ao broker
- **Dias úteis no settlement:** cálculo de feriados nacionais/bancários — schema de `settlement_items` suporta sem alteração
- **Read model separado para o Ledger:** banco dedicado para queries do dashboard — CQRS com `MATERIALIZED VIEW` é o primeiro passo desta jornada
