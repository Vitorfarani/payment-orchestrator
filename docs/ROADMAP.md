# ROADMAP — Payment Orchestrator

> Documento de continuidade do projeto. Contém estado atual, todas as fases,
> regras obrigatórias e prompts prontos para retomar o trabalho em qualquer sessão.
>
> **Última atualização:** Fase 1 concluída. Iniciando Fase 2.

---

## Estado atual do projeto

```
Fase 0 — Documentação    ✅ CONCLUÍDA
Fase 1 — Fundação        ✅ CONCLUÍDA
Fase 2 — Domain Layer    🔄 EM ANDAMENTO
Fase 3 — Banco de Dados  ⏳ AGUARDANDO
Fase 4 — Infrastructure  ⏳ AGUARDANDO
Fase 5 — Use Cases       ⏳ AGUARDANDO
Fase 6 — Web Layer       ⏳ AGUARDANDO
Fase 7 — Frontend        ⏳ AGUARDANDO
```

**Ambiente de desenvolvimento:** Windows + PowerShell
**Node.js:** 20+
**Docker Desktop:** necessário para PostgreSQL, Redis e stack de observabilidade

---

## Regras obrigatórias — valem para todo o projeto

Estas regras nunca são negociadas. Qualquer PR que viole uma delas é rejeitado.

### Arquitetura
- **Clean Architecture** com quatro camadas: `domain/` → `application/` → `infrastructure/` → `web/`
- **Zero dependências externas** na camada `domain/` — nem Knex, nem Express, nem Redis, nem nada
- A regra de dependência é absoluta: camadas internas nunca importam de camadas externas

### Código TypeScript
- **Branded Types** para todos os identificadores e valores financeiros (`PaymentId`, `SellerId`, `AccountId`, `JournalEntryId`, `IdempotencyKey`, `Cents`, `CommissionRate`, etc.)
- **Result Type** para erros de domínio — nunca `throw` dentro de `domain/` ou `application/`
- **`tsconfig.json` com strict máximo** — `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`
- **`assertNever()`** em todo `switch` sobre tipos discriminados — o compilador garante cobertura total

### Dados financeiros
- Dinheiro é sempre **`BIGINT` centavos** no banco — nunca `DECIMAL`, `FLOAT` ou `number` sem Branded Type
- `Math.floor` para comissão da plataforma, remainder ao vendedor — invariante: `platform + seller === total` sempre
- Double-entry: toda movimentação financeira gera `JournalEntry` com débitos = créditos

### Eventos e mensageria
- **Outbox Pattern obrigatório** para toda publicação de evento — nunca chamar `queue.add()` fora de uma transação junto com `outboxRepo.save()`
- Workers são **idempotentes** — processar o mesmo evento duas vezes tem o mesmo efeito que processar uma vez

### Qualidade
- **TDD** para todo código de domínio — teste antes da implementação (Red → Green → Refactor)
- **Conventional Commits** obrigatórios: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`
- Quality gates no CI — nenhum merge sem todos verdes (veja Fase 1)

---

## Documentação existente

Toda documentação fica em `docs/`. Leia antes de implementar qualquer fase.

```
docs/
├── adr/                             # 20 Architecture Decision Records
│   ├── README.md                    # Índice com status de cada ADR
│   ├── ADR-000-template.md          # Template para novos ADRs
│   ├── ADR-001-monetary-precision.md
│   ├── ADR-002-idempotency-storage.md
│   ├── ADR-003-sync-async-processing.md
│   ├── ADR-004-payment-state-machine.md
│   ├── ADR-005-split-rounding.md
│   ├── ADR-006-refund-strategy.md
│   ├── ADR-007-ledger-cqrs.md
│   ├── ADR-008-circuit-breaker.md
│   ├── ADR-009-outbox-pattern.md
│   ├── ADR-010-chart-of-accounts.md
│   ├── ADR-011-settlement-schedule.md
│   ├── ADR-012-dlq-policy.md
│   ├── ADR-013-graceful-shutdown.md
│   ├── ADR-014-result-type.md
│   ├── ADR-015-branded-types-strict.md
│   ├── ADR-016-database-constraints.md
│   ├── ADR-017-observability-strategy.md
│   ├── ADR-018-audit-log.md
│   ├── ADR-019-sensitive-data-masking.md
│   └── ADR-020-testing-strategy.md
├── architecture/
│   ├── overview.md                  # Visão geral, C4 Level 2, bounded contexts, padrões
│   ├── bounded-contexts.md          # Context map detalhado (criar na Fase 4)
│   └── data-model.md                # ERD e schema (criar na Fase 3)
├── domain/
│   ├── glossary.md                  # Linguagem ubíqua — termos do domínio
│   ├── chart-of-accounts.md         # Plano de contas para não-técnicos (criar na Fase 3)
│   └── business-rules.md            # Regras de negócio consolidadas (criar na Fase 5)
└── runbooks/
    ├── payment-stuck-processing.md
    ├── ledger-discrepancy.md        # (criar na Fase 5)
    ├── webhook-failures.md          # (criar na Fase 6)
    └── queue-backlog.md             # (criar na Fase 4)
