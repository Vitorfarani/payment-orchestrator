# ADR-003: Processamento síncrono vs assíncrono de pagamentos

## Metadados

| Campo | Valor |
|---|---|
| **ID** | ADR-003 |
| **Título** | Processamento síncrono vs assíncrono de pagamentos |
| **Status** | `accepted` |
| **Data** | 2025-01-01 |
| **Contextos afetados** | PaymentContext, WebhookContext |
| **Depende de** | ADR-002 (Idempotência), ADR-004 (State Machine), ADR-009 (Outbox) |
| **Bloqueia** | CreatePaymentUseCase, PaymentController, arquitetura geral dos workers |

---

## Contexto

Quando o cliente faz `POST /payments`, existem duas abordagens possíveis para a resposta:

**Síncrona:** a API chama o gateway (Stripe/Asaas) durante o request HTTP, aguarda a resposta, e retorna o resultado final ao cliente em uma única chamada. O cliente sabe imediatamente se o pagamento foi aprovado ou recusado.

**Assíncrona:** a API salva o pagamento como `PENDING`, retorna `202 Accepted` imediatamente, e o processamento acontece em background por um worker. O cliente precisa fazer polling ou receber um webhook para saber o resultado.

O problema é que cada abordagem tem trade-offs sérios para um sistema de pagamentos:

A abordagem **síncrona** amarra o request HTTP ao tempo de resposta do gateway externo (pode ser 200ms a 5s). Se o gateway estiver lento, todos os requests ficam lentos. Se o gateway cair, todos os requests falham imediatamente — sem possibilidade de retry transparente. Mas o cliente tem uma resposta imediata, o que melhora a UX.

A abordagem **assíncrona** desacopla a API do gateway, permite retry resiliente, e melhora throughput. Mas o cliente precisa implementar polling ou webhooks para saber o resultado — o que aumenta a complexidade do lado do cliente e dificulta o checkout síncrono que usuários esperam.

Gateways como Stripe têm uma terceira categoria: pagamentos que são autorizados sincronamente mas capturados de forma assíncrona — ou que requerem ação adicional do usuário (3DS) antes de completar.

---

## Decisão

Adotaremos uma **abordagem híbrida orientada ao tipo de pagamento**:

### Fase 1 — Resposta síncrona ao cliente (sempre)

A API sempre retorna uma resposta imediata ao cliente. O que varia é o que essa resposta contém:

```
POST /payments → 201 Created
{
  "id": "pay_123",
  "status": "PROCESSING",   ← não é o resultado final, é o estado atual
  "amount": 10000,
  "currency": "BRL",
  "poll_url": "/payments/pay_123"
}
```

O cliente recebe confirmação de que o pagamento foi aceito e está sendo processado. Para UX de checkout, isso é suficiente para avançar para a tela de "aguardando confirmação".

### Fase 2 — Processamento assíncrono pelo worker

O `CreatePaymentUseCase` salva o payment como `PENDING` e publica um evento via Outbox (ADR-009). O `PaymentWorker` consome o evento, chama o gateway, e transiciona o status.

### Fase 3 — Notificação do resultado

O resultado chega ao cliente por dois caminhos:

1. **Polling:** `GET /payments/{id}` retorna o status atual (simples, sem infraestrutura adicional)
2. **Webhook de saída:** quando o status muda, o sistema notifica a URL registrada pelo merchant

### Exceção — pagamentos com resposta imediata do gateway

Para gateways que respondem em < 500ms de forma confiável (ex: cartão de débito com aprovação instantânea no Asaas), o worker conclui rapidamente e o cliente pode receber o resultado via webhook de saída antes mesmo de fazer o primeiro poll.

**Importante:** independente da velocidade do gateway, o worker SEMPRE persiste o resultado via Outbox Pattern (ADR-009) — nunca publica diretamente no BullMQ de dentro de uma transação. A chamada ao gateway é síncrona dentro do worker, mas o evento de resultado (`payment.captured`, `payment.failed`) é publicado atomicamente junto com a atualização do status no banco.

### Diagrama do fluxo

