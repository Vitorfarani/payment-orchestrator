# Payment Orchestrator

> Orquestrador de pagamentos com split logic e ledger de dupla entrada para marketplaces.
> Projeto de portfólio de nível sênior demonstrando decisões de engenharia em sistemas financeiros críticos.

---

## Por que este projeto existe

Marketplaces precisam dividir pagamentos entre plataforma e vendedores de forma confiável, rastreável e auditável. O problema central não é processar um pagamento — qualquer SDK resolve isso. O problema é **garantir que o dinheiro não desapareça** quando qualquer parte do sistema falhar: rede instável, gateway timeout, worker crash, deploy no meio de uma transação.

Este projeto trata cada centavo como um registro contábil imutável, não como um número em um banco de dados.

---

## Decisões de arquitetura críticas

20 ADRs documentam o raciocínio por trás de cada escolha de engenharia. Leia os ADRs antes de questionar qualquer decisão de implementação.

### Domínio financeiro

| Decisão | Resumo | ADR |
|---|---|---|
| Representação monetária | `BIGINT` centavos — nunca `float` | [ADR-001](docs/adr/ADR-001-monetary-precision.md) |
| Plano de contas | 7 contas contábeis fixas e versionadas | [ADR-010](docs/adr/ADR-010-chart-of-accounts.md) |
| Arredondamento no split | Truncate + remainder ao vendedor | [ADR-005](docs/adr/ADR-005-split-rounding.md) |
| Estratégia de estorno | Proporcional ao split original | [ADR-006](docs/adr/ADR-006-refund-strategy.md) |
| Settlement schedule | D+14 padrão, configurável por vendedor | [ADR-011](docs/adr/ADR-011-settlement-schedule.md) |

### Ciclo de vida do pagamento

| Decisão | Resumo | ADR |
|---|---|---|
| State machine | 13 estados com transições explícitas e `assertNever` | [ADR-004](docs/adr/ADR-004-payment-state-machine.md) |
| Processamento híbrido | Resposta síncrona imediata, processamento assíncrono | [ADR-003](docs/adr/ADR-003-sync-async-processing.md) |
| Idempotência | Redis TTL + PostgreSQL como fallback durável | [ADR-002](docs/adr/ADR-002-idempotency-storage.md) |

### Confiabilidade e resiliência

| Decisão | Resumo | ADR |
|---|---|---|
| Outbox Pattern | Publicação atômica de eventos — elimina dual-write | [ADR-009](docs/adr/ADR-009-outbox-pattern.md) |
| Circuit Breaker | `opossum` protege chamadas ao gateway externo | [ADR-008](docs/adr/ADR-008-circuit-breaker.md) |
| Dead Letter Queue | Backoff exponencial + jitter, política por worker | [ADR-012](docs/adr/ADR-012-dlq-policy.md) |
| Graceful Shutdown | SIGTERM → drain → close, timeout 90s | [ADR-013](docs/adr/ADR-013-graceful-shutdown.md) |

### Arquitetura e design de código

| Decisão | Resumo | ADR |
|---|---|---|
| CQRS no Ledger | `MATERIALIZED VIEW` para o dashboard de conciliação | [ADR-007](docs/adr/ADR-007-ledger-cqrs.md) |
| Result Type | Erros de domínio como valores, não exceções | [ADR-014](docs/adr/ADR-014-result-type.md) |
| Branded Types + strict | TypeScript como contrato do domínio financeiro | [ADR-015](docs/adr/ADR-015-branded-types-strict.md) |
| Banco como 2ª linha | `CHECK` constraints + trigger de double-entry | [ADR-016](docs/adr/ADR-016-database-constraints.md) |

### Observabilidade e segurança

| Decisão | Resumo | ADR |
|---|---|---|
| Observabilidade | Pino + OpenTelemetry + Prometheus — os três pilares | [ADR-017](docs/adr/ADR-017-observability-strategy.md) |
| Audit Log | Imutável, 7 anos de retenção, REVOKE DELETE na role | [ADR-018](docs/adr/ADR-018-audit-log.md) |
| Mascaramento de dados | 3 camadas: Pino redact + SensitiveDataMasker + allowlist | [ADR-019](docs/adr/ADR-019-sensitive-data-masking.md) |

### Testes

| Decisão | Resumo | ADR |
|---|---|---|
| Estratégia de testes | 4 camadas: unit + integration + contract + E2E | [ADR-020](docs/adr/ADR-020-testing-strategy.md) |

---

## Stack tecnológica