```

**ADRs mais críticos para ler antes de começar:**
- ADR-001 — por que centavos inteiros
- ADR-009 — Outbox Pattern (afeta toda publicação de evento)
- ADR-014 — Result Type (afeta todo código de domínio)
- ADR-015 — Branded Types + tsconfig (afeta o setup da Fase 1)

---

## Fase 0 — Documentação ✅ CONCLUÍDA

### O que foi feito
- `README.md` completo com visão geral, stack, decisões e trade-offs
- `docs/architecture/overview.md` com C4 Model, bounded contexts e padrões de resiliência
- 20 ADRs aceitos cobrindo todas as decisões arquiteturais
- `ROADMAP.md` (este arquivo)

### Critério de conclusão
✅ Toda decisão de engenharia documentada antes de escrever código.

---

## Fase 1 — Fundação do projeto ✅ CONCLUÍDA

### O que foi feito
- `package.json` com todas as dependências de produção e desenvolvimento
- `tsconfig.json` com strict máximo conforme ADR-015
- Estrutura de pastas Clean Architecture criada (`domain/`, `application/`, `infrastructure/`, `web/`)
- `docker-compose.yml` com PostgreSQL 16, Redis 7, Prometheus, Grafana e Jaeger — todos com healthcheck
- `.env.example` com todas as variáveis documentadas
- `.eslintrc.js` com regras customizadas do domínio financeiro (proíbe `any`, `as` fora dos branded types, import circular)
- Husky + commitlint com Conventional Commits funcionando
- GitHub Actions com quality gates rodando e verde (`tsc --noEmit`, `eslint`, `secretlint`, `npm audit`, `jest`)
- `.gitattributes` com `eol=lf` para normalizar line endings entre Windows e CI Linux

### Problemas encontrados no Windows — para não repetir
- **Encoding BOM:** PowerShell salva arquivos com BOM (byte order mark) por padrão. Arquivos de hook do Husky com BOM são rejeitados pelo Git bash com erro `command not found`. Solução: criar hooks via `[System.IO.File]::WriteAllText` com `UTF8Encoding($false)` ou editar no VS Code garantindo `UTF-8` sem BOM.
- **TypeScript 5.9 incompatível:** `@typescript-eslint` v7 suporta até TS 5.5. Fixar em `"typescript": "^5.5.4"` no `package.json`.
- **Vulnerabilidades resolvidas via `overrides`:** `cross-spawn`, `underscore` e `undici` tinham vulnerabilidades `high` nas dependências transitivas do `@pact-foundation/pact` e `testcontainers`. Resolvido com bloco `overrides` no `package.json`.
- **Comandos bash não funcionam no PowerShell:** `mkdir -p`, `find`, `touch` não existem. Usar `New-Item -ItemType Directory -Force` e equivalentes PowerShell.

### Critério de conclusão
✅ `tsc --noEmit` sem erros
✅ `eslint` sem warnings
✅ `docker compose ps` com todos os serviços healthy
✅ GitHub Actions verde
✅ Commits no padrão Conventional Commits

---

## Fase 2 — Domain Layer 🔄 EM ANDAMENTO

### O que será feito

**2.1 — Branded Types**
- `src/domain/shared/types.ts` — todos os Branded Types (`PaymentId`, `SellerId`, `AccountId`, `JournalEntryId`, `LedgerEntryId`, `SplitRuleId`, `IdempotencyKey`, `RequestId`, `Cents`, `CommissionRate`)

**2.2 — Result Type + erros de domínio**
- `src/domain/shared/Result.ts` — `Result<T, E>`, `ok()`, `err()`
- `src/domain/shared/errors/` — hierarquia (`DomainError`, `ValidationError`, `BusinessRuleError`, `NotFoundError`, `ConflictError`)

**2.3 — Value Object: Money**
- `Cents` + `Currency`, operações aritméticas seguras
- Primeiro código com TDD

**2.4 — Value Object: IdempotencyKey**
- Validação de formato UUID, imutável, com factory

**2.5 — Entidade: Payment + State Machine**
- `PaymentStatus` — discriminated union com 13 estados
- `VALID_TRANSITIONS` — mapa imutável de transições válidas
- `assertNever()` — garante cobertura total em switches
- `Payment` entity — `create()`, `transition()` retornando `Result`

**2.6 — Eventos de domínio**
- `PaymentCreatedEvent`, `PaymentCapturedEvent`, `PaymentRefundedEvent`, etc.
- Preparação para o Outbox Pattern

**2.7 — Ledger domain**
- `AccountCode` enum — 7 contas do Chart of Accounts (ADR-010)
- `JournalEntry` entity — validação de double-entry no domínio

**2.8 — Split domain**
- `SplitCalculator` — `calculate()` e `calculateMulti()` com invariante `platform + seller === total`

**2.9 — Settlement domain**
- `SettlementSchedule` — tipo e mapa de dias
- `SettlementScheduler.calculatePayoutDate()`

### ADRs relevantes para esta fase
- ADR-001 — Cents
- ADR-004 — State Machine com 13 estados
- ADR-005 — Arredondamento no split
- ADR-010 — Chart of Accounts
- ADR-014 — Result Type
- ADR-015 — Branded Types

### Critério de conclusão
- 100% do código de domínio escrito via TDD
- Cobertura ≥ 90% em `src/domain/`
- Zero dependências externas importadas em qualquer arquivo de `src/domain/`
- `tsc --noEmit` sem erros
- CI verde

---

## Fase 3 — Banco de Dados ⏳ AGUARDANDO

### O que será feito

**3.1 — Setup do Knex**
- Configuração com TypeScript e connection pool

**3.2 — Migrations (em ordem)**
```
001_create_sellers.ts
002_create_payments.ts           ← CHECK constraints de status e amount
003_create_split_rules.ts
004_create_accounts.ts           ← seed das 7 contas (ADR-010)
005_create_journal_entries.ts
006_create_ledger_entries.ts     ← trigger DEFERRABLE de double-entry
007_create_outbox_events.ts      ← índice parcial WHERE processed = false
008_create_settlement_items.ts   ← índice parcial WHERE status = 'PENDING'
009_create_idempotency_keys.ts
010_create_audit_logs.ts         ← REVOKE UPDATE, DELETE da role
011_create_payment_status_history.ts
012_create_ledger_summary_view.ts ← MATERIALIZED VIEW para o dashboard
```

**3.3 — Documentos a criar nesta fase**
- `docs/architecture/data-model.md` — ERD completo
- `docs/domain/chart-of-accounts.md` — versão legível para não-técnicos

### ADRs relevantes para esta fase
- ADR-010 — Chart of Accounts
- ADR-016 — Constraints e trigger de double-entry
- ADR-007 — MATERIALIZED VIEW do Ledger

### Critério de conclusão
- `npm run db:migrate` sem erros
- Trigger de double-entry rejeitando `JournalEntry` desbalanceada (testado via Testcontainers)
- `docs/architecture/data-model.md` criado com ERD

---

## Fase 4 — Infrastructure Layer ⏳ AGUARDANDO

### O que será feito

**4.1 — Repositories**
- `PostgresPaymentRepository`, `PostgresLedgerRepository`, `LedgerQueryRepository`, `PostgresOutboxRepository`, `PostgresSettlementRepository`, `PostgresAuditLogRepository`

**4.2 — Outbox Relay**
- Polling 1s, `SELECT FOR UPDATE SKIP LOCKED`
- Publicação no BullMQ com `jobId = event.id`

**4.3 — Gateway Adapters**
- `IPaymentGateway` — interface no domínio
- `StripeAdapter` e `AsaasAdapter` com Circuit Breaker (ADR-008)

**4.4 — Idempotency Store**
- Redis como cache rápido, PostgreSQL como fallback durável

**4.5 — Workers BullMQ**
- `PaymentWorker`, `LedgerWorker`, `SettlementWorker`
- `jobOptions.ts` com backoff exponencial + jitter

**4.6 — Observabilidade**
- `logger.ts` — Pino com redact de dados sensíveis
- `metrics.ts` — métricas definidas no ADR-017
- `tracing.ts` — OpenTelemetry SDK

**4.7 — Segurança**
- `SensitiveDataMasker` — 3 camadas (ADR-019)
- `AuditLogger` — INSERT-only
- `GracefulShutdown` — SIGTERM handler (ADR-013)

### ADRs relevantes para esta fase
- ADR-002, ADR-008, ADR-009, ADR-012, ADR-013, ADR-017, ADR-018, ADR-019

### Critério de conclusão
- Testes de integração com Testcontainers verdes
- Teste de race condition da idempotência
- `OutboxRelay` testado com `SELECT FOR UPDATE SKIP LOCKED`

---

## Fase 5 — Application Layer (Use Cases) ⏳ AGUARDANDO

### O que será feito
- `CreatePaymentUseCase` — salva Payment + OutboxEvent na mesma transação, retorna imediatamente sem chamar o gateway
- `ProcessWebhookUseCase` — valida HMAC → idempotência → `SELECT FOR UPDATE` → transição
- `RefundPaymentUseCase` — split proporcional + OutboxEvent
- `RecordDoubleEntryUseCase`, `RecordRefundEntryUseCase`
- `ScheduleSettlementUseCase`, `ProcessSettlementUseCase`
- `CalculateSplitUseCase`

### ADRs relevantes para esta fase
- ADR-003, ADR-005, ADR-006, ADR-011

### Critério de conclusão
- Todos os use cases com testes unitários via TDD
- Cobertura ≥ 85% em `src/application/`
- Nenhum use case com `throw` para erros de negócio

---

## Fase 6 — Web Layer (API HTTP) ⏳ AGUARDANDO

### O que será feito
- Middlewares: `RequestContext`, `Idempotency`, `Auth`, `RateLimit`, `ErrorHandler`
- Endpoints: `POST /payments`, `GET /payments/:id`, `POST /webhooks/stripe`, `POST /webhooks/asaas`, `POST /payments/:id/refund`, `GET /ledger/summary`, `GET /health/live`, `GET /health/ready`, `GET /metrics`
- DTOs com Zod (validação na fronteira do sistema)
- Contract Tests com Pact
- E2E Tests com Testcontainers + Supertest

### ADRs relevantes para esta fase
- ADR-002, ADR-003, ADR-017, ADR-018, ADR-019, ADR-020

### Critério de conclusão
- Todos os endpoints funcionando
- Contract tests Pact verdes
- E2E tests verdes
- CI completo verde

---

## Fase 7 — Frontend (Next.js) ⏳ AGUARDANDO

### O que será feito
- Checkout de teste — formulário, polling de status, visualização do split
- Dashboard de conciliação — tabela de transações, filtros, totais por período

### Critério de conclusão
- Fluxo completo funcionando: checkout → pagamento → dashboard
- `next build` sem erros

---

## Fora do escopo da v1

| Feature | Por que excluída | Como seria adicionada |
|---|---|---|
| Event Sourcing no Ledger | `journal_entries` imutáveis já são ES-compatible | Migração sem breaking changes |
| CDC com Debezium | Outbox com polling de 1s é suficiente | Troca o relay, mantém o resto |
| Kafka | BullMQ + Redis resolve o volume esperado | Outbox Pattern é agnóstico ao broker |
| Multi-tenancy | Um marketplace por instância é suficiente | Schema-per-tenant no PostgreSQL |
| Settlement em dias úteis | Feriados adicionam complexidade desproporcional | Schema de `settlement_items` suporta sem alteração |
| Suporte a USD / multi-moeda | Apenas BRL em v1 | ADR futuro define conversão |
| Performance tests | Sem baseline de produção para comparar | Adicionar após v1 em produção |
| Autenticação OAuth2 | JWT simples é suficiente para demonstração | Trocar o AuthMiddleware |

---

## Prompts para retomar o trabalho

Copie o prompt da fase atual e cole em um novo chat com os arquivos indicados.

---

### Prompt — Fase 2 (Domain Layer)

**Arquivos para anexar:** `README.md`, `docs/architecture/overview.md`, `docs/adr/ADR-001-monetary-precision.md`, `docs/adr/ADR-004-payment-state-machine.md`, `docs/adr/ADR-005-split-rounding.md`, `docs/adr/ADR-010-chart-of-accounts.md`, `docs/adr/ADR-014-result-type.md`, `docs/adr/ADR-015-branded-types-strict.md`

```
Você é um Arquiteto de Software Sênior com experiência em sistemas financeiros.
Estamos desenvolvendo um Payment Orchestrator — orquestrador de pagamentos com
Split Logic e Ledger de dupla entrada para um marketplace. Este é um projeto de
portfólio de nível sênior para apresentar a outros desenvolvedores sêniors e empresas.

