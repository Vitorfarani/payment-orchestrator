# ADR-009: Outbox Pattern para publicação atômica de eventos de domínio

## Metadados

| Campo | Valor |
|---|---|
| **ID** | ADR-009 |
| **Título** | Outbox Pattern para publicação atômica de eventos de domínio |
| **Status** | `accepted` |
| **Data** | 2025-01-01 |
| **Contextos afetados** | Todos (decisão transversal) |
| **Depende de** | ADR-003 (Sync vs Async) |
| **Bloqueia** | OutboxRelay, todos os workers que consomem eventos de domínio |

---

## Contexto

Em sistemas distribuídos, existe um problema fundamental chamado **dual-write**: quando uma operação precisa escrever em dois sistemas diferentes (banco de dados E fila de mensagens), não existe garantia atômica entre os dois. Qualquer falha entre as duas escritas resulta em estado inconsistente.

```typescript
// O código que PARECE correto mas está ERRADO:
await db.save(payment)           // 1. Banco commita ✓
await queue.publish(event)       // 2. Fila falha ✗

// Resultado: payment existe no banco, mas o worker nunca vai processar.
// O pagamento fica em PENDING para sempre. O dinheiro some.
```

Isso não é um cenário hipotético — é o que acontece em:
- Restart da aplicação entre as duas operações
- Falha de rede para o Redis após o commit do banco
- Bug no código de serialização do evento
- Timeout do Redis sob alta carga

Em um sistema financeiro, qualquer pagamento "perdido" entre o banco e a fila é um incidente grave.

---

## Decisão

Adotaremos o **Transactional Outbox Pattern**: eventos de domínio são persistidos em uma tabela `outbox_events` **dentro da mesma transação do banco** que persiste a mudança de estado. Um processo separado (Outbox Relay) lê a tabela e publica na fila de forma eventual.

### Garantia central

```
Se o banco commita → o evento SERÁ publicado, eventualmente.
Se o banco faz rollback → o evento NÃO é publicado.

Não existe estado intermediário onde o banco commita mas o evento desaparece.
```

### Entrega at-least-once

O Outbox Relay pode publicar o mesmo evento mais de uma vez em caso de falha após publicar mas antes de marcar como `processed`. Por isso, **todos os workers que consomem eventos do Outbox devem ser idempotentes** — processar o mesmo evento duas vezes deve ter o mesmo resultado que processar uma vez.

### Estrutura da tabela outbox_events

```sql
CREATE TABLE outbox_events (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type      VARCHAR(100) NOT NULL,   -- ex: 'payment.captured'
  aggregate_id    VARCHAR(255) NOT NULL,   -- ex: payment_id
  aggregate_type  VARCHAR(100) NOT NULL,   -- ex: 'Payment'
  payload         JSONB       NOT NULL,
  processed       BOOLEAN     NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at    TIMESTAMPTZ,
  retry_count     SMALLINT    NOT NULL DEFAULT 0
);

CREATE INDEX idx_outbox_unprocessed ON outbox_events (created_at)
  WHERE processed = false;
```

### Outbox Relay — o processo de publicação

O Relay é um worker simples que roda a cada 1 segundo (polling) e:
1. Busca eventos não processados (`processed = false`) em ordem de criação
2. Para cada evento, publica no BullMQ
3. Marca como `processed = true` no banco
4. Em caso de falha na publicação, incrementa `retry_count`

O Relay usa `SELECT ... FOR UPDATE SKIP LOCKED` para garantir que múltiplas instâncias do Relay não processem o mesmo evento.

---

## Alternativas consideradas

### Alternativa 1: Publicar na fila diretamente (dual-write)

Após salvar no banco, publicar diretamente no Redis/BullMQ.

**Prós:** simples, sem tabela extra, sem processo de relay.
**Contras:** não é atômico. Falha entre as duas operações resulta em evento perdido. Sem mecanismo de recovery — o evento simplesmente não existe mais.
**Por que descartada:** inaceitável para sistema financeiro. Um evento perdido = um pagamento não processado = incidente.

### Alternativa 2: CDC com Debezium (Change Data Capture)

Usar Debezium para monitorar o transaction log do PostgreSQL (WAL) e publicar eventos automaticamente quando houver mudanças.

**Prós:** mais eficiente que polling, latência muito baixa (milissegundos), sem processo de relay customizado.
**Contras:** requer infraestrutura adicional significativa (Debezium connector, Kafka ou similar). Complexidade operacional muito maior — Debezium tem curva de aprendizado alta e problemas de configuração comuns. Para um portfólio, é over-engineering claro.
**Por que descartada:** o Outbox com polling de 1 segundo atende perfeitamente o requisito de performance deste projeto. CDC seria considerado se o volume exigisse latência < 100ms ou se o polling fosse gargalo mensurável.

### Alternativa 3: Two-phase commit (2PC) entre banco e fila

Usar protocolo de commit distribuído para garantir atomicidade entre PostgreSQL e Redis.

**Prós:** atomicidade real sem processo extra.
**Contras:** Redis não suporta 2PC. Mesmo com suporte, 2PC tem problemas conhecidos de performance e disponibilidade (coordenador pode falhar e deixar participantes em estado de dúvida). Complexidade desproporcional.
**Por que descartada:** impossível com Redis. Mesmo se fosse possível, o Outbox Pattern é mais simples e igualmente confiável.

---

