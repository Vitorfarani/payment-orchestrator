/**
 * Ações auditáveis do sistema (ADR-018).
 *
 * Toda ação sensível que afeta dados financeiros, configurações críticas
 * ou acesso a dados pessoais deve gerar um registro em audit_logs.
 *
 * Referência: ADR-018 — Audit Log — estrutura, imutabilidade e retenção.
 */
export type AuditAction =
  // Pagamentos
  | 'payment.created'
  | 'payment.captured'
  | 'payment.cancelled'
  | 'payment.refunded'
  | 'payment.disputed'

  // Configuração financeira (alto risco — impacto financeiro direto)
  | 'split_rule.created'
  | 'split_rule.updated'
  | 'split_rule.deleted'

  // Vendedores
  | 'seller.created'
  | 'seller.bank_account_updated'
  | 'seller.suspended'
  | 'seller.settlement_schedule_changed'

  // Administração (ações manuais via runbooks)
  | 'admin.payment_status_forced'
  | 'admin.ledger_entry_reversed'
  | 'admin.job_reprocessed'

  // Acesso a dados sensíveis
  | 'seller.pii_accessed'
  | 'payment.full_details_accessed'

/**
 * Input para inserir um registro de auditoria.
 *
 * `id` e `occurredAt` são gerados pelo PostgresAuditLogRepository —
 * o chamador não precisa (nem deve) fornecê-los.
 *
 * `previousState` e `newState` devem ter dados sensíveis mascarados
 * pelo SensitiveDataMasker (ADR-019) antes de serem passados aqui.
 */
export interface InsertAuditLogInput {
  actorId:       string
  actorType:     'user' | 'merchant' | 'system' | 'worker'
  actorIp:       string | null
  action:        AuditAction
  resourceType:  string
  resourceId:    string
  requestId:     string | null
  traceId:       string | null
  previousState: Record<string, unknown> | null
  newState:      Record<string, unknown> | null
  metadata:      Record<string, unknown> | null
}
