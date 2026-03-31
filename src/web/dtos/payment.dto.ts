import { z } from 'zod'
import type { GetPaymentOutput } from '../../application/payment/GetPaymentUseCase'

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

export const CreatePaymentBodySchema = z.object({
  sellerId:    z.string().uuid({ message: 'sellerId must be a valid UUID' }),
  amountCents: z.number().int().positive({ message: 'amountCents must be a positive integer' }),
  metadata:    z.record(z.unknown()).optional(),
})

export const RefundPaymentBodySchema = z.object({
  amountCents: z.number().int().positive({ message: 'amountCents must be a positive integer' }).optional(),
})

export type CreatePaymentBody = z.infer<typeof CreatePaymentBodySchema>
export type RefundPaymentBody = z.infer<typeof RefundPaymentBodySchema>

// ---------------------------------------------------------------------------
// Response DTOs — HTTP allowlist (ADR-019)
// Only fields that are safe to expose. Never include: gateway, gatewayPaymentId,
// gatewayResponse, errorMessage, metadata.
// ---------------------------------------------------------------------------

export interface PaymentResponseDto {
  id:          string
  status:      string
  amountCents: number
  sellerId:    string
  pollUrl:     string
  createdAt:   string
  updatedAt:   string
  errorCode?:  string
}

export interface CreatePaymentResponseDto {
  id:      string
  status:  'PROCESSING'
  pollUrl: string
}

export interface RefundResponseDto {
  paymentId:         string
  refundAmountCents: number
  platformRefund:    number
  sellerRefund:      number
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Converte GetPaymentOutput em PaymentResponseDto aplicando a allowlist de campos.
 * Garante que campos sensíveis nunca saiam na resposta HTTP (ADR-019).
 */
export function toPaymentDto(output: GetPaymentOutput): PaymentResponseDto {
  const dto: PaymentResponseDto = {
    id:          output.id,
    status:      output.status,
    amountCents: output.amountCents,
    sellerId:    output.sellerId,
    pollUrl:     `/payments/${output.id}`,
    createdAt:   output.createdAt.toISOString(),
    updatedAt:   output.updatedAt.toISOString(),
  }

  if (output.errorCode !== undefined) {
    dto.errorCode = output.errorCode
  }

  return dto
}
