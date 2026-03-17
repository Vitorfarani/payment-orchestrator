# CLAUDE.md — Payment Orchestrator

Este arquivo orienta o Claude Code sobre como trabalhar neste projeto. Leia antes de qualquer tarefa.

---

## O que este projeto é

Orquestrador de pagamentos com split logic e ledger de dupla entrada para marketplaces. Projeto de portfólio sênior em sistemas financeiros críticos. Cada decisão de arquitetura tem um ADR correspondente em `docs/adr/` — **leia o ADR antes de questionar ou alterar qualquer decisão**.

---

## Comandos essenciais

```bash
# Desenvolvimento
npm run dev                  # inicia API em modo watch
docker compose up -d         # sobe toda a infra (Postgres, Redis, Prometheus, Grafana, Jaeger)
npm run db:migrate           # roda migrations
npm run db:seed              # popula dados iniciais

# Testes
npm run test                 # unit tests (domínio puro)
npm run test:int             # integration tests (Testcontainers — banco e Redis reais)
npm run test:contract        # contract tests (Pact)
npm run test:e2e             # end-to-end (fluxos completos)

# Quality gates — devem passar todos antes de qualquer commit
npx tsc --noEmit             # zero erros de tipo
npx eslint --max-warnings 0  # zero warnings
npm audit --audit-level=high # zero vulnerabilidades high/critical
npx secretlint               # zero secrets no código
```

---

## Arquitetura — regras absolutas

### Regra de dependência (Clean Architecture)
```
domain/ → nenhuma dependência externa
application/ → só importa de domain/
infrastructure/ → implementa interfaces de domain/ e application/
web/ → só chama application/
```

**Nunca importe Knex, Express, Redis, BullMQ ou qualquer lib de infra dentro de `domain/` ou `application/`.** Se sentir essa necessidade, há um problema de design.

### Estrutura de pastas
```
src/
├── domain/          # Entidades, Value Objects, Domain Events, interfaces de repositório
├── application/     # Use cases — orquestra o domínio, não conhece HTTP
├── infrastructure/  # PostgreSQL, Redis, Stripe, BullMQ — implementações concretas
└── web/             # Controllers HTTP, DTOs, middlewares
```

---

## Dinheiro — regras invioláveis

- **Sempre `Cents` (Branded Type sobre `number`)** — nunca `number` solto para valores monetários
- **Nunca `float` ou `DECIMAL` no banco** — use `BIGINT NOT NULL CHECK (amount > 0)`
- **Arredondamento no split:** `Math.floor` para plataforma, remainder para o vendedor. `sum(parts) === total` é um invariante
- **ADR de referência:** ADR-001 (precisão monetária), ADR-005 (split rounding), ADR-015 (Branded Types)

```typescript
// CORRETO
const amount: Cents = 1000 as Cents;

// ERRADO — o compilador deve rejeitar
const amount: number = 1000;
```

---

## Erros de domínio — Result Type

Use cases e entidades **nunca lançam exceções para erros de negócio**. Retornam `Result<T, DomainError>`.

```typescript
// CORRETO
return Result.fail(new InsufficientFundsError(...));

// ERRADO
throw new Error('Insufficient funds');
```

Exceções ficam reservadas para falhas de infraestrutura (banco indisponível, memória esgotada). **ADR-014.**

---

## State Machine de pagamento

13 estados. Transições validadas em compile-time com `assertNever`. **Nunca adicione uma transição sem atualizar o diagrama e os testes.**

```
PENDING → PROCESSING → AUTHORIZED → CAPTURED → SETTLED
                    ↘ REQUIRES_ACTION  ↘ CANCELLED  ↓         ↓
                    ↘ FAILED                  REFUNDED  PARTIALLY_REFUNDED
                                              DISPUTED → CHARGEBACK_WON
                                                       → CHARGEBACK_LOST
```

**ADR-004.**

---

## Eventos e Outbox Pattern

**Nunca publique eventos diretamente.** Todo evento deve ser persistido via Outbox Pattern — a publicação é atômica com a escrita no banco.

- O `OutboxRelay` usa `SELECT FOR UPDATE SKIP LOCKED` para múltiplas instâncias
- Entrega at-least-once → workers devem ser idempotentes
- **Não existe dual-write em nenhum lugar do sistema**

**ADR-009.**

---

## Idempotência

Três fronteiras, todas idempotentes:
- **API:** `x-idempotency-key` no header
- **Workers:** `job_id` no BullMQ
- **Webhooks:** `event_id` do gateway

Um pagamento pode ser submetido N vezes — processado exatamente uma vez. **ADR-002.**

---

## Ledger — regras contábeis

- `JournalEntry` é **imutável** — nunca use `UPDATE` ou `DELETE` em entradas contábeis
- Erros são corrigidos com **reversing entries**, nunca editando o registro original
- Soma de débitos === soma de créditos em toda transação (double-entry)
- O banco tem um trigger `DEFERRABLE INITIALLY DEFERRED` que valida este invariante
- CQRS: write model normalizado + `MATERIALIZED VIEW` para o dashboard

