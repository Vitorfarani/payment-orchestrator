import type { PaymentId, SellerId, IdempotencyKey } from '../shared/types'
import type { Payment } from './Payment'
import type { PaymentStatus } from './value-objects/PaymentStatus'

/**
 * Contrato do repositório de pagamentos.
 *
 * Definido no domínio — sem qualquer referência a Knex ou infraestrutura.
 * A implementação concreta fica em infrastructure/database/repositories/.
 *
 * Com IUnitOfWork (Option B), os métodos não recebem `trx` diretamente —
 * o repositório é construído já escoped à transação ativa.
 */
export interface IPaymentRepository {
  /** Persiste um novo pagamento (INSERT). */
  save(payment: Payment): Promise<void>

  /** Atualiza estado, timestamps e gateway info de um pagamento existente (UPDATE). */
  update(payment: Payment): Promise<void>

  findById(id: PaymentId): Promise<Payment | null>

  /**
   * Busca o pagamento com lock exclusivo (SELECT FOR UPDATE).
   *
   * Deve ser chamado dentro de um IUnitOfWork para garantir exclusividade
   * durante transições de estado concorrentes:
   * - PaymentWorker: atualiza status após resposta do gateway
   * - ProcessWebhookUseCase: transiciona estado a partir de webhook
   * - RefundPaymentUseCase: evita duplo estorno paralelo
   *
   * Retorna null se o pagamento não existir.
   */
  findByIdForUpdate(id: PaymentId): Promise<Payment | null>

  /** Usado pelo IdempotencyMiddleware para retornar resposta já processada. */
  findByIdempotencyKey(key: IdempotencyKey): Promise<Payment | null>

  /** Usado por queries operacionais e pelo SettlementWorker. */
  findBySellerAndStatus(sellerId: SellerId, status: PaymentStatus): Promise<Payment[]>

  /**
   * Busca pagamentos presos em PROCESSING há mais de `olderThan` tempo.
   * Usado pelo PaymentReconciliationWorker (ADR-003).
   *
   * Em produção retorna pagamentos com `status = 'PROCESSING' AND updated_at < olderThan`.
   * Um pagamento neste estado por mais de 10 minutos indica falha não recuperada pelo worker.
   */
  findStuckInProcessing(olderThan: Date): Promise<Payment[]>
}
