# Payment Orchestrator

> Payment orchestrator for marketplaces, with split logic and a double-entry ledger.
> A portfolio project focused on the engineering decisions behind critical financial systems.

![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-BullMQ-DC382D?logo=redis&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)

---

## Why this project exists

Marketplaces need to split payments between the platform and its sellers in a way that is reliable, traceable and auditable. The hard part is not processing a payment — any SDK does that. The hard part is **making sure money never disappears** when any part of the system fails: an unstable network, a gateway timeout, a worker crash, a deploy in the middle of a transaction.

This project treats every cent as an immutable accounting record, not as a number in a database.

---

## Key architecture decisions

20 ADRs document the reasoning behind each engineering choice. Read the ADRs before questioning any implementation decision.

### Financial domain

| Decision | Summary | ADR |
|---|---|---|
| Monetary representation | `BIGINT` cents — never `float` | [ADR-001](docs/adr/ADR-001-monetary-precision.md) |
| Chart of accounts | 7 fixed, versioned ledger accounts | [ADR-010](docs/adr/ADR-010-chart-of-accounts.md) |
| Split rounding | Truncate, remainder goes to the seller | [ADR-005](docs/adr/ADR-005-split-rounding.md) |
| Refund strategy | Proportional to the original split | [ADR-006](docs/adr/ADR-006-refund-strategy.md) |
| Settlement schedule | D+14 by default, configurable per seller | [ADR-011](docs/adr/ADR-011-settlement-schedule.md) |

### Payment lifecycle

| Decision | Summary | ADR |
|---|---|---|
| State machine | 13 states with explicit transitions and `assertNever` | [ADR-004](docs/adr/ADR-004-payment-state-machine.md) |
| Hybrid processing | Immediate synchronous response, asynchronous processing | [ADR-003](docs/adr/ADR-003-sync-async-processing.md) |
| Idempotency | Redis with TTL + PostgreSQL as durable fallback | [ADR-002](docs/adr/ADR-002-idempotency-storage.md) |

### Reliability and resilience

| Decision | Summary | ADR |
|---|---|---|
| Outbox Pattern | Atomic event publishing — eliminates dual writes | [ADR-009](docs/adr/ADR-009-outbox-pattern.md) |
| Circuit Breaker | `opossum` protects calls to the external gateway | [ADR-008](docs/adr/ADR-008-circuit-breaker.md) |
| Dead Letter Queue | Exponential backoff + jitter, per-worker policy | [ADR-012](docs/adr/ADR-012-dlq-policy.md) |
| Graceful Shutdown | SIGTERM → drain → close, 90s timeout | [ADR-013](docs/adr/ADR-013-graceful-shutdown.md) |

### Architecture and code design

| Decision | Summary | ADR |
|---|---|---|
| CQRS in the Ledger | `MATERIALIZED VIEW` for the reconciliation dashboard | [ADR-007](docs/adr/ADR-007-ledger-cqrs.md) |
| Result Type | Domain errors as values, not exceptions | [ADR-014](docs/adr/ADR-014-result-type.md) |
| Branded Types + strict | TypeScript as the contract of the financial domain | [ADR-015](docs/adr/ADR-015-branded-types-strict.md) |
| Database as second line of defence | `CHECK` constraints + double-entry trigger | [ADR-016](docs/adr/ADR-016-database-constraints.md) |

### Observability and security

| Decision | Summary | ADR |
|---|---|---|
| Observability | Pino + OpenTelemetry + Prometheus — the three pillars | [ADR-017](docs/adr/ADR-017-observability-strategy.md) |
| Audit Log | Immutable, 7-year retention, `DELETE` revoked on the role | [ADR-018](docs/adr/ADR-018-audit-log.md) |
| Data masking | 3 layers: Pino redact + SensitiveDataMasker + allowlist | [ADR-019](docs/adr/ADR-019-sensitive-data-masking.md) |

### Testing

| Decision | Summary | ADR |
|---|---|---|
| Testing strategy | 4 layers: unit + integration + contract + E2E | [ADR-020](docs/adr/ADR-020-testing-strategy.md) |

---

## Tech stack