Stack: Node.js + TypeScript, PostgreSQL 16, Redis + BullMQ, Next.js, Docker.
Ambiente: Windows com PowerShell.

## O que já existe (Fase 1 concluída)
- package.json com todas as dependências
- tsconfig.json com strict máximo (ADR-015)
- Estrutura de pastas Clean Architecture criada
- docker-compose.yml com PostgreSQL 16, Redis 7, Prometheus, Grafana e Jaeger
- .eslintrc.js com regras customizadas do domínio financeiro
- Husky + commitlint com Conventional Commits
- GitHub Actions com quality gates verdes
- TypeScript fixado em 5.5.4 (5.9 é incompatível com @typescript-eslint atual)

## Regras obrigatórias
- Clean Architecture: domain/ → application/ → infrastructure/ → web/
- Zero dependências externas em domain/
- Branded Types para todos os identificadores e valores financeiros
- Result Type para erros de domínio (nunca throw no domínio)
- TDD obrigatório: escreva o teste antes da implementação (Red → Green → Refactor)
- Conventional Commits obrigatórios
- Manda no máximo 3 arquivos por vez com explicação simples de cada um

## O que precisa ser feito agora (Fase 2 — Domain Layer)
Implemente toda a camada de domínio via TDD na seguinte ordem:

1. src/domain/shared/types.ts — todos os Branded Types (ADR-015)
2. src/domain/shared/Result.ts — Result<T, E>, ok(), err() (ADR-014)
3. src/domain/shared/errors/ — hierarquia de erros de domínio
4. src/domain/payment/value-objects/PaymentStatus.ts — 13 estados + VALID_TRANSITIONS + assertNever
5. src/domain/payment/Payment.ts — entity com transition() retornando Result
6. src/domain/payment/events/ — domain events
7. src/domain/ledger/value-objects/AccountCode.ts — enum das 7 contas (ADR-010)
8. src/domain/ledger/JournalEntry.ts — validação de double-entry no domínio
9. src/domain/split/SplitCalculator.ts — calculate() com invariante platform + seller === total
10. src/domain/settlement/SettlementSchedule.ts

