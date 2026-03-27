# Runbook: Pagamento travado no status PROCESSING

> **Severidade padrão:** ALTO
> **Equipe responsável:** Engenharia de Pagamentos
> **ADRs de referência:** ADR-004 (State Machine), ADR-008 (Circuit Breaker), ADR-009 (Outbox Pattern), ADR-012 (DLQ Policy)

---

## Sintomas

O operador identifica este cenário por um ou mais dos sinais abaixo:

### Via API / banco de dados

- `GET /payments/:id` retorna `status: "PROCESSING"` por mais de 2 minutos sem progressão
- Consulta no banco retorna `status = 'PROCESSING'` com `updated_at` parado no tempo:
  ```sql
  SELECT id, status, updated_at, NOW() - updated_at AS lag
  FROM payments
  WHERE status = 'PROCESSING'
  AND updated_at < NOW() - INTERVAL '2 minutes';
  ```

### Via métricas (Prometheus / Grafana)

| Métrica | Condição | Significado |
|---|---|---|
| `queue_failed_jobs{queue="payment-processing"}` | > 0 | Job do pagamento foi para a DLQ |
| `queue_active_jobs{queue="payment-processing"}` | = 0 com pagamentos em PROCESSING | Worker não está consumindo |
| `circuit_breaker_state{state="open"}` | = 1 | Circuit Breaker aberto — worker falhando nas chamadas ao gateway |
| `payment_processing_duration_seconds` | Bucket alto (> 60s) crescendo | Pagamentos demorando mais que o esperado |

### Via logs da aplicação

```
# Worker não encontrou o job:
"Payment not found — skipping job" — indica paymentId inválido no job

# Circuit Breaker aberto:
"Circuit breaker opened" com circuit="stripe-authorize" ou circuit="stripe-capture"

# Split rule ausente (UnrecoverableError — DLQ):
"No active split rule found for seller X. Payment Y was captured but cannot be accounted"

# Job indo para DLQ:
"CRITICAL: Ledger jobs in DLQ"
```

---

## Causas prováveis

1. **PaymentWorker crashou durante o processamento** — job ficou em `active` no BullMQ; o pagamento transicionou para PROCESSING mas o worker morreu antes de concluir
2. **Circuit Breaker aberto** — gateway (Stripe/Asaas) está degradado; worker continua recebendo o job mas falha nas chamadas e recoloca para retry
3. **Job esgotou os retries e foi para a DLQ** — 5 tentativas falharam; o job está em `failed` e o pagamento permanece em PROCESSING indefinidamente
4. **Split rule ausente após capture** — o gateway capturou o pagamento mas não existe `SplitRule` ativa para o seller; `UnrecoverableError` enviou o job para DLQ
5. **OutboxEvent não chegou na fila** — `outbox_events` tem o evento com `processed = false` mas o OutboxRelay está parado; o job nunca foi criado no BullMQ

---

## Diagnóstico passo a passo

### Passo 1 — Confirmar o pagamento travado e há quanto tempo

```sql
SELECT id, status, seller_id, gateway_payment_id, updated_at,
       NOW() - updated_at AS stuck_for
FROM payments
WHERE id = '<payment_id>';
```

Se `status = 'PROCESSING'` e `stuck_for > 2 minutes`, confirma o cenário.

---

### Passo 2 — Verificar se há um job ativo, em espera ou na DLQ para este pagamento

O `jobId` no BullMQ é o `id` do OutboxEvent (não o `payment_id`). Para rastrear pelo `payment_id`, consulte primeiro o outbox:

```sql
-- Encontrar o OutboxEvent correspondente ao pagamento
SELECT id, event_type, processed, retry_count, created_at, processed_at
FROM outbox_events
WHERE aggregate_id = '<payment_id>'
ORDER BY created_at DESC;
```

Com o `id` do OutboxEvent (que é o `jobId` no BullMQ), verifique o estado do job no Redis:

