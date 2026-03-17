import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import type { InsertAuditLogInput } from '../../audit/AuditAction'

/**
 * Repositório INSERT-only para audit_logs (ADR-018).
 *
 * Não implementa uma interface de domínio — audit_logs é preocupação
 * exclusiva da infraestrutura (imutabilidade, retenção, compliance).
 *
 * Não expõe métodos update() ou delete(): a tabela tem REVOKE UPDATE, DELETE
 * na payment_app_role — qualquer tentativa falharia no banco de qualquer forma.
 *
 * `id` e `occurred_at` são gerados internamente para garantir que registros
 * de auditoria só possam ser criados por este repositório, sem dependência
 * de geração externa.
 *
 * Uso: injetado diretamente nos use cases sensíveis via AuditLogger (4.7),
 * que aplica o SensitiveDataMasker (ADR-019) antes de chamar save().
 */
export class PostgresAuditLogRepository {
  constructor(private readonly db: Knex) {}

  async save(entry: InsertAuditLogInput): Promise<void> {
    await this.db('audit_logs').insert({
      id:             randomUUID(),
      occurred_at:    new Date(),
      actor_id:       entry.actorId,
      actor_type:     entry.actorType,
      actor_ip:       entry.actorIp,
      action:         entry.action,
      resource_type:  entry.resourceType,
      resource_id:    entry.resourceId,
      request_id:     entry.requestId,
      trace_id:       entry.traceId,
      previous_state: entry.previousState,
      new_state:      entry.newState,
      metadata:       entry.metadata,
    })
  }
}