Os ADRs relevantes estão anexados. Siga TDD: teste → implementação → refactor.
Cobertura mínima: ≥ 90% em src/domain/.
```

---

### Prompt — Fase 3 (Banco de Dados)

**Arquivos para anexar:** `README.md`, `docs/architecture/overview.md`, `docs/adr/ADR-010-chart-of-accounts.md`, `docs/adr/ADR-016-database-constraints.md`, `docs/adr/ADR-007-ledger-cqrs.md`

```
Você é um Arquiteto de Software Sênior com experiência em sistemas financeiros.
Continuando o Payment Orchestrator. Fases 1 e 2 concluídas.
Ambiente: Windows com PowerShell.

## Regras obrigatórias
- Clean Architecture: domain/ → application/ → infrastructure/ → web/
- Zero dependências externas em domain/
- Branded Types para todos os identificadores e valores financeiros
- Result Type para erros de domínio (nunca throw no domínio)
- Outbox Pattern para toda publicação de evento
- Conventional Commits obrigatórios
- Manda no máximo 3 arquivos por vez com explicação simples de cada um

## O que precisa ser feito agora (Fase 3 — Banco de Dados)
1. Setup do Knex com TypeScript e connection pool
2. 12 migrations em ordem (veja ROADMAP.md seção Fase 3 para a lista completa)
3. Seed das 7 contas do Chart of Accounts (ADR-010)
4. Trigger DEFERRABLE INITIALLY DEFERRED para double-entry (ADR-016)
5. MATERIALIZED VIEW ledger_summary para o dashboard (ADR-007)
6. Testes de integração com Testcontainers verificando constraints e trigger
7. docs/architecture/data-model.md com ERD completo

