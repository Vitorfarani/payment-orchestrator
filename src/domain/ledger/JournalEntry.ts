import type { JournalEntryId, PaymentId, Cents } from '../shared/types'
import type { Result } from '../shared/Result'
import { ok, err } from '../shared/Result'
import { ValidationError } from '../shared/errors'
import type { AccountCode } from './value-objects/AccountCode'

export interface JournalLine {
  readonly accountCode: AccountCode
  readonly type:        'DEBIT' | 'CREDIT'
  readonly amount:      Cents   // deve ser > 0
}

interface JournalEntryProps {
  readonly id:          JournalEntryId
  readonly paymentId:   PaymentId
  readonly lines:       readonly JournalLine[]
  readonly description: string    // ex: 'PaymentCaptured', 'Refund' — contexto contábil
  readonly occurredAt:  Date      // quando o evento de negócio aconteceu (≠ createdAt)
  readonly createdAt:   Date
}

interface CreateJournalEntryInput {
  id:           JournalEntryId
  paymentId:    PaymentId
  lines:        readonly JournalLine[]
  description:  string
  occurredAt?:  Date    // opcional — defaults para now() se omitido
}

export class JournalEntry {
  private props: JournalEntryProps

  private constructor(props: JournalEntryProps) {
    this.props = props
  }

  get id():          JournalEntryId          { return this.props.id }
  get paymentId():   PaymentId               { return this.props.paymentId }
  get lines():       readonly JournalLine[]  { return this.props.lines }
  get description(): string                  { return this.props.description }
  get occurredAt():  Date                    { return this.props.occurredAt }
  get createdAt():   Date                    { return this.props.createdAt }

  static create(input: CreateJournalEntryInput): Result<JournalEntry, ValidationError> {
    if (input.lines.length < 2) {
      return err(new ValidationError('JournalEntry requer no mínimo 2 linhas'))
    }

    for (const line of input.lines) {
      if (line.amount <= 0) {
        return err(new ValidationError('Todos os valores de JournalEntry devem ser positivos'))
      }
    }

    let debitSum  = 0
    let creditSum = 0
    for (const line of input.lines) {
      if (line.type === 'DEBIT') {
        debitSum  += line.amount
      } else {
        creditSum += line.amount
      }
    }

    if (debitSum !== creditSum) {
      return err(new ValidationError(
        `Entrada não balanceada: débitos ${debitSum} ≠ créditos ${creditSum}`
      ))
    }

    const now = new Date()
    return ok(new JournalEntry({
      ...input,
      occurredAt: input.occurredAt ?? now,
      createdAt:  now,
    }))
  }
}
