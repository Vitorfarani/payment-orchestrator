import type { OutboxEvent } from './OutboxEvent'

/**
 * Contrato do repositório do Outbox Pattern (ADR-009).
 *
 * Definido no domínio — sem qualquer referência a Knex ou BullMQ.
 *
 * Dois contextos de uso, ambos suportados por esta interface:
 *
 * 1. Use cases (via IUnitOfWork):
 *    `save()` dentro da mesma transação que persiste a mudança de estado.
 *    Garante atomicidade: banco commita ↔ evento existe.
 *
 * 2. OutboxRelay (infraestrutura):
 *    `findUnprocessedBatch()`, `markProcessed()`, `recordFailure()`
 *    para o ciclo de polling e publicação no BullMQ.
 *    A implementação PostgreSQL usa SELECT FOR UPDATE SKIP LOCKED.
 */
export interface IOutboxRepository {
  /**
   * Persiste o evento dentro da transação ativa (via IUnitOfWork).
   *
   * OBRIGATÓRIO: sempre chamado na mesma transação que persiste
   * a mudança de estado (Payment, SettlementItem, etc.).
   * Nunca chamar fora de uma transação — violação do ADR-009.
   */
  save(event: OutboxEvent): Promise<void>

  /**
   * Busca até `limit` eventos não processados em ordem de criação.
   *
   * Usado exclusivamente pelo OutboxRelay.
   * A implementação PostgreSQL usa SELECT FOR UPDATE SKIP LOCKED
   * para garantir que múltiplas instâncias do relay não processem
   * o mesmo evento simultaneamente.
   */
  findUnprocessedBatch(limit: number): Promise<OutboxEvent[]>

  /**
   * Marca o evento como processado após publicação bem-sucedida no BullMQ.
   *
   * O BullMQ recebe `jobId = event.id`, garantindo idempotência na fila:
   * se o relay publicar o mesmo evento duas vezes, o segundo é ignorado.
   */
  markProcessed(id: string, processedAt: Date): Promise<void>

  /**
   * Registra falha no processamento e incrementa retry_count.
   *
   * NÃO marca como processed — o relay tentará novamente no próximo ciclo.
   * Após muitos erros, o operador pode inspecionar via retry_count alto.
   */
  recordFailure(id: string, error: string): Promise<void>
}
