# ADR-017: Estratégia de observabilidade — logs, traces e métricas

## Metadados

| Campo | Valor |
|---|---|
| **ID** | ADR-017 |
| **Título** | Estratégia de observabilidade — logs, traces e métricas |
| **Status** | `accepted` |
| **Data** | 2025-01-01 |
| **Contextos afetados** | Todos (infraestrutura transversal) |
| **Depende de** | ADR-013 (Graceful Shutdown) |
| **Bloqueia** | ADR-018 (Audit Log), ADR-019 (Mascaramento), setup de todos os middlewares |

---

## Contexto

Observabilidade é a capacidade de entender o estado interno de um sistema a partir de suas saídas externas. Em sistemas financeiros, não é opcional — é pré-requisito para operar com segurança.

Sem observabilidade, quando um pagamento falha às 3h da manhã você não sabe: foi o gateway? Foi o banco? Foi um bug específico para cartões Mastercard? Foi um timeout no worker? A investigação leva horas.

Os três pilares da observabilidade têm propósitos distintos e complementares:

**Logs** respondem "o que aconteceu?" — eventos discretos com contexto.
**Traces** respondem "onde demorou e por quê?" — o caminho de uma operação através do sistema.
**Métricas** respondem "quanto/quantas vezes?" — agregações numéricas ao longo do tempo.

Usar apenas um ou dois pilares deixa pontos cegos. Um sistema com logs mas sem métricas sabe que falhou mas não sabe se está falhando 1% ou 50% das vezes. Um sistema com métricas mas sem traces sabe que está lento mas não sabe onde.

---

## Decisão

Implementaremos os três pilares com as seguintes escolhas de tecnologia:

- **Logs:** Pino (JSON estruturado, alta performance)
- **Traces:** OpenTelemetry SDK (vendor-neutral, exporta para Jaeger em dev)
- **Métricas:** `prom-client` (Prometheus, dashboard Grafana via Docker Compose)

### Pilar 1 — Logs com Pino

**Por que Pino e não Winston?** Pino é 5-8x mais rápido que Winston em benchmarks — relevante em sistemas de alto volume. JSON por padrão, sem configuração. API simples.

**Campos obrigatórios em todo log:**

```typescript
// Todo log deve conter esses campos — garantido pelo logger configurado
{
  "level": "info",
  "time": "2025-01-01T03:00:00.000Z",
  "request_id": "req_abc123",       // propagado do header X-Request-ID
  "trace_id": "4bf92f3...",          // do OpenTelemetry span ativo
  "service": "payment-orchestrator",
  "version": "1.2.3",
  "msg": "payment.captured",
  // campos de contexto específicos do evento:
  "payment_id": "pay_123",
  "amount_cents": 10000,
  "duration_ms": 245
}
```

**Níveis e quando usar cada um:**

| Nível | Quando usar | Exemplo |
|---|---|---|
| `error` | Falha de sistema inesperada — requer ação | Banco indisponível, crash de worker |
| `warn` | Situação anômala mas recuperável | Circuit breaker abriu, retry #3 |
| `info` | Evento de negócio relevante | Pagamento capturado, payout executado |
| `debug` | Detalhe de execução para debugging | Query SQL, payload de resposta do gateway |

`debug` é **desabilitado em produção** via variável de ambiente (`LOG_LEVEL=info`). Em desenvolvimento, habilitado por padrão.

**Request-ID tracing:**

Cada request HTTP recebe um `request_id` único. Gerado pelo middleware se o cliente não enviar, ou propagado do header `X-Request-ID` se enviado. Esse ID é injetado em todos os logs do ciclo de vida daquele request — incluindo os workers que processam os jobs disparados por ele.

```typescript
// O request_id viaja do HTTP até o worker via job.data
await queue.add('payment.process', {
  ...payload,
  _meta: { requestId, traceId }  // contexto de observabilidade propagado
})
```

### Pilar 2 — Distributed Tracing com OpenTelemetry

OpenTelemetry é o padrão da CNCF para tracing — agnóstico de vendor, instrumentação automática para Express, Knex e HTTP clients.

**O que é instrumentado automaticamente:**
- Requests HTTP de entrada (Express)
- Queries ao PostgreSQL (Knex)
- Chamadas HTTP de saída (para o gateway)
- Jobs BullMQ (entrada e processamento)

**O que é instrumentado manualmente:**
- Operações de negócio críticas (split calculation, ledger entry creation)
- Chamadas ao Redis para idempotência

**Exemplo de trace completo de um pagamento:**

```
POST /payments (245ms total)
  ├── IdempotencyMiddleware.check (3ms)
  ├── CreatePaymentUseCase.execute (18ms)
  │   ├── db.transaction (15ms)
  │   │   ├── INSERT payments (8ms)
  │   │   └── INSERT outbox_events (4ms)
  │   └── redis.set idempotency (2ms)
  └── [async] PaymentWorker (180ms em background)
      ├── StripeAdapter.charge (150ms)
      │   └── HTTP POST api.stripe.com (148ms)
      └── db.transaction (25ms)
          ├── UPDATE payments (8ms)
          ├── INSERT ledger_entries (10ms)
          └── INSERT outbox_events (4ms)
```