Os ADRs relevantes estão anexados.
```

---

### Prompt — Fase 4 (Infrastructure)

**Arquivos para anexar:** `README.md`, `docs/architecture/overview.md`, `docs/adr/ADR-002-idempotency-storage.md`, `docs/adr/ADR-008-circuit-breaker.md`, `docs/adr/ADR-009-outbox-pattern.md`, `docs/adr/ADR-012-dlq-policy.md`, `docs/adr/ADR-013-graceful-shutdown.md`, `docs/adr/ADR-017-observability-strategy.md`, `docs/adr/ADR-018-audit-log.md`, `docs/adr/ADR-019-sensitive-data-masking.md`

```
Você é um Arquiteto de Software Sênior com experiência em sistemas financeiros.
Continuando o Payment Orchestrator. Fases 1, 2 e 3 concluídas.
Ambiente: Windows com PowerShell.

## Regras obrigatórias
- Clean Architecture: domain/ → application/ → infrastructure/ → web/
- Zero dependências externas em domain/
- Branded Types para todos os identificadores e valores financeiros
- Result Type para erros de domínio (nunca throw no domínio)
- Outbox Pattern para toda publicação de evento
- Conventional Commits obrigatórios
- Manda no máximo 3 arquivos por vez com explicação simples de cada um

