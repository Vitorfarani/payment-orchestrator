# ADR-012: Política de Dead Letter Queue — retries, TTL e alertas

## Metadados

| Campo | Valor |
|---|---|
| **ID** | ADR-012 |
| **Título** | Política de Dead Letter Queue — retries, TTL e alertas |
| **Status** | `accepted` |
| **Data** | 2025-01-01 |
| **Contextos afetados** | Todos os workers (PaymentWorker, LedgerWorker, SettlementWorker, OutboxRelay) |
| **Depende de** | ADR-009 (Outbox Pattern), ADR-003 (Sync vs Async) |
| **Bloqueia** | Configuração de todos os workers BullMQ |

---

## Contexto

Quando um job em uma fila falha, o sistema precisa de uma política clara para responder às perguntas:

- Quantas vezes tentamos de novo?
- Quanto tempo esperamos entre tentativas?
- O que acontece quando todas as tentativas se esgotam?
- Por quanto tempo mantemos jobs com falha para investigação?
- Quem é notificado quando um job vai para a DLQ?

Sem uma política documentada, cada worker tem configuração diferente, falhas silenciosas passam despercebidas, e jobs críticos (como registros de Ledger) podem desaparecer sem nenhum alerta.

Em sistemas financeiros, um job que vai para a DLQ sem alerta pode significar um pagamento não processado, uma entrada de Ledger faltando, ou um payout não executado — todos com impacto financeiro real.

---

## Decisão

### Configuração padrão de retry (aplicada a todos os workers, salvo especificação)

```typescript
const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,                     // 5 tentativas totais (1 original + 4 retries)
  backoff: {
    type: 'exponential',
    delay: 2000,                   // delay inicial: 2 segundos
  },
  // Delays resultantes: 2s, 4s, 8s, 16s → total de ~30s antes da DLQ
  removeOnComplete: { count: 100 }, // mantém os 100 últimos jobs concluídos
  removeOnFail: false,              // jobs com falha NUNCA são removidos automaticamente
}
```

### Sequência de delays com backoff exponencial

```
Tentativa 1 (original):  imediata
Tentativa 2 (retry 1):   após 2 segundos
Tentativa 3 (retry 2):   após 4 segundos
Tentativa 4 (retry 3):   após 8 segundos
Tentativa 5 (retry 4):   após 16 segundos
                         ─────────────────
Total antes da DLQ:      ~30 segundos
Job vai para failed set (DLQ)
```

### Configurações específicas por worker

Alguns workers têm necessidades diferentes do padrão:

| Worker | Attempts | Delay inicial | Justificativa |
|---|---|---|---|
| PaymentWorker | 5 | 2s | Padrão |
| LedgerWorker | 8 | 1s | Crítico — tenta mais antes de desistir |
| SettlementWorker | 3 | 30s | Payouts têm custo de transação — não agressivo |
| OutboxRelay | 10 | 500ms | Alta frequência, falhas transientes comuns |
| WebhookOutbound | 5 | 5s | Sistemas externos podem estar lentos |

### Dead Letter Queue — o que acontece quando todos os retries se esgotam

BullMQ não tem uma "DLQ" separada — jobs que esgotam tentativas ficam no **`failed` set** da fila. Tratamos esse set como nossa DLQ.

**Comportamento após esgotar retries:**

1. Job entra no `failed` set com stack trace completo
2. Alerta é disparado (métrica `queue_failed_jobs_total` > threshold)
3. Job fica no `failed` set por **30 dias** antes de ser limpo
4. Durante esses 30 dias, pode ser inspecionado via Bull Board e reprocessado manualmente

### Jitter — evitar thundering herd

Em situações de gateway degradado, todos os jobs falham simultaneamente e vão para retry com o mesmo timing — causando uma nova sobrecarga sincronizada (thundering herd).

Adicionamos jitter randômico ao backoff:

```typescript
// delay efetivo = delay_exponencial × (0.75 + random() × 0.5)
// Para delay base de 2s: efetivo entre 1.5s e 3.0s
// Distribui os retries ao longo de uma janela de tempo
backoff: {
  type: 'custom',
  delay: (attemptsMade) => {
    const exponential = 2000 * Math.pow(2, attemptsMade - 1)
    const jitter = exponential * (0.75 + Math.random() * 0.5)
    return Math.min(jitter, 60000) // cap de 60 segundos
  }
}
```

### Alertas obrigatórios

| Condição | Severidade | Ação |
|---|---|---|
| `LedgerWorker` job na DLQ | CRÍTICO | Alerta imediato — possível inconsistência financeira |
| `SettlementWorker` job na DLQ | ALTO | Alerta em 5 minutos — payout não executado |
| `PaymentWorker` job na DLQ | ALTO | Alerta em 5 minutos — pagamento não processado |
| Qualquer worker: > 10 jobs na DLQ | MÉDIO | Alerta em 15 minutos |

---

## Alternativas consideradas

### Alternativa 1: Fila DLQ separada (padrão AWS SQS / RabbitMQ)

Criar uma fila separada `payment-dlq`, `ledger-dlq`, etc., para onde jobs são movidos após falha.