```bash
# Verificar se o job está em waiting
redis-cli -h $REDIS_HOST lrange "bull:payment-processing:wait" 0 -1 | grep '<outbox_event_id>'

# Verificar se está em active (em processamento)
redis-cli -h $REDIS_HOST lrange "bull:payment-processing:active" 0 -1 | grep '<outbox_event_id>'

# Verificar se está na DLQ (failed set)
redis-cli -h $REDIS_HOST zrange "bull:payment-processing:failed" 0 -1 | grep '<outbox_event_id>'
```

---

### Passo 3 — Verificar o estado do Circuit Breaker

```bash
curl -s http://localhost:3000/metrics | grep circuit_breaker_state
```

Interpretação:
```
circuit_breaker_state{name="stripe-authorize",state="open"} 1   ← ABERTO
circuit_breaker_state{name="stripe-capture",state="open"} 1     ← ABERTO
circuit_breaker_state{name="stripe-authorize",state="closed"} 1 ← normal
```

Se algum breaker estiver `open`, os jobs estão falhando nas chamadas ao gateway. Vá para [Causa: Circuit Breaker aberto](#causa-circuit-breaker-aberto).

---

### Passo 4 — Verificar o OutboxRelay (se o job nunca chegou na fila)

Se no Passo 2 o OutboxEvent existe com `processed = false` e não há job no BullMQ:

```bash
curl -s http://localhost:3000/metrics | grep outbox_unprocessed_events_total
# Se > 0 e crescendo, o OutboxRelay está parado
```

Consulte também o runbook `docs/runbooks/queue-backlog.md` para diagnosticar o OutboxRelay.

---

### Passo 5 — Checar se o job foi para a DLQ com UnrecoverableError

```bash
curl -s http://localhost:3000/metrics | grep 'queue_failed_jobs{queue="payment-processing"}'
```

Se `queue_failed_jobs > 0`, verifique os logs por `"No active split rule found"` ou outros erros terminais. Vá para [Causa: Split rule ausente](#causa-split-rule-ausente-após-capture).

---

## Resolução por causa

### Causa: Worker crashou — job travado em `active`

**Diagnóstico confirmado quando:** job está em `active` no Redis mas não há processamento em andamento (nenhum log recente do worker para este `payment_id`).

**Ação:**

O BullMQ detecta jobs `stalled` automaticamente via `stalledInterval` (padrão: 30 segundos). Quando detectado, o job é re-enfileirado automaticamente para retry.

1. Aguarde até 30 segundos. O job deve sair de `active` e voltar para `waiting`.
2. Se após 1 minuto o job ainda estiver em `active`, reinicie o processo da aplicação:
   ```bash
   docker compose restart api
   ```
3. Após reinício, confirme que o worker voltou a consumir:
   ```bash
   curl -s http://localhost:3000/metrics | grep queue_active_jobs
   ```
4. Acompanhe o status do pagamento até sair de PROCESSING:
   ```sql
   SELECT status, updated_at FROM payments WHERE id = '<payment_id>';
   ```

---

### Causa: Circuit Breaker aberto

**Diagnóstico confirmado quando:** `circuit_breaker_state{state="open"}` = 1 para `stripe-authorize` ou `stripe-capture`.

**Ação:**

1. **Não interfira manualmente.** O circuito fecha automaticamente após 30 segundos (half-open para teste) e o worker retoma o processamento sem intervenção (ADR-008).
2. Verifique o status do gateway externamente (status page do Stripe/Asaas).
3. O pagamento permanece em PROCESSING durante os retries — isso é esperado. O job será reprocessado assim que o circuito fechar.
4. Monitore `circuit_breaker_state` até retornar a `closed`:
   ```bash
   curl -s http://localhost:3000/metrics | grep circuit_breaker_state
   # circuit_breaker_state{name="stripe-authorize",state="closed"} 1
   ```
5. Se o gateway estiver degradado por mais de 10 minutos, acompanhe `queue_failed_jobs` — jobs que esgotarem 5 retries com circuito aberto irão para a DLQ. Vá para [Causa: Job na DLQ — gateway indisponível](#causa-job-na-dlq--gateway-indisponível).

---

### Causa: Job na DLQ — gateway indisponível

**Diagnóstico confirmado quando:** `queue_failed_jobs{queue="payment-processing"}` > 0 e os logs mostram `CIRCUIT_OPEN` ou erro de conexão como causa das falhas.

**Ação:**

1. Aguarde o gateway se recuperar (confirme via status page e `circuit_breaker_state` voltando a `closed`).
2. Todos os workers são idempotentes — reprocessar é seguro (ADR-009). O PaymentWorker verifica o estado atual do pagamento antes de qualquer ação; se já foi processado, retorna silenciosamente.
3. > ⚠️ **A definir** — O reprocessamento manual de jobs individuais da DLQ será feito via Bull Board (Fase 6). Até lá, o reprocessamento requer intervenção direta.

---

### Causa: Split rule ausente após capture

**Diagnóstico confirmado quando:** logs contêm `"No active split rule found for seller X"` e o job está na DLQ com `UnrecoverableError`.

**Contexto:** este é um cenário crítico. A captura **já ocorreu no gateway** — o cliente foi cobrado. O pagamento está em PROCESSING no banco mas o dinheiro foi capturado. Retry automático não resolve porque o problema é de dados, não de infraestrutura.

**Ação:**

1. Identifique o `seller_id` do pagamento:
   ```sql
   SELECT seller_id FROM payments WHERE id = '<payment_id>';
   ```
2. Verifique se existe uma split rule ativa para esse seller:
   ```sql
   SELECT * FROM split_rules
   WHERE seller_id = '<seller_id>'
   AND is_active = true;
   ```
3. Se não existir, crie a split rule via API antes de reprocessar:
   > ⚠️ **A definir** — endpoint `POST /sellers/:id/split-rules` será implementado na Fase 6.
4. Após criar a split rule, reprocesse o job da DLQ.
5. Registre um `audit_log` de `admin.job_reprocessed` com o contexto do incidente.

---

### Causa: OutboxEvent não chegou na fila

**Diagnóstico confirmado quando:** `outbox_events` tem o evento com `processed = false` e não há job correspondente no BullMQ.

**Ação:**

O Outbox Pattern garante que o evento existe no banco (foi escrito na mesma transação que o pagamento). Não há perda de dados. O problema é que o OutboxRelay não está publicando.

Consulte o runbook `docs/runbooks/queue-backlog.md` — seção [Causa: OutboxRelay parado](queue-backlog.md#causa-outboxrelay-parado).

---

## Como verificar que o problema foi resolvido

```sql
-- 1. Pagamento saiu de PROCESSING para estado final
SELECT id, status, updated_at
FROM payments
WHERE id = '<payment_id>';
-- Esperado: status IN ('CAPTURED', 'FAILED', 'CANCELLED')
-- PROCESSING indica que ainda está em andamento

-- 2. OutboxEvent foi processado
SELECT processed, processed_at, retry_count
FROM outbox_events
WHERE aggregate_id = '<payment_id>'
ORDER BY created_at DESC
LIMIT 1;
-- Esperado: processed = true
```

```bash
# 3. Sem jobs na DLQ de payment-processing
curl -s http://localhost:3000/metrics | grep 'queue_failed_jobs{queue="payment-processing"}'
# Esperado: 0

# 4. Circuit breakers fechados
curl -s http://localhost:3000/metrics | grep 'circuit_breaker_state.*open.*1'
# Esperado: nenhum resultado
```

---

## Escalação

Acione o time de engenharia imediatamente se:

| Condição | Nível |
|---|---|
| Split rule ausente após capture (`UnrecoverableError` na DLQ) | **CRÍTICO** — cliente foi cobrado mas o ledger não registrou; acionar também `docs/runbooks/ledger-discrepancy.md` |
| > 10 pagamentos travados em PROCESSING simultaneamente | ALTO — possível incidente de gateway ou falha sistêmica do worker |
| Pagamento em PROCESSING por > 15 minutos sem job ativo ou em DLQ | ALTO — estado inconsistente sem job correspondente detectado |
| Circuit Breaker aberto por > 30 minutos | MÉDIO — gateway com incidente prolongado |

> ⚠️ **A definir** — Canal de escalação (Slack, PagerDuty, etc.) e contatos de plantão serão definidos na Fase 6.