Em desenvolvimento, Jaeger UI disponível em `http://localhost:16686`.

### Pilar 3 — Métricas com Prometheus

Métricas expostas em `GET /metrics` no formato Prometheus. Dashboard Grafana pré-configurado via Docker Compose.

**Métricas técnicas (infraestrutura):**

```typescript
// Latência de endpoints HTTP (histograma — p50, p95, p99)
http_request_duration_seconds{method, route, status_code}

// Taxa de erros HTTP
http_requests_total{method, route, status_code}

// Tamanho das filas BullMQ
queue_waiting_jobs{queue}
queue_active_jobs{queue}
queue_failed_jobs{queue}       // ← DLQ monitor (ADR-012)

// Estado do Circuit Breaker
circuit_breaker_state{name, state}  // 0=closed, 1=open, 2=half_open
circuit_breaker_fallbacks_total{name}

// Pool de conexões do banco
db_pool_size{state}            // idle, active, pending
```

**Métricas de negócio (financeiras) — as mais importantes:**

```typescript
// Volume de pagamentos
payment_attempts_total{status, currency, gateway}
payment_processing_duration_seconds{status}  // quanto tempo do PENDING ao resultado final

// Taxa de aprovação (SLA de negócio)
// Calculada no Grafana: sum(payment_attempts_total{status="CAPTURED"}) / sum(payment_attempts_total)

// Split e Ledger
split_calculation_errors_total             // deve ser sempre 0
ledger_balance_discrepancy_total           // DEVE SER SEMPRE 0 — alerta crítico se > 0
ledger_entries_written_total{account_code}

// Settlement
settlement_items_pending_total             // quantos payouts aguardando
settlement_items_overdue_total             // payouts atrasados (payout_date < hoje)

// Outbox
outbox_unprocessed_events_total            // alerta se cresce indefinidamente
outbox_relay_lag_seconds                   // tempo médio entre criação e publicação
```

**O alerta mais crítico do sistema:**

```yaml
# alerting rule (Prometheus AlertManager ou Grafana)
- alert: LedgerBalanceDiscrepancy
  expr: ledger_balance_discrepancy_total > 0
  for: 1m
  severity: critical
  annotations:
    summary: "Ledger está desbalanceado — possível inconsistência financeira"
    runbook: "docs/runbooks/ledger-discrepancy.md"
```

### Healthchecks

Dois endpoints obrigatórios:

```
GET /health/live   → Liveness: o processo está rodando? Retorna 200 sempre que o processo responde.
GET /health/ready  → Readiness: o serviço está pronto para receber tráfego?
                     Verifica: PostgreSQL conectado + Redis conectado + workers ativos.
                     Retorna 503 se qualquer dependência estiver indisponível.
```

O Kubernetes usa `liveness` para decidir se reinicia o pod, e `readiness` para decidir se roteia tráfego para ele.

---

## Alternativas consideradas

### Alternativa 1: Winston em vez de Pino

**Por que descartada:** Pino é 5-8x mais rápido, JSON por padrão sem configuração extra. Winston tem mais plugins e é mais familiar, mas o overhead de performance não se justifica quando já existe uma alternativa melhor para o mesmo propósito.

### Alternativa 2: Datadog / New Relic (APM all-in-one)

SaaS que unifica logs, traces e métricas em uma plataforma.

**Prós:** zero configuração de infraestrutura, UI excelente, alertas nativos.
**Contras:** custo ($$$), lock-in de vendor, dados saindo da infraestrutura. Para um portfólio, ter a stack de observabilidade rodando localmente via Docker Compose demonstra mais domínio técnico do que usar um SaaS.
**Por que descartada:** OpenTelemetry é vendor-neutral — pode exportar para Datadog, Jaeger, ou qualquer outro coletor sem mudar o código. Usamos Jaeger localmente, mas a instrumentação é portável.

### Alternativa 3: Logs sem estrutura (console.log com strings)

**Por que descartada:** strings não são parseáveis por ferramentas de busca de logs (Elasticsearch, Loki, CloudWatch Logs Insights). Em produção, você precisa filtrar logs por `payment_id` ou `request_id` — impossível com strings livres.

---

## Consequências

### Positivas
- Debugging de incidentes reduz de horas para minutos — trace mostra exatamente onde falhou.
- `ledger_balance_discrepancy_total > 0` é um alarme de incêndio automático para inconsistência financeira.
- OpenTelemetry é vendor-neutral — trocar de Jaeger para Datadog é mudança de configuração, não de código.
- Dashboard Grafana pré-configurado no Docker Compose — observabilidade disponível desde o primeiro `docker compose up`.

### Negativas / Trade-offs
- Overhead de performance (pequeno): instrumentação OpenTelemetry adiciona ~1-3ms por request.
- Mais containers no Docker Compose (Prometheus, Grafana, Jaeger) — ambiente de desenvolvimento mais pesado.
- Disciplina necessária: todo `logger.info()` precisa incluir os campos obrigatórios — enforce via lint rule customizada.