| Camada | Tecnologia | Justificativa |
|---|---|---|
| Backend | Node.js + TypeScript (strict máximo) | Branded Types + noUncheckedIndexedAccess no domínio financeiro |
| Banco de dados | PostgreSQL 16 | ACID, `CHECK` constraints, trigger de double-entry |
| Cache / Filas | Redis + BullMQ | Idempotency keys + processamento assíncrono |
| Frontend | Next.js 14 | Dashboard de conciliação + checkout de teste |
| Infra | Docker + Docker Compose | Ambiente reproduzível para dev e CI |
| Testes | Jest + Testcontainers + Pact | Banco real, sem mocks; contract tests para o gateway |
| Logs | Pino | JSON estruturado, 5-8x mais rápido que Winston |
| Traces | OpenTelemetry + Jaeger | Rastreamento distribuído vendor-neutral |
| Métricas | Prometheus + Grafana | Dashboard pré-configurado no Docker Compose |

---

## Arquitetura

O sistema segue **Clean Architecture** com **DDD** e bounded contexts bem definidos. A regra de dependência é absoluta: camadas internas nunca conhecem as externas.

```
src/
├── domain/          # Entidades, Value Objects, eventos — zero dependências externas
├── application/     # Casos de uso — orquestra o domínio
├── infrastructure/  # PostgreSQL, Redis, Stripe, BullMQ — implementações concretas
└── web/             # HTTP controllers, DTOs, middlewares
```

Veja o diagrama completo em [docs/architecture/overview.md](docs/architecture/overview.md).

### Bounded Contexts

| Context | Responsabilidade |
|---|---|
| `PaymentContext` | Orquestração, state machine, integração com gateway |
| `LedgerContext` | Contabilidade double-entry, journal entries imutáveis |
| `SplitContext` | Regras de comissão, cálculo, arredondamento |
| `SellerContext` | Cadastro de vendedores, contas bancárias |
| `SettlementContext` | Schedules T+N, payouts, conciliação |
| `WebhookContext` | Recebimento e processamento de callbacks do gateway |
| `NotificationContext` | Webhooks de saída, eventos para sistemas externos |

---

## Como rodar

```bash
# Pré-requisitos: Docker, Node.js 20+

# 1. Clone e instale dependências
git clone https://github.com/seu-usuario/payment-orchestrator
cd payment-orchestrator
npm install

# 2. Suba toda a infra (PostgreSQL, Redis, Prometheus, Grafana, Jaeger)
docker compose up -d

# 3. Rode as migrations e seeds
npm run db:migrate
npm run db:seed

# 4. Inicie em modo desenvolvimento
npm run dev

# 5. Rode os testes
npm run test           # unit tests (TDD — domínio puro)
npm run test:int       # integration tests (Testcontainers — banco e Redis reais)
npm run test:contract  # contract tests (Pact — API do gateway)
npm run test:e2e       # end-to-end tests (fluxos completos)
```

### Serviços disponíveis após `docker compose up`

| Serviço | URL | Descrição |
|---|---|---|
| API | `http://localhost:3000` | Endpoints de pagamento |
| Dashboard | `http://localhost:3001` | Next.js — conciliação e checkout |
| Bull Board | `http://localhost:3000/queues` | Monitoramento das filas BullMQ |
| Grafana | `http://localhost:3002` | Métricas e alertas |
| Jaeger | `http://localhost:16686` | Distributed tracing |
| Prometheus | `http://localhost:9090` | Métricas brutas |

### Variáveis de ambiente

```bash
cp .env.example .env
# Edite .env com suas credenciais de sandbox do Stripe/Asaas
```

Nunca commite o `.env` real — apenas o `.env.example` com valores de exemplo documentados.

---

## Estrutura de testes

A pirâmide de testes deste projeto é intencional. Cada camada tem um propósito específico:

```
              /\
             /e2e\          ← Poucos (~10). Fluxos críticos completos.
            /------\          checkout → webhook → ledger → dashboard
           /contract\       ← Médios. Pact: contrato com API do gateway.
          /----------\        Detecta breaking changes antes de produção.
         /integration \     ← Médios. Testcontainers: PostgreSQL e Redis reais.
        /--------------\      Repositories, workers, trigger de double-entry.
       /   unit (TDD)   \   ← Maioria (>90% cobertura em domain/ e application/).
      /------------------\    Entidades, use cases, state machine, calculators.
```

- **Unit:** TDD obrigatório para todo código de domínio. Zero dependências externas, zero I/O.
- **Integration:** Testcontainers — banco e Redis reais. Testa constraints, triggers e race conditions que mocks escondem.
- **Contract:** Pact — define e verifica o contrato com a API do Stripe/Asaas. Se o gateway mudar de forma incompatível, o CI quebra antes do deploy.
- **E2E:** Supertest + Testcontainers. Fluxos de ponta a ponta, incluindo workers e Ledger.

### Quality gates no CI (não-negociáveis)

