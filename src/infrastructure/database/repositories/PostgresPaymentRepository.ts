import type { Knex } from 'knex'
import type { IPaymentRepository } from '../../../domain/payment/IPaymentRepository'
import { Payment, type ReconstitutePaymentInput } from '../../../domain/payment/Payment'
import type { PaymentStatus } from '../../../domain/payment/value-objects/PaymentStatus'
import { Cents, PaymentId, SellerId, IdempotencyKey } from '../../../domain/shared/types'

/**
 * Linha do banco para SELECT — node-postgres retorna BIGINT como string.
 * Os campos de status são tipados com a union do domínio: o CHECK constraint
 * no banco garante que apenas valores válidos chegam aqui.
 */
interface PaymentRow {
  id:                  string
  seller_id:           string
  amount_cents:        string   // BIGINT → node-postgres retorna string
  idempotency_key:     string
  status:              PaymentStatus
  created_at:          Date
  updated_at:          Date
  gateway:             string | null
  gateway_payment_id:  string | null
  gateway_response:    Record<string, unknown> | null
  metadata:            Record<string, unknown> | null
  error_code:          string | null
  error_message:       string | null
  authorized_at:       Date | null
  captured_at:         Date | null
  refunded_at:         Date | null
  failed_at:           Date | null
}

function rowToInput(row: PaymentRow): ReconstitutePaymentInput {
  return {
    id:             PaymentId.of(row.id),
    sellerId:       SellerId.of(row.seller_id),
    amount:         Cents.of(Number(row.amount_cents)),
    idempotencyKey: IdempotencyKey.of(row.idempotency_key),
    status:         row.status,
    createdAt:      row.created_at,
    updatedAt:      row.updated_at,
    ...(row.gateway !== null            && { gateway:          row.gateway }),
    ...(row.gateway_payment_id !== null && { gatewayPaymentId: row.gateway_payment_id }),
    ...(row.gateway_response !== null   && { gatewayResponse:  row.gateway_response }),
    ...(row.metadata !== null           && { metadata:         row.metadata }),
    ...(row.error_code !== null         && { errorCode:        row.error_code }),
    ...(row.error_message !== null      && { errorMessage:     row.error_message }),
    ...(row.authorized_at !== null      && { authorizedAt:     row.authorized_at }),
    ...(row.captured_at !== null        && { capturedAt:       row.captured_at }),
    ...(row.refunded_at !== null        && { refundedAt:       row.refunded_at }),
    ...(row.failed_at !== null          && { failedAt:         row.failed_at }),
  }
}

/**
 * Implementação PostgreSQL do IPaymentRepository.
 *
 * O construtor recebe `Knex` — aceita tanto a instância global (`db`)
 * quanto uma `Knex.Transaction` (que extends Knex), permitindo uso
 * dentro do KnexUnitOfWork sem alteração de interface.
 *
 * Nunca referencia `trx` diretamente — IUnitOfWork Option B (ADR-009).
 */
export class PostgresPaymentRepository implements IPaymentRepository {
  constructor(private readonly db: Knex) {}

  async save(payment: Payment): Promise<void> {
    await this.db('payments').insert({
      id:              payment.id,
      seller_id:       payment.sellerId,
      amount_cents:    payment.amount,
      idempotency_key: payment.idempotencyKey,
      status:          payment.status,
      created_at:      payment.createdAt,
      updated_at:      payment.updatedAt,
      ...(payment.gateway !== undefined          && { gateway:            payment.gateway }),
      ...(payment.gatewayPaymentId !== undefined && { gateway_payment_id: payment.gatewayPaymentId }),
      ...(payment.gatewayResponse !== undefined  && { gateway_response:   payment.gatewayResponse }),
      ...(payment.metadata !== undefined         && { metadata:           payment.metadata }),
      ...(payment.errorCode !== undefined        && { error_code:         payment.errorCode }),
      ...(payment.errorMessage !== undefined     && { error_message:      payment.errorMessage }),
      ...(payment.authorizedAt !== undefined     && { authorized_at:      payment.authorizedAt }),
      ...(payment.capturedAt !== undefined       && { captured_at:        payment.capturedAt }),
      ...(payment.refundedAt !== undefined       && { refunded_at:        payment.refundedAt }),
      ...(payment.failedAt !== undefined         && { failed_at:          payment.failedAt }),
    })
  }

  async update(payment: Payment): Promise<void> {
    await this.db('payments').where({ id: payment.id }).update({
      status:     payment.status,
      updated_at: payment.updatedAt,
      ...(payment.gateway !== undefined          && { gateway:            payment.gateway }),
      ...(payment.gatewayPaymentId !== undefined && { gateway_payment_id: payment.gatewayPaymentId }),
      ...(payment.gatewayResponse !== undefined  && { gateway_response:   payment.gatewayResponse }),
      ...(payment.errorCode !== undefined        && { error_code:         payment.errorCode }),
      ...(payment.errorMessage !== undefined     && { error_message:      payment.errorMessage }),
      ...(payment.authorizedAt !== undefined     && { authorized_at:      payment.authorizedAt }),
      ...(payment.capturedAt !== undefined       && { captured_at:        payment.capturedAt }),
      ...(payment.refundedAt !== undefined       && { refunded_at:        payment.refundedAt }),
      ...(payment.failedAt !== undefined         && { failed_at:          payment.failedAt }),
    })
  }

  async findById(id: PaymentId): Promise<Payment | null> {
    const row = await this.db<PaymentRow>('payments').where({ id }).first()
    return row ? Payment.reconstitute(rowToInput(row)) : null
  }

  async findByIdForUpdate(id: PaymentId): Promise<Payment | null> {
    const row = await this.db<PaymentRow>('payments').where({ id }).forUpdate().first()
    return row ? Payment.reconstitute(rowToInput(row)) : null
  }

  async findByIdempotencyKey(key: IdempotencyKey): Promise<Payment | null> {
    const row = await this.db<PaymentRow>('payments').where({ idempotency_key: key }).first()
    return row ? Payment.reconstitute(rowToInput(row)) : null
  }

  async findBySellerAndStatus(sellerId: SellerId, status: PaymentStatus): Promise<Payment[]> {
    const rows = await this.db<PaymentRow>('payments').where({ seller_id: sellerId, status })
    return rows.map(row => Payment.reconstitute(rowToInput(row)))
  }

  async findStuckInProcessing(olderThan: Date): Promise<Payment[]> {
    const rows = await this.db<PaymentRow>('payments')
      .where({ status: 'PROCESSING' })
      .where('updated_at', '<', olderThan)
    return rows.map(row => Payment.reconstitute(rowToInput(row)))
  }
}