### Riscos e mitigações

- **Risco:** log sem `request_id` impossibilita rastreamento do request.
  **Mitigação:** o logger é criado com `request_id` injetado via `pino.child()` no middleware. Todo código dentro do ciclo de vida do request herda o `request_id` automaticamente.

- **Risco:** métricas de negócio não são coletadas corretamente por bug de instrumentação.
  **Mitigação:** testes de integração verificam que métricas são incrementadas após operações (ex: após `payment.captured`, verificar que `payment_attempts_total{status="CAPTURED"}` incrementou).

---

## Implementação

```typescript
// src/infrastructure/observability/logger.ts

import pino, { Logger } from 'pino'

export function createLogger(context: Record<string, unknown> = {}): Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: {
      service: 'payment-orchestrator',
      version: process.env.npm_package_version,
      ...context,
    },
    // Renomeia campos para convenção do projeto
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    // Dados sensíveis são redactados antes de logar (ADR-019)
    redact: {
      paths: ['*.card_number', '*.cvv', '*.cpf', '*.bank_account', 'req.headers.authorization'],
      censor: '[REDACTED]',
    },
  })
}

// Logger de request — child com request_id injetado
export function createRequestLogger(logger: Logger, requestId: string, traceId?: string): Logger {
  return logger.child({ request_id: requestId, trace_id: traceId })
}
```

```typescript
// src/infrastructure/observability/metrics.ts

import { Counter, Histogram, Gauge, register } from 'prom-client'

export const metrics = {
  // HTTP
  httpRequestDuration: new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  }),

  // Pagamentos
  paymentAttempts: new Counter({
    name: 'payment_attempts_total',
    help: 'Total payment attempts by status',
    labelNames: ['status', 'currency', 'gateway'],
  }),
  paymentDuration: new Histogram({
    name: 'payment_processing_duration_seconds',
    help: 'Time from PENDING to final status',
    labelNames: ['status'],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  }),

  // Ledger — o mais crítico
  ledgerBalanceDiscrepancy: new Gauge({
    name: 'ledger_balance_discrepancy_total',
    help: 'CRITICAL: number of unbalanced ledger entries. Must always be 0.',
  }),
  ledgerEntriesWritten: new Counter({
    name: 'ledger_entries_written_total',
    help: 'Total ledger entries written',
    labelNames: ['account_code'],
  }),

  // Outbox
  outboxUnprocessed: new Gauge({
    name: 'outbox_unprocessed_events_total',
    help: 'Number of unprocessed outbox events',
  }),

  // Circuit Breaker
  circuitBreakerState: new Gauge({
    name: 'circuit_breaker_state',
    help: 'Circuit breaker state (0=closed, 1=open, 2=half_open)',
    labelNames: ['name', 'state'],
  }),
}

// Endpoint /metrics
export function metricsHandler() {
  return async (_req: Request, res: Response) => {
    res.set('Content-Type', register.contentType)
    res.send(await register.metrics())
  }
}
```

```typescript
// src/web/middlewares/RequestContextMiddleware.ts
// Injeta request_id e cria logger filho para o ciclo de vida do request

export function requestContextMiddleware(baseLogger: Logger) {
  return (req: Request, res: Response, next: NextFunction) => {
    const requestId = (req.headers['x-request-id'] as string) ?? randomUUID()
    const traceId   = getCurrentTraceId() // do OpenTelemetry span ativo

    res.setHeader('X-Request-ID', requestId)

    // Logger filho com contexto do request — usado por todos os handlers
    req.logger = createRequestLogger(baseLogger, requestId, traceId)
    req.requestId = requestId

    // Métricas de duração do request
    const start = Date.now()
    res.on('finish', () => {
      metrics.httpRequestDuration
        .labels(req.method, req.route?.path ?? req.path, String(res.statusCode))
        .observe((Date.now() - start) / 1000)
    })

    next()
  }
}
```

```yaml
# docker-compose.yml — stack de observabilidade completa
services:
  prometheus:
    image: prom/prometheus:latest
    volumes:
      - ./infra/prometheus.yml:/etc/prometheus/prometheus.yml
    ports: ["9090:9090"]

  grafana:
    image: grafana/grafana:latest
    volumes:
      - ./infra/grafana/dashboards:/var/lib/grafana/dashboards
    ports: ["3001:3000"]
    environment:
      GF_AUTH_ANONYMOUS_ENABLED: "true"

  jaeger:
    image: jaegertracing/all-in-one:latest
    ports:
      - "16686:16686"  # UI
      - "4318:4318"    # OTLP HTTP receiver
```

**Arquivos:**
- `src/infrastructure/observability/logger.ts`
- `src/infrastructure/observability/metrics.ts`
- `src/infrastructure/observability/tracing.ts`
- `src/web/middlewares/RequestContextMiddleware.ts`
- `src/web/routes/health.ts`
- `infra/prometheus.yml`
- `infra/grafana/dashboards/payment-orchestrator.json`
