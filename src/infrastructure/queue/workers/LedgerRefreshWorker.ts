import type { Logger } from 'pino'

export interface LedgerRefreshWorkerOptions {
  readonly ledgerQueryRepo: { refreshView(): Promise<void> }
  readonly logger:          Logger
}

/**
 * Worker que mantém a MATERIALIZED VIEW `ledger_summary` atualizada (ADR-007).
 *
 * Chamado em dois momentos:
 *   1. Após o LedgerWorker processar PAYMENT_CAPTURED ou PAYMENT_REFUNDED
 *      (via OutboxRelay → fila dedicada ou chamada direta)
 *   2. Como fallback via BullMQ repeatable job a cada 5 minutos —
 *      garante que a view não fique desatualizada mesmo em caso de
 *      falha no disparo por evento
 *
 * Falhas no refresh são toleradas: os dados ficam levemente desatualizados
 * até o próximo ciclo. O worker loga o erro mas não propaga a exceção —
 * um refresh falho não deve derrubar o processamento de pagamentos.
 *
 * REFRESH CONCURRENTLY evita lock exclusivo, permitindo leituras simultâneas
 * durante o refresh (ADR-007).
 */
export class LedgerRefreshWorker {
  constructor(private readonly opts: LedgerRefreshWorkerOptions) {}

  async refresh(): Promise<void> {
    try {
      await this.opts.ledgerQueryRepo.refreshView()
      this.opts.logger.info(
        { service: 'LedgerRefreshWorker' },
        'Materialized view ledger_summary refreshed',
      )
    } catch (error) {
      this.opts.logger.error(
        { service: 'LedgerRefreshWorker', error },
        'Failed to refresh ledger_summary view — will retry on next trigger',
      )
    }
  }
}
