# ADR-013: Graceful Shutdown — encerramento controlado de workers e servidor HTTP

## Metadados

| Campo | Valor |
|---|---|
| **ID** | ADR-013 |
| **Título** | Graceful Shutdown — encerramento controlado de workers e servidor HTTP |
| **Status** | `accepted` |
| **Data** | 2025-01-01 |
| **Contextos afetados** | Todos (infraestrutura transversal) |
| **Depende de** | ADR-009 (Outbox Pattern), ADR-012 (DLQ Policy) |
| **Bloqueia** | Setup do servidor HTTP, configuração dos workers BullMQ |

---

## Contexto

Em ambientes de produção modernos (Docker, Kubernetes, deploy via CI/CD), processos são encerrados regularmente — para deploy de nova versão, scale-down, restart por falha de healthcheck, ou movimentação entre nós.

O orquestrador de containers envia um sinal `SIGTERM` antes de matar o processo. Sem tratamento desse sinal, o processo Node.js encerra imediatamente — no meio de qualquer operação em andamento.

Para um sistema de pagamentos, isso significa:

- Um job do PaymentWorker interrompido no meio da chamada ao gateway: o gateway pode ter cobrado, mas o status do pagamento nunca foi atualizado.
- Uma transação de banco aberta que nunca commita: locks são liberados, mas o estado fica inconsistente.
- Um job do LedgerWorker interrompido no meio de um double-entry: apenas um dos dois lados foi registrado.
- Requests HTTP em andamento que recebem conexão fechada sem resposta.

Nenhum desses cenários é aceitável. O sistema precisa de um protocolo de encerramento que permita a operações em andamento terminarem antes do processo fechar.

---

## Decisão

Implementaremos Graceful Shutdown em dois níveis: **servidor HTTP** e **workers BullMQ**, com um timeout máximo de segurança.

### Protocolo de encerramento

```
1. Recebe SIGTERM
2. Servidor HTTP para de aceitar NOVOS requests (server.close())
   — requests em andamento continuam sendo processados
3. Workers param de consumir NOVOS jobs da fila
   — jobs em processamento terminam naturalmente
4. Aguarda até [GRACEFUL_SHUTDOWN_TIMEOUT] segundos pelo término de tudo
5. Fecha conexões com PostgreSQL e Redis
6. process.exit(0)

Se o timeout for atingido antes de tudo terminar:
7. Loga warning com o que estava em andamento
8. process.exit(1) — sinaliza saída anormal para o orquestrador
```

### Timeouts configurados

| Componente | Timeout | Justificativa |
|---|---|---|
| HTTP server close | 30 segundos | Requests longos (webhooks, uploads) têm até 30s para terminar |
| Worker drain | 60 segundos | Jobs financeiros não devem ser interrompidos — damos mais tempo |
| Shutdown total | 90 segundos | Kubernetes default é 30s — aumentamos via `terminationGracePeriodSeconds` |
| Conexões DB/Redis | 5 segundos | Após workers terminarem, fechamento rápido é seguro |

### O que garante a segurança dos jobs interrompidos

Mesmo com Graceful Shutdown, existe um cenário de crash inesperado (SIGKILL, OOM kill, falha de hardware). Para esses casos, a segurança vem de outras camadas:

- **BullMQ stalled jobs:** jobs que ficam em `active` por mais tempo que `stalledInterval` são automaticamente re-enfileirados pelo BullMQ. Isso cobre crashes sem SIGTERM.
- **Idempotência dos workers (ADR-009):** reprocessar um job duas vezes é seguro.
- **Outbox Pattern (ADR-009):** transações de banco são atômicas — um crash no meio nunca deixa estado parcial comitado.

---

## Alternativas consideradas

### Alternativa 1: Sem graceful shutdown (encerramento imediato)

Deixar o processo encerrar no recebimento do SIGTERM sem tratamento especial.

**Prós:** sem código adicional.
**Contras:** jobs interrompidos ficam em `active` no BullMQ até o `stalledInterval` (padrão: 30 segundos). Durante esse intervalo, podem ser reprocessados por outro worker — criando duplicata (mitigada pela idempotência, mas não ideal). Requests HTTP recebem RST ao invés de resposta — UX ruim.
**Por que descartada:** para um sistema financeiro que passa por deploys regulares, interrupções de jobs são um evento frequente. Não tratar isso seria acumular dívida técnica de incidentes.

### Alternativa 2: Graceful shutdown apenas para o HTTP (sem workers)

Tratar SIGTERM apenas no servidor HTTP, deixar workers encerrarem imediatamente.

