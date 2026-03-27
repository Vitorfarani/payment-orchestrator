# Runbook: Fila BullMQ acumulando jobs sem processamento

> **Severidade padrão:** ALTO
> **Equipe responsável:** Engenharia de Pagamentos
> **ADRs de referência:** ADR-009 (Outbox Pattern), ADR-012 (DLQ Policy), ADR-013 (Graceful Shutdown)

---

## Sintomas

O operador identifica este cenário por um ou mais dos sinais abaixo:

### Métricas (Prometheus / Grafana)

| Métrica | Condição de alerta | Significado |
|---|---|---|
| `queue_waiting_jobs{queue="payment-processing"}` | Crescendo por > 5 min | PaymentWorker não está consumindo |
| `queue_waiting_jobs{queue="ledger-entry"}` | Crescendo por > 5 min | LedgerWorker não está consumindo |
| `queue_waiting_jobs{queue="settlement-payout"}` | Crescendo por > 5 min | SettlementWorker não está consumindo |
| `queue_active_jobs{queue="..."}` | = 0 com waiting > 0 | Workers sem jobs ativos — fila parada |
| `queue_failed_jobs{queue="..."}` | > 10 em qualquer fila | DLQ acumulando — retries esgotados |
| `queue_failed_jobs{queue="ledger-entry"}` | > 0 | **CRÍTICO** — possível inconsistência financeira |
| `outbox_unprocessed_events_total` | Crescendo por > 5 min | OutboxRelay parado ou com falha |
| `outbox_relay_lag_seconds` | > 30s | Relay com latência anormal |

### Logs da aplicação

```
# Worker parou de consumir:
"Worker [payment-processing] is stalled" (nível warn)
"OutboxRelay stopped" sem "OutboxRelay started" em seguida

# Redis indisponível:
"Failed to connect to Redis"
"ECONNREFUSED" em qualquer log de worker

# DLQ acumulando:
"Jobs accumulating in DLQ" (nível warn)
"CRITICAL: Ledger jobs in DLQ" (nível error)
```

---

## Causas prováveis

1. **Worker crashou ou foi reiniciado durante deploy** — jobs ficam em `active` até o `stalledInterval` do BullMQ expirar e serem re-enfileirados
2. **Redis indisponível** — workers perdem conexão e não conseguem consumir novos jobs
3. **OutboxRelay parado** — eventos ficam em `outbox_events` com `processed = false` e nunca chegam à fila
4. **Circuit Breaker aberto** — PaymentWorker recebe jobs, falha na chamada ao gateway, retries acumulam até DLQ
5. **DLQ cheia** — retries esgotados, jobs estão em `failed` set sem processamento possível até intervenção manual
6. **Concorrência de shutdown** — deploy forçou `SIGKILL` antes do timeout de 90s, jobs ficaram em `active` sem conclusão

---

## Diagnóstico passo a passo

### Passo 1 — Confirmar que há backlog real

Consulte o endpoint de métricas da aplicação:

```bash
curl -s http://localhost:3000/metrics | grep -E "queue_waiting_jobs|queue_active_jobs|queue_failed_jobs"
```

Saída esperada em situação normal:
```
queue_waiting_jobs{queue="payment-processing"} 0
queue_active_jobs{queue="payment-processing"} 2
queue_failed_jobs{queue="payment-processing"} 0
```

Se `waiting` > 0 e `active` = 0 por mais de 1 minuto, há backlog real.

---

### Passo 2 — Verificar se o Redis está acessível

```bash
redis-cli -h $REDIS_HOST -p $REDIS_PORT ping
# Resposta esperada: PONG
```