```
Cliente                    API                    Worker              Gateway
  │                          │                       │                   │
  ├──POST /payments──────────►│                       │                   │
  │                          ├─salva PENDING──────────►│                  │
  │                          ├─publica OutboxEvent────►│                  │
  │◄──201 {status:PROCESSING}─┤                       │                  │
  │                          │                       ├──chama gateway────►│
  │                          │                       │◄──resposta─────────┤
  │                          │                       ├─transiciona status  │
  │                          │                       ├─publica evento      │
  │                          │                       │                   │
  ├──GET /payments/{id}───────►│                      │                   │
  │◄──{status:CAPTURED}───────┤                       │                   │
```

---

## Alternativas consideradas

### Alternativa 1: Totalmente síncrono (API aguarda gateway)

O `POST /payments` chama o gateway diretamente, aguarda a resposta, e retorna o resultado final.

**Prós:** UX mais simples — o cliente sabe imediatamente se foi aprovado. Sem necessidade de polling ou webhooks de saída.
**Contras:** latência do gateway (200ms–5s) impacta todos os requests. Gateway lento = API lenta. Gateway fora = 100% de falhas no endpoint. Sem possibilidade de retry transparente. Timeout do HTTP pode fazer o cliente receber erro mesmo que o gateway tenha aprovado.
**Por que descartada:** o "timeout com aprovação" é o pior cenário: o cliente recebe erro, tenta de novo, e o pagamento é cobrado duas vezes (a idempotência mitiga, mas não elimina a confusão). O desacoplamento via worker é mais robusto.

### Alternativa 2: Totalmente assíncrono (202 + polling obrigatório)

Sempre retorna 202, sem nenhuma tentativa de resolução rápida.

**Prós:** máximo de resiliência e desacoplamento.
**Contras:** piora a UX do checkout — o comprador fica esperando uma confirmação que pode demorar segundos a minutos. Para pagamentos instantâneos (débito, Pix), esperar o polling é uma experiência ruim.
**Por que descartada:** desnecessariamente degradante para a UX quando o gateway responde rapidamente. O modelo híbrido permite otimizar por tipo de pagamento.

### Alternativa 3: Server-Sent Events (SSE) para resultado em tempo real

A API mantém a conexão aberta via SSE e envia o resultado quando o worker concluir.

**Prós:** UX próxima ao síncrono, sem polling.
**Contras:** conexões SSE mantidas abertas aumentam consumo de recursos do servidor. Infraestrutura adicional para distribuir eventos entre instâncias da API (Redis pub/sub). Complexidade de implementação desproporcionalmente alta para um portfólio v1.
**Por que descartada:** YAGNI. Polling simples é suficiente para demonstrar o conceito. SSE pode ser adicionado como melhoria futura.

---

## Consequências

### Positivas
- A API nunca fica bloqueada aguardando o gateway — throughput independente da latência do gateway.
- Falhas do gateway não causam falha imediata da API — o worker vai tentar novamente.
- O circuit breaker (ADR-008) pode ser aplicado no worker sem impactar a experiência do checkout.
- O Outbox Pattern (ADR-009) garante que nenhum pagamento é perdido mesmo em crash do worker.

### Negativas / Trade-offs
- O cliente precisa implementar polling ou webhook para saber o resultado final.
- Debugging é mais complexo — o fluxo passa por múltiplos processos (API → banco → worker → gateway).
- O dashboard precisa lidar com payments em status transicionais (`PROCESSING`, `PENDING`).

### Riscos e mitigações

- **Risco:** worker fica sobrecarregado e pagamentos acumulam em `PENDING` por minutos.
  **Mitigação:** métrica `payment_processing_lag_seconds` monitorada. Alerta se lag > 30 segundos. Workers podem ser escalados horizontalmente — múltiplas instâncias consomem a mesma fila.

- **Risco:** cliente faz múltiplos polls em loop agressivo, sobrecarregando a API.
  **Mitigação:** rate limiting no endpoint `GET /payments/{id}` por `merchant_id`. Resposta inclui `Retry-After: 2` sugerindo intervalo mínimo entre polls.

- **Risco:** payment fica em `PROCESSING` para sempre (worker crashou após chamar o gateway mas antes de atualizar o status).
  **Mitigação:** job de reconciliação roda a cada 15 minutos e detecta payments em `PROCESSING` por mais de 10 minutos. Consulta o gateway pelo `gateway_payment_id` e reconcilia o status. Runbook: `docs/runbooks/payment-stuck-processing.md`.

---