**Prós:** implementação parcial — menos código.
**Contras:** workers são a parte mais crítica do sistema financeiro (é onde o dinheiro é processado). Encerrar um LedgerWorker abruptamente é mais grave que encerrar um request HTTP.
**Por que descartada:** a parte que mais precisa de graceful shutdown é exatamente os workers.

---

## Consequências

### Positivas
- Deploys sem interrupção de jobs em andamento.
- Zero requests HTTP que recebem conexão fechada sem resposta.
- Comportamento previsível e testável.
- Logs claros de início e fim do shutdown — fácil de debugar em produção.

### Negativas / Trade-offs
- Deploys podem demorar até 90 segundos para completar (se houver jobs longos em andamento). Kubernetes precisa ser configurado com `terminationGracePeriodSeconds: 120`.
- O código de shutdown precisa conhecer todos os componentes do sistema — acoplamento necessário mas gerenciado.

### Riscos e mitigações

- **Risco:** job travado impede o shutdown (loop infinito, deadlock com banco).
  **Mitigação:** timeout máximo de 90 segundos. Após o timeout, `process.exit(1)` é chamado mesmo com jobs em andamento. O BullMQ vai re-enfileirar o job via stall detection.

- **Risco:** novo request chega depois do `server.close()` mas antes do processo encerrar.
  **Mitigação:** `server.close()` impede novas conexões TCP. Conexões HTTP keep-alive existentes ainda podem enviar requests — tratadas pelo timeout de 30 segundos.

---

## Implementação

```typescript
// src/infrastructure/shutdown/GracefulShutdown.ts

export class GracefulShutdown {
  private isShuttingDown = false

  constructor(
    private readonly server:  http.Server,
    private readonly workers: Worker[],
    private readonly relay:   OutboxRelay,
    private readonly db:      Knex,
    private readonly redis:   Redis,
    private readonly logger:  Logger,
    private readonly timeout: number = 90_000
  ) {}

  register(): void {
    process.on('SIGTERM', () => this.shutdown('SIGTERM'))
    process.on('SIGINT',  () => this.shutdown('SIGINT'))   // Ctrl+C em dev
  }

  private async shutdown(signal: string): Promise<void> {
    if (this.isShuttingDown) return
    this.isShuttingDown = true

    this.logger.info({ signal }, 'Shutdown signal received — starting graceful shutdown')

    // Timer de segurança: força saída após timeout máximo
    const forceExit = setTimeout(() => {
      this.logger.error('Graceful shutdown timeout exceeded — forcing exit')
      process.exit(1)
    }, this.timeout)
    forceExit.unref() // não mantém o event loop vivo

    try {
      // 1. Para de aceitar novos requests HTTP
      this.logger.info('Closing HTTP server...')
      await new Promise<void>((resolve, reject) => {
        this.server.close((err) => err ? reject(err) : resolve())
      })
      this.logger.info('HTTP server closed')

      // 2. Para o OutboxRelay
      this.logger.info('Stopping OutboxRelay...')
      this.relay.stop()

      // 3. Aguarda workers terminarem jobs em andamento
      this.logger.info(`Draining ${this.workers.length} workers...`)
      await Promise.all(this.workers.map(w => w.close()))
      this.logger.info('All workers drained')

      // 4. Fecha conexões
      this.logger.info('Closing database connections...')
      await this.db.destroy()
      await this.redis.quit()

      clearTimeout(forceExit)
      this.logger.info('Graceful shutdown completed')
      process.exit(0)

    } catch (error) {
      this.logger.error({ error }, 'Error during graceful shutdown')
      process.exit(1)
    }
  }
}
```

```typescript
// src/main.ts — ponto de entrada que registra o shutdown

async function bootstrap() {
  const app    = createExpressApp()
  const server = app.listen(PORT)
  const workers = [
    new PaymentWorker(/* deps */),
    new LedgerWorker(/* deps */),
    new SettlementWorker(/* deps */),
  ]
  const relay = new OutboxRelay(/* deps */)

  const shutdown = new GracefulShutdown(server, workers, relay, db, redis, logger)
  shutdown.register()

  relay.start()  // inicia o polling do Outbox
  logger.info({ port: PORT }, 'Payment Orchestrator started')
}

bootstrap().catch((error) => {
  logger.error({ error }, 'Failed to start application')
  process.exit(1)
})
```

```yaml
# docker-compose.yml — tempo suficiente para graceful shutdown
services:
  api:
    stop_grace_period: 120s   # > nosso timeout de 90s

# kubernetes deployment (referência):
# spec.template.spec.terminationGracePeriodSeconds: 120
```

**Arquivos:**
- `src/infrastructure/shutdown/GracefulShutdown.ts`
- `src/main.ts`
- `docker-compose.yml`
