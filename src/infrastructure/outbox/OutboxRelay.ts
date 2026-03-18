import type { Logger } from 'pino'
import type { IOutboxRepository } from '../../domain/outbox/IOutboxRepository'
import type { OutboxEvent } from '../../domain/outbox/OutboxEvent'
import {
  outboxUnprocessedEventsTotal,
  outboxRelayLagSeconds,
} from '../metrics/metrics'

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Interface mínima de fila aceita pelo OutboxRelay.
 *
 * Compatível com BullMQ `Queue.add()` — mas injetável e testável
 * sem instanciar o BullMQ inteiro.
 */
export interface QueueLike {
  add(
    name: string,
    data: Record<string, unknown>,
    opts: { jobId: string },
  ): Promise<unknown>
}

/**
 * Resolve qual fila recebe um determinado tipo de evento.
 * Retorna `undefined` se não houver fila configurada — o relay
 * registra a falha e segue para o próximo evento.
 */
export type QueueResolver = (eventType: string) => QueueLike | undefined

export interface OutboxRelayOptions {
  readonly outboxRepo:        IOutboxRepository
  readonly resolveQueue:      QueueResolver
  readonly logger:            Logger
  /** Intervalo de polling em ms. Padrão: 1000 (ADR-009). */
  readonly pollingIntervalMs?: number
  /** Máximo de eventos por ciclo. Padrão: 100. */
  readonly batchSize?:         number
}

/**
 * Outbox Relay — publica eventos pendentes no BullMQ (ADR-009).
 *
 * Fluxo por ciclo (a cada `pollingIntervalMs`):
 * 1. `findUnprocessedBatch` — SELECT FOR UPDATE SKIP LOCKED (via repo)
 * 2. Para cada evento: publica na fila com `jobId = event.id`
 *    → BullMQ ignora duplicatas com mesmo jobId (idempotência na fila)
 * 3. `markProcessed` após publicação bem-sucedida
 * 4. `recordFailure` em caso de erro — relay retentará no próximo ciclo
 *
 * Entrega: at-least-once. Workers devem ser idempotentes (ADR-009).
 *
 * Integração com GracefulShutdown: chamar `stop()` no handler SIGTERM.
 * O ciclo atual é concluído antes de parar — sem eventos truncados.
 */
export class OutboxRelay {
  private isRunning          = false
  private readonly interval: number
  private readonly batch:    number

  constructor(private readonly opts: OutboxRelayOptions) {
    this.interval = opts.pollingIntervalMs ?? 1_000
    this.batch    = opts.batchSize         ?? 100
  }

  /**
   * Inicia o loop de polling. Resolve apenas quando `stop()` é chamado.
   * Deve ser chamado em background (sem await) — não bloqueia o processo.
   */
  async start(): Promise<void> {
    this.isRunning = true
    this.opts.logger.info({ service: 'OutboxRelay' }, 'OutboxRelay started')

    while (this.isRunning) {
      try {
        await this.processOnce()
      } catch (error) {
        // Falha catastrófica (ex: banco indisponível) — loga e continua o loop
        this.opts.logger.error(
          { service: 'OutboxRelay', error },
          'OutboxRelay cycle failed — will retry',
        )
      }
      if (this.isRunning) {
        await sleep(this.interval)
      }
    }

    this.opts.logger.info({ service: 'OutboxRelay' }, 'OutboxRelay stopped')
  }

  /**
   * Sinaliza o loop para parar após o ciclo atual.
   * Chamado pelo GracefulShutdown no SIGTERM (ADR-013).
   */
  stop(): void {
    this.isRunning = false
  }

  /**
   * Executa um único ciclo de polling.
   *
   * Exposto como `public` para testes unitários e para o GracefulShutdown
   * forçar o flush antes do shutdown.
   */
  async processOnce(): Promise<void> {
    const events = await this.opts.outboxRepo.findUnprocessedBatch(this.batch)

    // Métrica: quantidade de eventos pendentes ao início do ciclo
    outboxUnprocessedEventsTotal.set(events.length)

    for (const event of events) {
      await this.publishEvent(event)
    }
  }

  private async publishEvent(event: OutboxEvent): Promise<void> {
    const queue = this.opts.resolveQueue(event.eventType)

    if (queue === undefined) {
      const msg = `No queue configured for event type: ${event.eventType}`
      this.opts.logger.warn(
        { service: 'OutboxRelay', eventId: event.id, eventType: event.eventType },
        msg,
      )
      await this.opts.outboxRepo.recordFailure(event.id, msg)
      return
    }

    try {
      await queue.add(event.eventType, event.payload, { jobId: event.id })

      const now        = new Date()
      const lagSeconds = (now.getTime() - event.createdAt.getTime()) / 1_000

      await this.opts.outboxRepo.markProcessed(event.id, now)

      // Gauge: lag do último evento publicado com sucesso neste ciclo
      outboxRelayLagSeconds.set(lagSeconds)

      this.opts.logger.debug(
        {
          service:    'OutboxRelay',
          eventId:    event.id,
          eventType:  event.eventType,
          lagSeconds,
        },
        'Outbox event published',
      )
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      await this.opts.outboxRepo.recordFailure(event.id, errorMsg)
      this.opts.logger.error(
        { service: 'OutboxRelay', eventId: event.id, eventType: event.eventType, error },
        'Failed to publish outbox event',
      )
    }
  }
}