Se a resposta for `ECONNREFUSED` ou timeout, o problema é o Redis. Vá para [Causa: Redis indisponível](#causa-redis-indisponível).

---

### Passo 3 — Inspecionar o estado das filas no Redis

BullMQ armazena jobs em chaves Redis com o prefixo `bull:{nome-da-fila}:`:

```bash
# Contar jobs em waiting por fila
redis-cli -h $REDIS_HOST llen "bull:payment-processing:wait"
redis-cli -h $REDIS_HOST llen "bull:ledger-entry:wait"
redis-cli -h $REDIS_HOST llen "bull:settlement-payout:wait"

# Contar jobs em active (em processamento ou travados)
redis-cli -h $REDIS_HOST llen "bull:payment-processing:active"
redis-cli -h $REDIS_HOST llen "bull:ledger-entry:active"

# Contar jobs na DLQ (failed set)
redis-cli -h $REDIS_HOST zcard "bull:payment-processing:failed"
redis-cli -h $REDIS_HOST zcard "bull:ledger-entry:failed"
redis-cli -h $REDIS_HOST zcard "bull:settlement-payout:failed"
```

---

### Passo 4 — Verificar o OutboxRelay

Consulte a contagem de eventos não processados no banco:

```sql
-- Quantos eventos estão pendentes de publicação
SELECT COUNT(*), event_type
FROM outbox_events
WHERE processed = false
GROUP BY event_type
ORDER BY COUNT(*) DESC;

-- Há quanto tempo o mais antigo está pendente
SELECT MIN(created_at), NOW() - MIN(created_at) AS lag
FROM outbox_events
WHERE processed = false;
```

Se houver eventos pendentes há mais de 30 segundos, o OutboxRelay não está funcionando. Vá para [Causa: OutboxRelay parado](#causa-outboxrelay-parado).

---

### Passo 5 — Verificar o Circuit Breaker

```bash
curl -s http://localhost:3000/metrics | grep circuit_breaker_state
```

Interpretação:
```
circuit_breaker_state{name="stripe-authorize",state="open"} 1   ← ABERTO (rejeitando)
circuit_breaker_state{name="stripe-authorize",state="closed"} 1 ← fechado (normal)
```

Se algum circuit breaker estiver em `state="open"`, o worker está recebendo jobs mas falhando na chamada ao gateway. Vá para [Causa: Circuit Breaker aberto](#causa-circuit-breaker-aberto).

---

### Passo 6 — Verificar jobs travados em `active`

Jobs com tempo excessivo em `active` podem indicar worker crashado ou processo travado:

```bash
# Listar IDs dos jobs em active na fila de pagamentos
redis-cli -h $REDIS_HOST lrange "bull:payment-processing:active" 0 -1
```

> ⚠️ **A definir** — Bull Board (interface web para inspecionar e reprocessar jobs individualmente) será configurado na Fase 6. Até lá, use o Redis CLI acima para inspecionar o conteúdo dos jobs.

---

## Resolução por causa

### Causa: Worker crashou ou processo parou

**Diagnóstico confirmado quando:** `queue_active_jobs` = 0 com `queue_waiting_jobs` > 0 e nenhum processo de worker no host.

**Ação:**

1. Reinicie o processo da aplicação. O BullMQ irá re-detectar os jobs `stalled` automaticamente via `stalledInterval` (padrão BullMQ: 30 segundos) e re-enfileirá-los.
2. Após o restart, confirme que os workers voltaram a consumir:
   ```bash
   curl -s http://localhost:3000/metrics | grep queue_active_jobs
   # queue_active_jobs > 0 indica consumo retomado
   ```
3. Monitore se o backlog de `queue_waiting_jobs` decresce.

---

### Causa: Redis indisponível

**Diagnóstico confirmado quando:** `redis-cli ping` não retorna `PONG`.

**Ação:**

1. Verifique o container/serviço Redis:
   ```bash
   docker compose ps redis
   docker compose logs redis --tail=50
   ```
2. Se o Redis estiver parado, reinicie:
   ```bash
   docker compose restart redis
   ```
3. Após o Redis voltar, os workers reconectam automaticamente (BullMQ tem retry de conexão embutido). Confirme reconexão nos logs da aplicação: `"Redis connection established"`.
4. Jobs que estavam em `waiting` permanecem na fila — serão processados automaticamente após reconexão.

---

### Causa: OutboxRelay parado

**Diagnóstico confirmado quando:** `outbox_unprocessed_events_total` cresce e `queue_waiting_jobs` permanece zerado (eventos nunca chegam à fila).

**Significado:** pagamentos foram criados e salvos no banco (Outbox Pattern garante isso), mas o relay não os está publicando na fila BullMQ. Não há perda de dados — os eventos estão em `outbox_events` com `processed = false`.

**Ação:**

1. Verifique os logs do OutboxRelay na aplicação por erros de conexão ou exceções.
2. Reinicie a aplicação. O relay é iniciado como parte do bootstrap (`relay.start()` em `main.ts`). Ao reiniciar, ele vai automaticamente processar todos os eventos pendentes na ordem de criação.
3. Acompanhe `outbox_unprocessed_events_total` — deve decrementar até zero.

---

### Causa: Circuit Breaker aberto

**Diagnóstico confirmado quando:** `circuit_breaker_state{state="open"}` = 1 e jobs em `active` estão sendo recolocados em retry.

**Significado:** o gateway de pagamentos (Stripe/Asaas) está degradado. O circuit breaker abre após 5 falhas em 10 chamadas e fica aberto por 30 segundos (ADR-008). Os jobs do PaymentWorker recebem erro `CIRCUIT_OPEN` e são re-enfileirados para retry com backoff exponencial.

**Ação:**

1. O circuito fecha automaticamente após 30 segundos (half-open para teste). **Não interfira manualmente** — o backoff com jitter está protegendo o gateway de uma nova sobrecarga (ADR-012).
2. Verifique o status do gateway externamente (status page do Stripe/Asaas).
3. Se o gateway estiver degradado por mais de 10 minutos, monitore se os jobs estão se acumulando na DLQ (`queue_failed_jobs`). Jobs com 5 retries esgotados vão para o `failed` set.
4. Quando o gateway se recuperar, o circuit breaker fecha e os jobs retomam o processamento normalmente.

---

### Causa: DLQ cheia (retries esgotados)

**Diagnóstico confirmado quando:** `queue_failed_jobs{queue="..."}` > 0 e os jobs não estão mais sendo retentados.

**Ação por fila:**

| Fila | Severidade | Próximo passo |
|---|---|---|
| `ledger-entry` | **CRÍTICO** | Acionar escalação imediatamente — ver seção abaixo |
| `payment-processing` | ALTO | Investigar causa raiz antes de reprocessar |
| `settlement-payout` | ALTO | Verificar se payout_date ainda está no futuro |

**Antes de reprocessar qualquer job da DLQ:**

1. Inspecione o stack trace do job para entender a causa da falha:
   ```bash
   redis-cli -h $REDIS_HOST zrange "bull:payment-processing:failed" 0 -1
   ```
2. Todos os workers são idempotentes (ADR-009) — reprocessar um job que já foi processado é seguro e retorna sucesso sem efeito colateral.
3. > ⚠️ **A definir** — O reprocessamento manual de jobs individuais da DLQ será feito via Bull Board (Fase 6). Até lá, o reprocessamento requer intervenção no código ou reinício seletivo da fila.

---

## Como verificar que o problema foi resolvido

Execute a sequência abaixo e confirme todas as condições:

```bash
# 1. Backlog zerado
curl -s http://localhost:3000/metrics | grep queue_waiting_jobs
# Esperado: todos os valores = 0 ou decrescendo

# 2. Workers ativos
curl -s http://localhost:3000/metrics | grep queue_active_jobs
# Esperado: valores > 0 se há jobs, OU 0 se não há jobs na fila

# 3. DLQ sem crescimento
curl -s http://localhost:3000/metrics | grep queue_failed_jobs
# Esperado: 0 para payment e settlement; QUALQUER valor > 0 em ledger-entry é crítico

# 4. OutboxRelay funcionando
curl -s http://localhost:3000/metrics | grep outbox_unprocessed_events_total
# Esperado: 0 ou decrescendo

# 5. Circuit breakers fechados
curl -s http://localhost:3000/metrics | grep 'circuit_breaker_state.*open'
# Esperado: nenhum resultado com valor = 1
```

```sql
-- 6. Confirmar no banco que outbox está drenado
SELECT COUNT(*) FROM outbox_events WHERE processed = false;
-- Esperado: 0
```

---

## Escalação

Acione o time de engenharia imediatamente se qualquer uma das condições abaixo for verdadeira:

| Condição | Nível |
|---|---|
| `queue_failed_jobs{queue="ledger-entry"}` > 0 | CRÍTICO — possível inconsistência financeira. Acione também o runbook `docs/runbooks/ledger-discrepancy.md` |
| Backlog de `queue_waiting_jobs` > 500 em qualquer fila por > 15 min | ALTO |
| Redis indisponível por > 5 minutos | ALTO |
| OutboxRelay com lag > 5 minutos | ALTO |
| Circuit breaker aberto por > 30 minutos | MÉDIO — gateway pode estar com incidente |

> ⚠️ **A definir** — Canal de escalação (Slack, PagerDuty, etc.) e contatos de plantão serão definidos na Fase 6 junto com a configuração de alertas do Grafana.