## O que precisa ser feito agora (Fase 4 — Infrastructure Layer)
Repositories, OutboxRelay, gateway adapters com Circuit Breaker,
IdempotencyStore, workers BullMQ com jobOptions centralizados,
logger Pino com redact, métricas Prometheus, tracing OpenTelemetry,
SensitiveDataMasker, AuditLogger e GracefulShutdown.

Regra crítica do Outbox (ADR-009): workers chamam o gateway diretamente,
mas SEMPRE publicam o resultado via outboxRepo.save() dentro da mesma
transação — nunca via queue.add() diretamente.

Os ADRs relevantes estão anexados.
```

---

### Prompt — Fase 5 (Use Cases)

**Arquivos para anexar:** `README.md`, `docs/architecture/overview.md`, `docs/adr/ADR-003-sync-async-processing.md`, `docs/adr/ADR-005-split-rounding.md`, `docs/adr/ADR-006-refund-strategy.md`, `docs/adr/ADR-011-settlement-schedule.md`

```
Você é um Arquiteto de Software Sênior com experiência em sistemas financeiros.
Continuando o Payment Orchestrator. Fases 1 a 4 concluídas.
Ambiente: Windows com PowerShell.

## Regras obrigatórias
- Clean Architecture: domain/ → application/ → infrastructure/ → web/
- Zero dependências externas em domain/
- Branded Types para todos os identificadores e valores financeiros
- Result Type para erros de domínio (nunca throw no domínio)
- Outbox Pattern para toda publicação de evento
- Conventional Commits obrigatórios
- Manda no máximo 3 arquivos por vez com explicação simples de cada um

