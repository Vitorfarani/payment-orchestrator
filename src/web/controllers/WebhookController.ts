import { createHmac, timingSafeEqual } from 'crypto'
import type { Request, Response, NextFunction } from 'express'
import type { ProcessWebhookUseCase } from '../../application/payment/ProcessWebhookUseCase'
import { PaymentId } from '../../domain/shared/types'
import {
  StripeWebhookBodySchema,
  AsaasWebhookBodySchema,
  stripeEventTypeToPaymentStatus,
  asaasEventToPaymentStatus,
} from '../dtos/webhook.dto'

// Interface estrutural para o logger — evita importar pino diretamente (ADR)
interface ILogger {
  warn(obj: unknown, msg?: string): void
  info?(obj: unknown, msg?: string): void
}

export interface WebhookControllerDeps {
  processWebhookUseCase: ProcessWebhookUseCase
  logger:                ILogger
}

export class WebhookController {
  constructor(private readonly deps: WebhookControllerDeps) {}

  // -------------------------------------------------------------------------
  // Verificação de assinatura Stripe (ADR-002)
  // Tolerância padrão de 300 s contra replay attacks.
  // -------------------------------------------------------------------------
  verifyStripeSignature(
    rawBody:      Buffer,
    header:       string,
    secret:       string,
    toleranceSec: number = 300,
  ): boolean {
    // Parse: t=TIMESTAMP,v1=SIG[,v1=SIG2,...]
    const parts = header.split(',')
    let timestamp: string | undefined
    const signatures: string[] = []

    for (const part of parts) {
      const trimmed = part.trim()
      if (trimmed.startsWith('t=')) {
        timestamp = trimmed.slice(2)
      } else if (trimmed.startsWith('v1=')) {
        signatures.push(trimmed.slice(3))
      }
    }

    if (timestamp === undefined || signatures.length === 0) return false

    const t = parseInt(timestamp, 10)
    if (isNaN(t)) return false

    // Replay protection
    if (Math.abs(Date.now() / 1000 - t) > toleranceSec) return false

    // HMAC-SHA256 do payload
    const payload     = `${timestamp}.${rawBody.toString()}`
    const expectedBuf = createHmac('sha256', secret).update(payload).digest()

    for (const sig of signatures) {
      try {
        const actualBuf = Buffer.from(sig, 'hex')
        if (expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf)) {
          return true
        }
      } catch {
        // hex inválido — continua para próxima assinatura
      }
    }

    return false
  }

  // -------------------------------------------------------------------------
  // POST /webhooks/stripe
  // -------------------------------------------------------------------------
  handleStripe = async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    // express.raw() garante que req.body é sempre Buffer nesta rota
    if (!Buffer.isBuffer(req.body)) {
      res.status(200).json({ received: true })
      return
    }
    const rawBody = req.body
    const header  = req.headers['stripe-signature']
    const secret  = process.env['STRIPE_WEBHOOK_SECRET'] ?? ''

    // Única situação que retorna 401 — assinatura inválida ou replay
    if (typeof header !== 'string' || !this.verifyStripeSignature(rawBody, header, secret)) {
      res.status(401).json({ error: 'Invalid Stripe signature', code: 'WEBHOOK_INVALID_SIGNATURE' })
      return
    }

    // Parse do JSON manualmente (o body é Buffer no express.raw)
    let parsed: unknown
    try {
      parsed = JSON.parse(rawBody.toString())
    } catch {
      res.status(200).json({ received: true })
      return
    }

    const schemaResult = StripeWebhookBodySchema.safeParse(parsed)
    if (!schemaResult.success) {
      res.status(200).json({ received: true })
      return
    }

    const { id: eventId, type: eventType, data: { object: eventObject } } = schemaResult.data

    // Mapeia event.type → PaymentStatus; null = evento desconhecido → aceita silenciosamente
    const newStatus = stripeEventTypeToPaymentStatus(eventType, eventObject)
    if (newStatus === null) {
      res.status(200).json({ received: true })
      return
    }

    // Extrai payment_id do metadata do objeto
    const metadataRaw  = eventObject['metadata']
    const paymentIdRaw = typeof metadataRaw === 'object' && metadataRaw !== null && 'payment_id' in metadataRaw
      ? metadataRaw['payment_id']
      : undefined

    if (typeof paymentIdRaw !== 'string') {
      this.deps.logger.warn(
        { eventId, eventType },
        'Stripe webhook: payment_id absent in event.data.object.metadata — skipping',
      )
      res.status(200).json({ received: true })
      return
    }

    let paymentId: ReturnType<typeof PaymentId.of>
    try {
      paymentId = PaymentId.of(paymentIdRaw)
    } catch {
      this.deps.logger.warn(
        { eventId, eventType, paymentIdRaw },
        'Stripe webhook: payment_id is not a valid UUID — skipping',
      )
      res.status(200).json({ received: true })
      return
    }

    const result = await this.deps.processWebhookUseCase.execute({ eventId, paymentId, newStatus })

    if (!result.ok) {
      // Erros de negócio são swallowed — gateway não deve retentar (ADR-002)
      this.deps.logger.warn(
        { eventId, eventType, error: result.error.message },
        'Stripe webhook: business error swallowed',
      )
      res.status(200).json({ received: true })
      return
    }

    res.status(200).json({ received: true })
  }

  // -------------------------------------------------------------------------
  // POST /webhooks/asaas
  // -------------------------------------------------------------------------
  handleAsaas = async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    const token         = req.headers['asaas-access-token']
    const expectedToken = process.env['ASAAS_WEBHOOK_TOKEN'] ?? ''

    if (token !== expectedToken) {
      res.status(401).json({ error: 'Invalid Asaas webhook token', code: 'WEBHOOK_INVALID_TOKEN' })
      return
    }

    const schemaResult = AsaasWebhookBodySchema.safeParse(req.body)
    if (!schemaResult.success) {
      res.status(200).json({ received: true })
      return
    }

    const { event, payment } = schemaResult.data

    const newStatus = asaasEventToPaymentStatus(event)
    if (newStatus === null) {
      res.status(200).json({ received: true })
      return
    }

    let paymentId: ReturnType<typeof PaymentId.of>
    try {
      paymentId = PaymentId.of(payment.id)
    } catch {
      res.status(200).json({ received: true })
      return
    }

    await this.deps.processWebhookUseCase.execute({
      eventId:  payment.id,
      paymentId,
      newStatus,
    })

    res.status(200).json({ received: true })
  }
}