**Prós:** isolamento claro, pode ter consumidores dedicados para reprocessamento.
**Contras:** complexidade adicional. BullMQ já tem o `failed` set que serve o mesmo propósito com menos overhead. Criar filas separadas sem um sistema de mensageria dedicado (RabbitMQ, Kafka) adiciona complexidade sem benefício claro.
**Por que descartada:** o `failed` set do BullMQ + Bull Board fornece visibilidade suficiente. Podemos inspecionar, reprocessar e apagar jobs falhos sem infraestrutura adicional.

### Alternativa 2: Retry infinito sem DLQ

Continuar tentando para sempre, sem mover para DLQ.

**Prós:** nenhum job é "perdido".
**Contras:** jobs com falha permanente (bug no código, dados inválidos) ficam em retry para sempre, consumindo recursos. Sem visibilidade clara do que está falhando. Sem alerta.
**Por que descartada:** inaceitável operacionalmente. Alguns jobs vão ter falhas permanentes (bug de código) que não vão se resolver com retry. Esses precisam de intervenção manual — não retry infinito.

### Alternativa 3: Retry imediato (sem backoff)

Tentar imediatamente após falha, sem esperar.

**Prós:** menor latência para jobs que falham por erro transiente.
**Contras:** em situações de gateway degradado ou banco sobrecarregado, retries imediatos aumentam a carga e pioram a situação. Backoff exponencial dá tempo para o sistema se recuperar.
**Por que descartada:** anti-pattern conhecido. Backoff exponencial + jitter é o padrão da indústria exatamente porque evita piorar situações já degradadas.

---

## Consequências

### Positivas
- Comportamento previsível e documentado para todos os workers.
- Nenhum job falha silenciosamente — sempre há alerta e registro.
- Jitter distribui a carga de retry, protegendo sistemas já degradados.
- Bull Board oferece visibilidade completa da DLQ sem código adicional.

### Negativas / Trade-offs
- Jobs críticos (Ledger) podem demorar até 30 segundos para esgotar retries — possível lag na contabilização.
- O `failed` set cresce com o tempo — job de limpeza após 30 dias é necessário.
- Reprocessamento manual de jobs na DLQ requer acesso ao Bull Board — não há UI de negócio para isso em v1.

### Riscos e mitigações

- **Risco:** job do LedgerWorker vai para DLQ e a inconsistência financeira não é detectada.
  **Mitigação:** alerta crítico imediato + runbook `docs/runbooks/ledger-discrepancy.md`. O LedgerWorker tem 8 tentativas (vs 5 padrão) exatamente por ser o worker mais crítico.

- **Risco:** desenvolvedor reprocessa job da DLQ sem entender a causa raiz, causando duplicata.
  **Mitigação:** todos os workers são idempotentes (ADR-009). Reprocessar um job que já foi processado retorna sucesso sem efeito colateral.

---

## Implementação

```typescript
// src/infrastructure/queue/jobOptions.ts
// Configurações centralizadas — importadas por todos os workers

import type { JobsOptions } from 'bullmq'

const exponentialWithJitter = (attemptsMade: number): number => {
  const base = 2000 * Math.pow(2, attemptsMade - 1)
  const jitter = base * (0.75 + Math.random() * 0.5)
  return Math.min(Math.floor(jitter), 60_000)
}

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'custom', delay: exponentialWithJitter },
  removeOnComplete: { count: 100 },
  removeOnFail: false,
}

export const LEDGER_JOB_OPTIONS: JobsOptions = {
  ...DEFAULT_JOB_OPTIONS,
  attempts: 8,
  backoff: {
    type: 'custom',
    delay: (attemptsMade) => {
      // Delay menor inicial — o Ledger precisa ser processado rápido
      const base = 1000 * Math.pow(2, attemptsMade - 1)
      const jitter = base * (0.75 + Math.random() * 0.5)
      return Math.min(Math.floor(jitter), 30_000)
    }
  },
}

export const SETTLEMENT_JOB_OPTIONS: JobsOptions = {
  ...DEFAULT_JOB_OPTIONS,
  attempts: 3,
  backoff: {
    type: 'custom',
    delay: () => 30_000 + Math.floor(Math.random() * 10_000) // 30-40s fixo
  },
}
```

```typescript
// src/infrastructure/queue/QueueMonitor.ts
// Alerta quando jobs entram na DLQ

export class QueueMonitor {
  async checkFailedJobs(): Promise<void> {
    const queues = ['payment-processing', 'ledger-entry', 'settlement-payout']

    for (const queueName of queues) {
      const queue = new Queue(queueName, { connection: this.redis })
      const failedCount = await queue.getFailedCount()

      metrics.queueFailedJobs.set({ queue: queueName }, failedCount)

      // Alerta crítico para o Ledger
      if (queueName === 'ledger-entry' && failedCount > 0) {
        this.logger.error({ queue: queueName, failedCount },
          'CRITICAL: Ledger jobs in DLQ — possible financial inconsistency')
      } else if (failedCount > 10) {
        this.logger.warn({ queue: queueName, failedCount },
          'Jobs accumulating in DLQ')
      }
    }
  }
}
```

**Arquivos:**
- `src/infrastructure/queue/jobOptions.ts`
- `src/infrastructure/queue/QueueMonitor.ts`
- `src/infrastructure/queue/workers/` — todos os workers importam de `jobOptions.ts`