| Layer | Technology | Rationale |
|---|---|---|
| Backend | Node.js + TypeScript (maximum strictness) | Branded Types + `noUncheckedIndexedAccess` in the financial domain |
| Database | PostgreSQL 16 | ACID, `CHECK` constraints, double-entry trigger |
| Cache / Queues | Redis + BullMQ | Idempotency keys + asynchronous processing |
| Infra | Docker + Docker Compose | Reproducible environment for dev and CI |
| Testing | Jest + Testcontainers + Pact | Real database, no mocks; contract tests for the gateway |
| Logs | Pino | Structured JSON, 5–8x faster than Winston |
| Traces | OpenTelemetry + Jaeger | Vendor-neutral distributed tracing |
| Metrics | Prometheus + Grafana | Pre-configured in Docker Compose |
| Frontend *(in progress)* | Next.js 14 | Reconciliation dashboard + test checkout |

---

## Architecture

The system follows **Clean Architecture** with **DDD** and well-defined bounded contexts. The dependency rule is absolute: inner layers never know about outer layers.

```
src/
├── domain/          # Entities, Value Objects, events — zero external dependencies
├── application/     # Use cases — orchestrate the domain
├── infrastructure/  # PostgreSQL, Redis, Stripe, Asaas, BullMQ — concrete implementations
└── web/             # HTTP controllers, DTOs, middlewares
```

See the full diagram in [docs/architecture/overview.md](docs/architecture/overview.md).

### Bounded Contexts

| Context | Responsibility |
|---|---|
| `PaymentContext` | Orchestration, state machine, gateway integration |
| `LedgerContext` | Double-entry accounting, immutable journal entries |
| `SplitContext` | Commission rules, calculation, rounding |
| `SellerContext` | Seller registration, bank accounts |
| `SettlementContext` | T+N schedules, payouts, reconciliation |
| `WebhookContext` | Receiving and processing gateway callbacks |
| `NotificationContext` | Outgoing webhooks, events for external systems |

---

## Getting started

```bash
# Prerequisites: Docker, Node.js 20+

# 1. Clone and install dependencies
git clone https://github.com/Vitorfarani/payment-orchestrator
cd payment-orchestrator
npm install

# 2. Start the infrastructure (PostgreSQL, Redis, Prometheus, Grafana, Jaeger)
docker compose up -d

# 3. Run migrations and seeds
npm run db:migrate
npm run db:seed

# 4. Start in development mode
npm run dev

# 5. Run the tests
npm run test           # unit tests (TDD — pure domain)
npm run test:int       # integration tests (Testcontainers — real database and Redis)
npm run test:contract  # contract tests (Pact — gateway API)
npm run test:e2e       # end-to-end tests (full flows)
```

### Services available after `docker compose up`

| Service | URL | Description |
|---|---|---|
| API | `http://localhost:3000` | Payment endpoints (after `npm run dev`) |
| Grafana | `http://localhost:3002` | Metrics and alerts |
| Jaeger | `http://localhost:16686` | Distributed tracing |
| Prometheus | `http://localhost:9090` | Raw metrics |

### Environment variables

```bash
cp .env.example .env
# Edit .env with your Stripe/Asaas sandbox credentials
```

Never commit the real `.env` — only `.env.example`, with documented sample values.

---

## Test structure

The test pyramid in this project is intentional. Each layer has a specific purpose:

```
              /\
             /e2e\          ← Few (~10). Complete critical flows.
            /------\          checkout → webhook → ledger
           /contract\       ← Medium. Pact: contract with the gateway API.
          /----------\        Catches breaking changes before production.
         /integration \     ← Medium. Testcontainers: real PostgreSQL and Redis.
        /--------------\      Repositories, workers, double-entry trigger.
       /   unit (TDD)   \   ← Most tests (>90% coverage in domain/ and application/).
      /------------------\    Entities, use cases, state machine, calculators.
```

- **Unit:** TDD is mandatory for all domain code. Zero external dependencies, zero I/O.
- **Integration:** Testcontainers — real database and Redis. Tests constraints, triggers and race conditions that mocks hide.
- **Contract:** Pact — defines and verifies the contract with the Stripe/Asaas API. If the gateway changes in an incompatible way, CI fails before deployment.
- **E2E:** Supertest + Testcontainers. End-to-end flows, including workers and the Ledger.

