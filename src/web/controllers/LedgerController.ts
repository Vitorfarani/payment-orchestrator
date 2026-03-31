import { z } from 'zod'
import type { Request, Response, NextFunction } from 'express'
import { SellerId } from '../../domain/shared/types'

// Structural interface — implementada por LedgerQueryRepository (CQRS, ADR-007)
interface LedgerRow {
  sellerId:     string
  date:         Date
  accountCode:  string
  accountType:  string
  totalDebits:  number
  totalCredits: number
  entryCount:   number
}

interface ILedgerQueryRepo {
  findBySeller(sellerId: SellerId, from?: Date, to?: Date): Promise<LedgerRow[]>
}

export interface LedgerControllerDeps {
  ledgerQueryRepo: ILedgerQueryRepo
}

const SummaryQuerySchema = z.object({
  sellerId: z.string().uuid({ message: 'sellerId must be a valid UUID' }),
  from:     z.string().datetime({ message: 'from must be a valid ISO 8601 datetime' }).optional(),
  to:       z.string().datetime({ message: 'to must be a valid ISO 8601 datetime' }).optional(),
})

function toSummaryDto(row: LedgerRow): { sellerId: string; date: string; accountCode: string; accountType: string; totalDebits: number; totalCredits: number; entryCount: number } {
  return {
    sellerId:     row.sellerId,
    date:         row.date instanceof Date ? row.date.toISOString() : String(row.date),
    accountCode:  row.accountCode,
    accountType:  row.accountType,
    totalDebits:  row.totalDebits,
    totalCredits: row.totalCredits,
    entryCount:   row.entryCount,
  }
}

export class LedgerController {
  constructor(private readonly deps: LedgerControllerDeps) {}

  // -------------------------------------------------------------------------
  // GET /ledger/summary
  // -------------------------------------------------------------------------
  getSummary = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parse = SummaryQuerySchema.safeParse(req.query)
    if (!parse.success) {
      res.status(422).json({
        error:   'Invalid query parameters',
        code:    'VALIDATION_ERROR',
        details: parse.error.issues,
      })
      return
    }

    const { sellerId, from, to } = parse.data

    try {
      const rows = await this.deps.ledgerQueryRepo.findBySeller(
        SellerId.of(sellerId),
        from !== undefined ? new Date(from) : undefined,
        to   !== undefined ? new Date(to)   : undefined,
      )

      res.status(200).json({ data: rows.map(toSummaryDto), count: rows.length })
    } catch (err) {
      next(err)
    }
  }
}
