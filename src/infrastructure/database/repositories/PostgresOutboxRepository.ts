import type { Knex } from 'knex'
import type { IOutboxRepository } from '../../../domain/outbox/IOutboxRepository'
import { OutboxEvent } from '../../../domain/outbox/OutboxEvent'

/**
 * Linha do banco — retry_count é INT (não BIGINT), pg retorna como number.
 * payload é JSONB, pg deserializa automaticamente para Record<string, unknown>.
 */
interface OutboxEventRow {
  id:             string
  event_type:     string
  aggregate_type: string
  aggregate_id:   string
  payload:        Record<string, unknown>
  processed:      boolean
  retry_count:    number   // INT → node-postgres retorna number (não string)
  error:          string | null
  created_at:     Date
  processed_at:   Date | null
}

function rowToEvent(row: OutboxEventRow): OutboxEvent {
  return OutboxEvent.reconstitute({
    id:            row.id,
    eventType:     row.event_type,
    aggregateId:   row.aggregate_id,
    aggregateType: row.aggregate_type,
    payload:       row.payload,
    processed:     row.processed,
    retryCount:    row.retry_count,
    createdAt:     row.created_at,
    ...(row.processed_at !== null && { processedAt: row.processed_at }),
    ...(row.error !== null        && { error:       row.error }),
  })
}

/**
 * Implementação PostgreSQL do IOutboxRepository (ADR-009).
 *
 * Dois perfis de uso:
 * 1. Use cases via IUnitOfWork — save() na mesma transação que muda o estado.
 * 2. OutboxRelay — findUnprocessedBatch() com SELECT FOR UPDATE SKIP LOCKED
 *    garante que múltiplas instâncias do relay não processem o mesmo evento.
 *
 * O construtor recebe Knex — aceita db global ou Knex.Transaction,
 * permitindo ambos os contextos sem alterar a interface.
 */
export class PostgresOutboxRepository implements IOutboxRepository {
  constructor(private readonly db: Knex) {}

  async save(event: OutboxEvent): Promise<void> {
    await this.db('outbox_events').insert({
      id:             event.id,
      event_type:     event.eventType,
      aggregate_type: event.aggregateType,
      aggregate_id:   event.aggregateId,
      payload:        event.payload,
      processed:      event.processed,
      retry_count:    event.retryCount,
      created_at:     event.createdAt,
      ...(event.processedAt !== undefined && { processed_at: event.processedAt }),
      ...(event.error !== undefined       && { error:        event.error }),
    })
  }

  async findUnprocessedBatch(limit: number): Promise<OutboxEvent[]> {
    const rows = await this.db<OutboxEventRow>('outbox_events')
      .where({ processed: false })
      .orderBy('created_at', 'asc')
      .limit(limit)
      .forUpdate()
      .skipLocked()
    return rows.map(rowToEvent)
  }

  async markProcessed(id: string, processedAt: Date): Promise<void> {
    await this.db('outbox_events').where({ id }).update({
      processed:    true,
      processed_at: processedAt,
    })
  }

  async recordFailure(id: string, error: string): Promise<void> {
    await this.db('outbox_events').where({ id }).update({ error })
    await this.db('outbox_events').where({ id }).increment('retry_count', 1)
  }
}