## O que precisa ser feito agora (Fase 5 — Application Layer)
Use cases via TDD: CreatePaymentUseCase, ProcessWebhookUseCase,
RefundPaymentUseCase, RecordDoubleEntryUseCase, RecordRefundEntryUseCase,
ScheduleSettlementUseCase, ProcessSettlementUseCase, CalculateSplitUseCase.

Regra: CreatePaymentUseCase salva Payment + OutboxEvent na mesma transação
e retorna imediatamente — NÃO chama o gateway. O gateway é responsabilidade
do PaymentWorker (Fase 4).

Os ADRs relevantes estão anexados.
```

---

### Prompt — Fase 6 (Web Layer)

**Arquivos para anexar:** `README.md`, `docs/architecture/overview.md`, `docs/adr/ADR-002-idempotency-storage.md`, `docs/adr/ADR-003-sync-async-processing.md`, `docs/adr/ADR-017-observability-strategy.md`, `docs/adr/ADR-020-testing-strategy.md`

```
Você é um Arquiteto de Software Sênior com experiência em sistemas financeiros.
Continuando o Payment Orchestrator. Fases 1 a 5 concluídas.
Ambiente: Windows com PowerShell.

## Regras obrigatórias
- Clean Architecture: domain/ → application/ → infrastructure/ → web/
- Zero dependências externas em domain/
- Branded Types para todos os identificadores e valores financeiros
- Result Type para erros de domínio (nunca throw no domínio)
- Outbox Pattern para toda publicação de evento
- Conventional Commits obrigatórios
- Manda no máximo 3 arquivos por vez com explicação simples de cada um

## O que precisa ser feito agora (Fase 6 — Web Layer)
Middlewares (RequestContext, Idempotency, Auth, RateLimit, ErrorHandler),
controllers e rotas (POST /payments, GET /payments/:id, POST /webhooks/*,
POST /payments/:id/refund, GET /ledger/summary, GET /health/*, GET /metrics),
DTOs com Zod, contract tests Pact e E2E tests.

POST /payments retorna 201 com status PROCESSING — não o resultado final.
O cliente faz polling em GET /payments/:id.

Os ADRs relevantes estão anexados.
```

---

### Prompt — Fase 7 (Frontend)

**Arquivos para anexar:** `README.md`, `docs/architecture/overview.md`

```
Você é um Arquiteto de Software Sênior com experiência em sistemas financeiros.
Continuando o Payment Orchestrator. Fases 1 a 6 concluídas — API completa e testada.
Ambiente: Windows com PowerShell.

## O que precisa ser feito agora (Fase 7 — Frontend Next.js)
Implemente o frontend com Next.js (App Router) e TypeScript strict:

1. Checkout de teste — formulário para criar pagamentos, polling de status,
   visualização do split (plataforma vs vendedor)

2. Dashboard de conciliação — tabela de transações com filtros por período
   e status, totais consumindo GET /ledger/summary, indicadores de volume,
   taxa de aprovação e payouts pendentes

A API roda em http://localhost:3000.
```

---

## Como atualizar este arquivo

Após concluir cada fase:

1. Mude o status de `🔄 EM ANDAMENTO` para `✅ CONCLUÍDA`
2. Mude a próxima fase de `⏳ AGUARDANDO` para `🔄 EM ANDAMENTO`
3. Atualize "Última atualização" no topo
4. Commit: `docs: update roadmap — phase N complete`