```
tsc --noEmit              → zero erros de tipo
eslint --max-warnings 0   → zero warnings
unit coverage             → ≥ 90% em domain/, ≥ 85% em application/
npm audit --audit-level=high → zero vulnerabilidades high/critical
secretlint                → zero secrets no código
```

---

## Observabilidade

Todo request recebe um `Request-ID` único propagado em todos os logs, traces e jobs de worker.

- **Logs (Pino):** JSON estruturado. Dados sensíveis (PAN, CPF, dados bancários) mascarados automaticamente em 3 camadas antes de qualquer log.
- **Traces (OpenTelemetry):** propagação de contexto de ponta a ponta — do request HTTP até o worker até a chamada ao gateway.
- **Métricas (Prometheus):** dashboard Grafana pré-configurado, disponível em `http://localhost:3002`.
- **Healthchecks:** `GET /health/live` (liveness) e `GET /health/ready` (readiness — verifica banco e Redis).

### Métricas de negócio monitoradas

| Métrica | Alerta | Descrição |
|---|---|---|
| `ledger_balance_discrepancy_total` | **CRÍTICO se > 0** | Inconsistência financeira — incidente imediato |
| `payment_attempts_total{status}` | — | Volume por status |
| `payment_processing_duration_seconds` | warn se > 30s | Latência do fluxo completo |
| `settlement_items_overdue_total` | warn se > 0 | Payouts atrasados |
| `outbox_unprocessed_events_total` | warn se > 100 | Relay atrasado |
| `circuit_breaker_state{name}` | warn se open | Gateway degradado |

---

## Segurança

- **Autenticação:** JWT com rotação de refresh tokens.
- **Webhooks:** validação de assinatura HMAC-SHA256 antes de qualquer processamento.
- **Mascaramento:** PAN, CVV, CPF, dados bancários nunca aparecem em logs — 3 camadas de proteção independentes ([ADR-019](docs/adr/ADR-019-sensitive-data-masking.md)).
- **Audit log:** toda ação sensível gera registro imutável com `actor_id`, `ip`, `timestamp`, estado anterior e novo. Retenção de 7 anos. `DELETE` revogado na role da aplicação ([ADR-018](docs/adr/ADR-018-audit-log.md)).
- **Rate limiting:** por IP e por `merchant_id`.
- **Secrets:** nunca em código. `.env.example` documenta o formato sem valores reais.

---

## Trade-offs conscientemente aceitos

Toda decisão tem custo. Estes foram aceitos explicitamente:

1. **Outbox Relay usa polling (1s) em vez de CDC**
   Reduz complexidade operacional. Em produção com alto volume, migraríamos para Debezium + Kafka sem breaking changes no domínio.

2. **Não implementamos Event Sourcing no Ledger**
   `journal_entries` imutáveis são compatíveis com ES — a migração é possível sem alterar o schema. O overhead operacional não se justifica para o escopo atual.

3. **Idempotency keys: Redis com TTL de 24h + PostgreSQL como fallback**
   Uma chave expirada no Redis recarrega do banco. Reprocessamento após 24h é aceitável — cobre qualquer janela razoável de retry.

4. **Settlement em dias corridos, não dias úteis**
   Feriados nacionais, regionais e bancários adicionam complexidade desproporcional para v1. O trade-off é documentado e a migração para dias úteis não requer breaking changes no schema.

5. **Sem multi-tenancy no schema do banco**
   Um marketplace por instância. Multi-tenancy por schema (PostgreSQL) é o próximo passo natural se necessário.

6. **Mascaramento desabilitável em desenvolvimento local**
   `MASK_SENSITIVE_DATA=false` permite debugging de validações específicas. Nunca disponível em produção.

---

## Documentação

```
docs/
├── adr/                          # 20 Architecture Decision Records
│   ├── README.md                 # Índice com status de cada ADR
│   ├── ADR-000-template.md       # Template para novos ADRs
│   └── ADR-001 a ADR-020         # Decisões completas com contexto e alternativas
├── architecture/
│   ├── overview.md               # Visão geral, C4 Level 2, bounded contexts
│   ├── bounded-contexts.md       # Context map detalhado
│   └── data-model.md             # ERD e schema do banco
├── domain/
│   ├── glossary.md               # Linguagem ubíqua — termos do domínio
│   ├── chart-of-accounts.md      # Plano de contas para stakeholders não-técnicos
│   └── business-rules.md         # Regras de negócio consolidadas
└── runbooks/
    ├── payment-stuck-processing.md  # Pagamento travado em PROCESSING
    ├── ledger-discrepancy.md        # Ledger desbalanceado
    ├── webhook-failures.md          # Falhas no processamento de webhooks
    └── queue-backlog.md             # Fila acumulando sem processamento
```
