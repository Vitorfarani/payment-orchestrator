import { z } from 'zod'
import type { Request, Response, NextFunction } from 'express'
import type { CreatePaymentUseCase } from '../../application/payment/CreatePaymentUseCase'
import type { GetPaymentUseCase } from '../../application/payment/GetPaymentUseCase'
import type { RefundPaymentUseCase } from '../../application/payment/RefundPaymentUseCase'
import { SellerId, Cents, IdempotencyKey, PaymentId } from '../../domain/shared/types'
import {
  CreatePaymentBodySchema,
  RefundPaymentBodySchema,
  toPaymentDto,
} from '../dtos/payment.dto'

// Interfaces estruturais para evitar importação direta de infraestrutura (ADR clean architecture)

interface IAuditLogEntry {
  actorId:       string
  actorType:     'user' | 'merchant' | 'system' | 'worker'
  actorIp:       string | null
  action:        string
  resourceType:  string
  resourceId:    string
  requestId:     string | null
  traceId:       string | null
  previousState: Record<string, unknown> | null
  newState:      Record<string, unknown> | null
  metadata:      Record<string, unknown> | null
}

interface IAuditLogRepository {
  save(entry: IAuditLogEntry): Promise<void>
}

interface IMasker {
  mask(data: Record<string, unknown>): Record<string, unknown>
}

export interface PaymentControllerDeps {
  createPaymentUseCase: CreatePaymentUseCase
  getPaymentUseCase:    GetPaymentUseCase
  refundPaymentUseCase: RefundPaymentUseCase
  auditLogRepo:         IAuditLogRepository
  masker:               IMasker
}

const ParamIdSchema = z.string().uuid({ message: 'Payment ID must be a valid UUID' })

export class PaymentController {
  constructor(private readonly deps: PaymentControllerDeps) {}

  // -------------------------------------------------------------------------
  // POST /payments
  // -------------------------------------------------------------------------
  create = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Guard explícito — x-idempotency-key é obrigatório nesta rota
    const rawKey = req.headers['x-idempotency-key']
    if (rawKey === undefined || typeof rawKey !== 'string' || rawKey === '') {
      res.status(400).json({
        error: 'x-idempotency-key header is required',
        code:  'IDEMPOTENCY_KEY_MISSING',
      })
      return
    }

    const parse = CreatePaymentBodySchema.safeParse(req.body)
    if (!parse.success) {
      res.status(422).json({
        error:   'Invalid request body',
        code:    'VALIDATION_ERROR',
        details: parse.error.issues,
      })
      return
    }

    const { sellerId, amountCents, metadata } = parse.data

    const result = await this.deps.createPaymentUseCase.execute({
      sellerId:       SellerId.of(sellerId),
      amountCents:    Cents.of(amountCents),
      idempotencyKey: IdempotencyKey.of(rawKey),
      ...(metadata !== undefined && { metadata }),
    })

    if (!result.ok) {
      next(result.error)
      return
    }

    const { paymentId } = result.value

    const merchantId = typeof res.locals['merchantId'] === 'string' ? res.locals['merchantId'] : ''
    const requestId  = typeof res.locals['requestId']  === 'string' ? res.locals['requestId']  : null
    const traceId    = typeof res.locals['traceId']    === 'string' ? res.locals['traceId']    : null

    await this.deps.auditLogRepo.save({
      actorId:       merchantId,
      actorType:     'merchant',
      actorIp:       req.ip ?? null,
      action:        'payment.created',
      resourceType:  'Payment',
      resourceId:    paymentId,
      requestId,
      traceId,
      previousState: null,
      newState:      null,
      metadata:      null,
    })

    res.status(201).json({
      id:      paymentId,
      status:  'PROCESSING',
      pollUrl: `/payments/${paymentId}`,
    })
  }

  // -------------------------------------------------------------------------
  // GET /payments/:id
  // -------------------------------------------------------------------------
  getById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const idParse = ParamIdSchema.safeParse(req.params['id'])
    if (!idParse.success) {
      res.status(422).json({ error: 'Invalid payment ID format', code: 'VALIDATION_ERROR' })
      return
    }

    const result = await this.deps.getPaymentUseCase.execute({
      paymentId: PaymentId.of(idParse.data),
    })

    if (!result.ok) {
      next(result.error)
      return
    }

    if (result.value.status === 'PROCESSING' || result.value.status === 'PENDING') {
      res.set('Retry-After', '2')
    }

    res.status(200).json(toPaymentDto(result.value))
  }

  // -------------------------------------------------------------------------
  // POST /payments/:id/refund
  // -------------------------------------------------------------------------
  refund = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Guard explícito — x-idempotency-key é obrigatório nesta rota
    const rawKey = req.headers['x-idempotency-key']
    if (rawKey === undefined || typeof rawKey !== 'string' || rawKey === '') {
      res.status(400).json({
        error: 'x-idempotency-key header is required',
        code:  'IDEMPOTENCY_KEY_MISSING',
      })
      return
    }

    const idParse = ParamIdSchema.safeParse(req.params['id'])
    if (!idParse.success) {
      res.status(422).json({ error: 'Invalid payment ID format', code: 'VALIDATION_ERROR' })
      return
    }

    const parse = RefundPaymentBodySchema.safeParse(req.body)
    if (!parse.success) {
      res.status(422).json({
        error:   'Invalid request body',
        code:    'VALIDATION_ERROR',
        details: parse.error.issues,
      })
      return
    }

    const refundAmountCents = parse.data.amountCents !== undefined
      ? Cents.of(parse.data.amountCents)
      : undefined

    const result = await this.deps.refundPaymentUseCase.execute({
      paymentId: PaymentId.of(idParse.data),
      ...(refundAmountCents !== undefined && { refundAmountCents }),
    })

    if (!result.ok) {
      next(result.error)
      return
    }

    const { paymentId, refundAmountCents: refundAmt, platformRefund, sellerRefund } = result.value

    const merchantId = typeof res.locals['merchantId'] === 'string' ? res.locals['merchantId'] : ''
    const requestId  = typeof res.locals['requestId']  === 'string' ? res.locals['requestId']  : null
    const traceId    = typeof res.locals['traceId']    === 'string' ? res.locals['traceId']    : null

    await this.deps.auditLogRepo.save({
      actorId:       merchantId,
      actorType:     'merchant',
      actorIp:       req.ip ?? null,
      action:        'payment.refunded',
      resourceType:  'Payment',
      resourceId:    paymentId,
      requestId,
      traceId,
      previousState: null,
      newState:      this.deps.masker.mask({ refundAmountCents: refundAmt, platformRefund, sellerRefund }),
      metadata:      null,
    })

    res.status(200).json({
      paymentId,
      refundAmountCents: refundAmt,
      platformRefund,
      sellerRefund,
    })
  }
}