## Implementação

```typescript
// src/application/payment/CreatePaymentUseCase.ts
// Responsabilidade: salvar o payment e publicar o evento. NÃO chama o gateway.

export class CreatePaymentUseCase {
  async execute(input: CreatePaymentInput): Promise<Result<PaymentCreatedDTO>> {

    return this.db.transaction(async (trx) => {
      // 1. Cria a entidade de domínio (status inicial: PENDING)
      const payment = Payment.create({
        id:             PaymentId.create(),
        amount:         Cents.of(input.amountCents),
        currency:       input.currency,
        sellerId:       SellerId.of(input.sellerId),
        idempotencyKey: IdempotencyKey.of(input.idempotencyKey),
        metadata:       input.metadata,
      })
      if (!payment.ok) return payment

      // 2. Persiste payment e OutboxEvent na MESMA transação (ADR-009)
      await this.paymentRepo.save(payment.value, trx)
      await this.outboxRepo.save(
        OutboxEvent.create({
          eventType:     'payment.created',
          aggregateId:   payment.value.id,
          aggregateType: 'Payment',
          payload: {
            paymentId:     payment.value.id,
            amountCents:   input.amountCents,
            currency:      input.currency,
            sellerId:      input.sellerId,
            gatewayConfig: input.gatewayConfig,
          },
        }),
        trx
      )

      // 3. Retorna DTO com status PROCESSING — não o resultado final
      return ok({
        id:       payment.value.id,
        status:   'PROCESSING' as const,
        amount:   input.amountCents,
        currency: input.currency,
        pollUrl:  `/payments/${payment.value.id}`,
      })
    })
  }
}
```

```typescript
// src/infrastructure/queue/workers/PaymentWorker.ts
// Responsabilidade: chamar o gateway DIRETAMENTE e publicar o resultado via Outbox.
//
// Regra crítica (ADR-009): o worker chama o gateway de forma síncrona,
// mas o evento de resultado SEMPRE é publicado via Outbox — nunca via
// this.queue.add() diretamente. Isso garante atomicidade entre a atualização
// do status e a publicação do evento.

export class PaymentWorker {
  async process(job: Job<PaymentCreatedPayload>): Promise<void> {
    const { paymentId, amountCents, gatewayConfig } = job.data

    // 1. Chama o gateway DIRETAMENTE (síncrono, com circuit breaker — ADR-008)
    //    O Outbox não é usado para chamar o gateway — apenas para publicar o resultado.
    const gatewayResult = await this.gatewayAdapter.charge({
      amount:   Cents.of(amountCents),
      metadata: gatewayConfig,
    })

    // 2. Atualiza status + publica OutboxEvent na MESMA transação (ADR-009)
    //    NUNCA chamar this.queue.add() aqui — seria dual-write.
    await this.db.transaction(async (trx) => {
      const payment = await this.paymentRepo.findByIdForUpdate(PaymentId.of(paymentId), trx)
      if (!payment) throw new Error(`Payment not found: ${paymentId}`)

      const newStatus = gatewayResult.ok ? 'AUTHORIZED' : 'FAILED'
      const transition = payment.transition(newStatus, {
        gatewayPaymentId: gatewayResult.ok ? gatewayResult.value.id : undefined,
        failureReason:    gatewayResult.ok ? undefined : gatewayResult.error.message,
      })
      if (!transition.ok) throw new Error(transition.error.message)

      await this.paymentRepo.save(payment, trx)

      // OutboxEvent com o resultado — entregue ao LedgerWorker pelo OutboxRelay
      // Atômico com o UPDATE do payment: ou ambos commitam, ou nenhum.
      await this.outboxRepo.save(
        OutboxEvent.create({
          eventType:     gatewayResult.ok ? 'payment.authorized' : 'payment.failed',
          aggregateId:   paymentId,
          aggregateType: 'Payment',
          payload: {
            paymentId,
            newStatus,
            gatewayPaymentId: gatewayResult.ok ? gatewayResult.value.id : undefined,
          },
        }),
        trx  // mesma transação — obrigatório
      )
    })
  }
}
```

**Arquivos:**
- `src/application/payment/CreatePaymentUseCase.ts`
- `src/infrastructure/queue/workers/PaymentWorker.ts`
- `src/web/controllers/PaymentController.ts`