## Consequências

### Positivas
- Atomicidade garantida: impossível ter estado no banco sem evento correspondente.
- Recovery automático: se o Relay falhar e reiniciar, vai reprocessar eventos não marcados.
- Auditoria: a tabela `outbox_events` é um log histórico de todos os eventos do sistema.
- Independência: o banco pode commitar mesmo que o BullMQ esteja temporariamente indisponível.

### Negativas / Trade-offs
- **At-least-once delivery**: eventos podem ser entregues mais de uma vez. Workers devem ser idempotentes. Isso é um requisito para todos que implementam workers neste projeto.
- Latência adicional: eventos não são publicados instantaneamente — há um lag de até 1 segundo (intervalo do polling). Aceitável para o domínio de pagamentos.
- Processo adicional (Outbox Relay) que precisa ser monitorado.
- Crescimento da tabela `outbox_events` — job de limpeza de registros antigos necessário.

### Riscos e mitigações

- **Risco:** Outbox Relay para de rodar e eventos acumulam sem serem publicados.
  **Mitigação:** métrica `outbox_unprocessed_events_count` monitorada. Alerta se > 100 eventos não processados por mais de 5 minutos. O Relay é supervisionado pelo BullMQ repeat job com `every: 1000ms`.

- **Risco:** worker processa o mesmo evento duas vezes (at-least-once) e cria duplicata no Ledger.
  **Mitigação:** cada worker verifica o `event_id` do OutboxEvent antes de processar. Se já existe entrada no Ledger para aquele `event_id`, retorna sucesso sem reprocessar. A idempotência é obrigatória em todos os workers.

- **Risco:** tabela `outbox_events` cresce indefinidamente.
  **Mitigação:** job de housekeeping semanal deleta eventos com `processed = true AND processed_at < NOW() - INTERVAL '30 days'`. O índice `WHERE processed = false` garante que queries do Relay não são afetadas pelo crescimento da tabela.

---

## Implementação

```typescript
// src/infrastructure/outbox/OutboxRelay.ts

export class OutboxRelay {
  private isRunning = false

  async start(): Promise<void> {
    this.isRunning = true
    this.logger.info('OutboxRelay started')

    while (this.isRunning) {
      await this.processOnce()
      await sleep(1000) // polling a cada 1 segundo
    }
  }

  stop(): void {
    this.isRunning = false
    this.logger.info('OutboxRelay stopped')
  }

  async processOnce(): Promise<void> {
    // SELECT FOR UPDATE SKIP LOCKED: múltiplas instâncias não pegam o mesmo evento
    const events = await this.db.raw(`
      SELECT * FROM outbox_events
      WHERE processed = false
      ORDER BY created_at ASC
      LIMIT 100
      FOR UPDATE SKIP LOCKED
    `)

    for (const event of events.rows) {
      await this.publishEvent(event)
    }
  }

  private async publishEvent(event: OutboxEventRow): Promise<void> {
    try {
      // Publica no BullMQ com o event_id como jobId (garante idempotência na fila)
      await this.queue.add(event.event_type, event.payload, {
        jobId: event.id,           // BullMQ ignora job duplicado com mesmo jobId
        removeOnComplete: false,   // mantém para auditoria
      })

      // Marca como processado dentro de uma transação
      await this.db('outbox_events')
        .where({ id: event.id })
        .update({ processed: true, processed_at: new Date() })

    } catch (error) {
      // Falha ao publicar — incrementa retry_count, mas não falha o loop inteiro
      await this.db('outbox_events')
        .where({ id: event.id })
        .increment('retry_count', 1)

      this.logger.error({ eventId: event.id, error }, 'Failed to publish outbox event')
    }
  }
}
```

```typescript
// Como usar no use case — padrão obrigatório para toda escrita + evento:

await this.db.transaction(async (trx) => {
  // 1. Escrita principal
  await this.paymentRepo.save(payment, trx)

  // 2. OutboxEvent na MESMA transação — nunca fora
  await this.outboxRepo.save(
    OutboxEvent.create({
      eventType:     'payment.captured',
      aggregateId:   payment.id,
      aggregateType: 'Payment',
      payload:       { paymentId: payment.id, amountCents: payment.amount, sellerId: payment.sellerId },
    }),
    trx  // ← mesma transação, obrigatório
  )
  // Se qualquer uma das duas operações falhar, AMBAS são revertidas
})
```

```typescript
// Como implementar idempotência em um worker (obrigatório para todos):

export class LedgerWorker {
  async process(job: Job): Promise<void> {
    const { eventId, paymentId } = job.data

    // Verifica se este evento já foi processado (at-least-once protection)
    const alreadyProcessed = await this.ledgerRepo.existsByOutboxEventId(eventId)
    if (alreadyProcessed) {
      this.logger.info({ eventId }, 'Event already processed, skipping')
      return  // idempotente: retorna sucesso sem reprocessar
    }

    await this.db.transaction(async (trx) => {
      await this.recordDoubleEntry(paymentId, trx)
      // Salva o eventId para detectar duplicatas futuras
      await this.ledgerRepo.saveProcessedEventId(eventId, trx)
    })
  }
}
```

**Arquivos:**
- `src/infrastructure/outbox/OutboxRelay.ts`
- `src/infrastructure/outbox/OutboxEventRepository.ts`
- `src/infrastructure/database/migrations/010_outbox_events.ts`