### CI quality gates (non-negotiable)

```
tsc --noEmit                  → zero type errors
eslint --max-warnings 0       → zero warnings
unit coverage                 → ≥ 90% in domain/, ≥ 85% in application/
npm audit --audit-level=high  → zero high/critical vulnerabilities
secretlint                    → zero secrets in the code
```

---

## Observability

Every request gets a unique `Request-ID`, propagated through all logs, traces and worker jobs.

- **Logs (Pino):** structured JSON. Sensitive data (card numbers, tax IDs, bank details) is masked automatically in 3 layers before anything is logged.
- **Traces (OpenTelemetry):** end-to-end context propagation — from the HTTP request to the worker to the gateway call.
- **Metrics (Prometheus):** Grafana available at `http://localhost:3002`.
- **Health checks:** `GET /health/live` (liveness) and `GET /health/ready` (readiness — checks the database and Redis).

### Monitored business metrics

| Metric | Alert | Description |
|---|---|---|
| `ledger_balance_discrepancy_total` | **CRITICAL if > 0** | Financial inconsistency — immediate incident |
| `payment_attempts_total{status}` | — | Volume by status |
| `payment_processing_duration_seconds` | warn if > 30s | End-to-end flow latency |
| `settlement_items_overdue_total` | warn if > 0 | Overdue payouts |
| `outbox_unprocessed_events_total` | warn if > 100 | Relay falling behind |
| `circuit_breaker_state{name}` | warn if open | Gateway degraded |

---

## Security

- **Authentication:** JWT.
- **Webhooks:** HMAC-SHA256 signature validation before any processing.
- **Masking:** card numbers, CVV, tax IDs and bank details never appear in logs — 3 independent layers of protection ([ADR-019](docs/adr/ADR-019-sensitive-data-masking.md)).
- **Audit log:** every sensitive action creates an immutable record with `actor_id`, `ip`, `timestamp`, and the previous and new state. 7-year retention. `DELETE` revoked on the application role ([ADR-018](docs/adr/ADR-018-audit-log.md)).
- **Rate limiting:** per `merchant_id`, sliding window in Redis.
- **Secrets:** never in code. `.env.example` documents the format without real values.

---

## Trade-offs knowingly accepted

Every decision has a cost. These were accepted explicitly:

1. **The Outbox Relay uses polling (1s) instead of CDC**
   Reduces operational complexity. At high production volume, we would migrate to Debezium + Kafka with no breaking changes to the domain.

2. **No Event Sourcing in the Ledger**
   Immutable `journal_entries` are compatible with ES — migrating is possible without changing the schema. The operational overhead isn't justified for the current scope.

3. **Idempotency keys: Redis with a 24h TTL + PostgreSQL as fallback**
   A key that expires in Redis is reloaded from the database. Reprocessing after 24h is acceptable — it covers any reasonable retry window.

4. **Settlement in calendar days, not business days**
   National, regional and bank holidays add disproportionate complexity for v1. The trade-off is documented, and moving to business days requires no breaking schema changes.

5. **No multi-tenancy in the database schema**
   One marketplace per instance. Schema-based multi-tenancy (PostgreSQL) is the natural next step if needed.

6. **Masking can be disabled in local development**
   `MASK_SENSITIVE_DATA=false` allows debugging specific validations. Never available in production.

---

## Documentation

Detailed documentation lives in `docs/` (in Portuguese).

```
docs/
├── adr/                          # 20 Architecture Decision Records
├── architecture/
│   ├── overview.md               # Overview, C4 Level 2, bounded contexts
│   ├── bounded-contexts.md       # Detailed context map
│   └── data-model.md             # ERD and database schema
├── domain/
│   ├── glossary.md               # Ubiquitous language — domain terms
│   ├── chart-of-accounts.md      # Chart of accounts for non-technical stakeholders
│   └── business-rules.md         # Consolidated business rules
└── runbooks/
    ├── payment-stuck-processing.md  # Payment stuck in PROCESSING
    └── queue-backlog.md             # Queue piling up without being processed
```