**ADR-010, ADR-007, ADR-016.**

### Plano de contas (7 contas fixas — não altere sem ADR)
```
1001 Receivable Gateway   ASSET
2001 Payable Seller       LIABILITY
2002 Payable Refund       LIABILITY
3001 Revenue Platform     REVENUE
3002 Revenue Chargeback   REVENUE
4001 Expense Chargeback   EXPENSE
4002 Expense Gateway Fee  EXPENSE
```

---

## Audit Log — regras de segurança

- Toda ação sensível (criação de pagamento, estorno, chargeback, alteração de split rule, acesso a dados pessoais) **deve** gerar um registro em `audit_logs`
- A role da aplicação tem `DELETE` **revogado** nessa tabela — não tente deletar entradas
- Retenção: 7 anos

**ADR-018.**

---

## Dados sensíveis — três camadas obrigatórias

PAN, CVV, CPF e dados bancários **nunca aparecem em logs**. Três camadas independentes protegem isso:

1. **Pino redact** — campos bloqueados na serialização do log
2. **SensitiveDataMasker** — mascaramento aplicado antes do log
3. **HTTP allowlist** — apenas campos explicitamente permitidos saem em respostas

Não desabilite nenhuma camada. `MASK_SENSITIVE_DATA=false` só é válido em desenvolvimento local para debugging pontual, **nunca em produção**. **ADR-019.**

---

## Testes — o que é obrigatório

| Camada | Cobertura mínima | Observação |
|---|---|---|
| `domain/` | ≥ 90% | TDD obrigatório. Zero I/O, zero mocks de infra |
| `application/` | ≥ 85% | Use cases testados com repositórios in-memory |
| Integration | Banco e Redis reais | Testcontainers — nunca mocke o banco |
| Contract | 1 por endpoint do gateway | Pact — detecta breaking changes |
| E2E | ~10 cenários críticos | Fluxos completos: checkout → webhook → ledger |

**Nunca mocke o banco nos testes de integração.** Constraints e triggers do PostgreSQL só são testados com banco real. **ADR-020.**

---

## Observabilidade — campos obrigatórios em todo log

```typescript
logger.info({
  request_id,   // obrigatório
  trace_id,     // obrigatório
  service,      // obrigatório
  version,      // obrigatório
  // ... outros campos
}, 'mensagem');
```

- `debug` desabilitado em produção
- OpenTelemetry propagado do request HTTP → worker → gateway
- Métricas em `GET /metrics` (Prometheus)

**ADR-017.**

---

## Alerta mais crítico do sistema

```yaml
- alert: LedgerBalanceDiscrepancy
  expr: ledger_balance_discrepancy_total > 0
  severity: critical
  # Se disparar: parar novos processamentos e executar runbook imediatamente
```

Se `ledger_balance_discrepancy_total > 0`, é incidente. Consulte `docs/runbooks/ledger-discrepancy.md`.

---

## Resiliência — padrões em uso

| Padrão | Onde | Config |
|---|---|---|
| Circuit Breaker (`opossum`) | Chamadas ao gateway (Stripe/Asaas) | 5 falhas / 10 chamadas → abre por 30s |
| Retry + backoff exponencial + jitter | Todos os workers | LedgerWorker: 8 tentativas; padrão: 5 |
| DLQ | Jobs que esgotam retries | Vai para `failed` set com alerta automático |
| Graceful Shutdown | SIGTERM | Para HTTP (30s) → drena workers (60s) → fecha conexões. Timeout: 90s |

**ADR-008, ADR-012, ADR-013.**

---

## O que NÃO fazer

- ❌ Importar libs de infra em `domain/` ou `application/`
- ❌ Usar `float` ou `DECIMAL` para valores monetários
- ❌ Lançar exceções para erros de negócio previsíveis (use `Result.fail`)
- ❌ Fazer `UPDATE` ou `DELETE` em `journal_entries` ou `audit_logs`
- ❌ Publicar eventos fora do Outbox Pattern
- ❌ Logar PAN, CVV, CPF ou dados bancários
- ❌ Adicionar transição de estado sem atualizar state machine + testes
- ❌ Mockar PostgreSQL nos testes de integração
- ❌ Commitar `.env` real (apenas `.env.example`)
- ❌ Alterar o plano de contas sem um ADR aprovado

---

## Antes de alterar qualquer decisão de arquitetura

1. Leia o ADR correspondente em `docs/adr/`
2. Se discordar, crie um novo ADR propondo a mudança
3. Nunca altere silenciosamente algo que tem ADR documentado

---

## Referências rápidas

```
docs/adr/              → 20 ADRs com contexto e alternativas consideradas
docs/architecture/     → overview.md, bounded-contexts.md, data-model.md
docs/domain/           → glossary.md, chart-of-accounts.md, business-rules.md
docs/runbooks/         → payment-stuck-processing, ledger-discrepancy, webhook-failures, queue-backlog
```
