import type { Logger } from 'pino'

/**
 * Dependências do GracefulShutdown usando structural typing para testabilidade.
 * Compatíveis com http.Server, BullMQ Worker, Knex e ioredis sem importá-los.
 */
export interface ShutdownDeps {
  /** Servidor HTTP — `http.Server` ou compatível. */
  readonly server:  { close(cb?: (err?: Error) => void): void }
  /** Workers BullMQ — `Worker.close()` aguarda jobs em andamento. */
  readonly workers: ReadonlyArray<{ close(): Promise<void> }>
  /** OutboxRelay — `stop()` sinaliza parada após o ciclo atual. */
  readonly relay:   { stop(): void }
  /** Knex connection pool — `destroy()` fecha todas as conexões. */
  readonly db:      { destroy(): Promise<void> }
  /** ioredis — `quit()` envia QUIT e fecha a conexão. */
  readonly redis:   { quit(): Promise<unknown> }
  readonly logger:  Logger
  /**
   * Timeout total do shutdown em ms. Padrão: 90s.
   * O docker-compose tem `stop_grace_period: 120s` para cobrir este valor (ADR-013).
   */
  readonly timeout?: number
}

/**
 * Implementa o protocolo de encerramento controlado do sistema (ADR-013).
 *
 * Sequência ao receber SIGTERM ou SIGINT:
 *   1. Fecha servidor HTTP — para de aceitar novos requests (timeout: 30s coberto pelo total)
 *   2. Para o OutboxRelay — ciclo atual é concluído antes de parar
 *   3. Drena workers BullMQ — jobs em andamento terminam naturalmente (timeout: 60s)
 *   4. Fecha conexões PostgreSQL e Redis
 *   5. process.exit(0)
 *
 * Se qualquer etapa falhar ou o timeout total (90s) for atingido: process.exit(1).
 * O BullMQ re-encaminha jobs interrompidos via stall detection (ADR-013).
 *
 * `shutdown()` é público para facilitar testes unitários e chamada direta.
 */
export class GracefulShutdown {
  private isShuttingDown = false
  private readonly totalTimeout: number

  constructor(private readonly deps: ShutdownDeps) {
    this.totalTimeout = deps.timeout ?? 90_000
  }

  /**
   * Registra os handlers de sinal no process.
   * Chamado uma única vez no bootstrap da aplicação.
   */
  register(): void {
    process.on('SIGTERM', () => { void this.shutdown('SIGTERM') })
    process.on('SIGINT',  () => { void this.shutdown('SIGINT') })
  }

  /**
   * Executa o protocolo de encerramento.
   * Exposto como `public` para permitir invocação direta em testes.
   */
  async shutdown(signal: string): Promise<void> {
    if (this.isShuttingDown) return
    this.isShuttingDown = true

    this.deps.logger.info({ service: 'GracefulShutdown', signal }, 'Shutdown signal received — starting graceful shutdown')

    // Timer de segurança: força saída após timeout máximo (ADR-013)
    const forceExit = setTimeout(() => {
      this.deps.logger.error(
        { service: 'GracefulShutdown', timeoutMs: this.totalTimeout },
        'Graceful shutdown timeout exceeded — forcing exit',
      )
      process.exit(1)
    }, this.totalTimeout)
    forceExit.unref()  // não mantém o event loop vivo

    try {
      // ── 1. Para de aceitar novos requests HTTP ───────────────────────────

      this.deps.logger.info({ service: 'GracefulShutdown' }, 'Closing HTTP server...')
      await new Promise<void>((resolve, reject) => {
        this.deps.server.close((err) => {
          if (err !== undefined) reject(err)
          else resolve()
        })
      })
      this.deps.logger.info({ service: 'GracefulShutdown' }, 'HTTP server closed')

      // ── 2. Para o OutboxRelay ────────────────────────────────────────────

      this.deps.logger.info({ service: 'GracefulShutdown' }, 'Stopping OutboxRelay...')
      this.deps.relay.stop()

      // ── 3. Drena workers BullMQ ──────────────────────────────────────────

      this.deps.logger.info(
        { service: 'GracefulShutdown', count: this.deps.workers.length },
        'Draining workers...',
      )
      await Promise.all(this.deps.workers.map((w) => w.close()))
      this.deps.logger.info({ service: 'GracefulShutdown' }, 'All workers drained')

      // ── 4. Fecha conexões com PostgreSQL e Redis ─────────────────────────

      this.deps.logger.info({ service: 'GracefulShutdown' }, 'Closing database connections...')
      await this.deps.db.destroy()
      await this.deps.redis.quit()

      clearTimeout(forceExit)
      this.deps.logger.info({ service: 'GracefulShutdown' }, 'Graceful shutdown completed')
      process.exit(0)

    } catch (error) {
      clearTimeout(forceExit)
      this.deps.logger.error({ service: 'GracefulShutdown', error }, 'Error during graceful shutdown')
      process.exit(1)
    }
  }
}
