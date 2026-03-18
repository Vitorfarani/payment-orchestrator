import { randomUUID } from 'crypto'


declare const __brand: unique symbol
type Brand<T, B> = T & { readonly [__brand]: B }

// — Identificadores —
export type PaymentId      = Brand<string, 'PaymentId'>
export type SellerId       = Brand<string, 'SellerId'>
export type AccountId      = Brand<string, 'AccountId'>
export type JournalEntryId = Brand<string, 'JournalEntryId'>
export type LedgerEntryId  = Brand<string, 'LedgerEntryId'>
export type SplitRuleId    = Brand<string, 'SplitRuleId'>
export type RequestId      = Brand<string, 'RequestId'>

// — Valores financeiros —
export type Cents          = Brand<number, 'Cents'>
export type CommissionRate = Brand<number, 'CommissionRate'>

export type IdempotencyKey = Brand<string, 'IdempotencyKey'>

// — Validação UUID —
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function requireUUID(value: string, typeName: string): void {
  if (!UUID_REGEX.test(value)) {
    throw new Error(`Invalid ${typeName} format: ${value}`)
  }
}

// — Construtores —
export const PaymentId = {
  of:     (id: string): PaymentId => { requireUUID(id, 'PaymentId'); return id as PaymentId },
  create: (): PaymentId => randomUUID() as PaymentId,
}

export const SellerId = {
  of:     (id: string): SellerId => { requireUUID(id, 'SellerId'); return id as SellerId },
  create: (): SellerId => randomUUID() as SellerId,
}

export const AccountId = {
  of:     (id: string): AccountId => { requireUUID(id, 'AccountId'); return id as AccountId },
  create: (): AccountId => randomUUID() as AccountId,
}

export const JournalEntryId = {
  of:     (id: string): JournalEntryId => { requireUUID(id, 'JournalEntryId'); return id as JournalEntryId },
  create: (): JournalEntryId => randomUUID() as JournalEntryId,
}

export const Cents = {
  of: (value: number): Cents => {
    if (!Number.isInteger(value)) throw new Error(`Cents must be integer, got: ${value}`)
    if (value < 0)                throw new Error(`Cents cannot be negative, got: ${value}`)
    return value as Cents
  },
  ZERO: 0 as Cents,
}

export const CommissionRate = {
  of: (value: number): CommissionRate => {
    if (value < 0 || value > 1) throw new Error(`CommissionRate must be 0..1, got: ${value}`)
    return value as CommissionRate
  },
}

export const IdempotencyKey = {
  of: (key: string): IdempotencyKey => {
    if (key.trim().length < 8)   throw new Error(`IdempotencyKey muito curta: mínimo 8 caracteres`)
    if (key.trim().length > 255) throw new Error(`IdempotencyKey muito longa: máximo 255 caracteres`)
    return key as IdempotencyKey
  },
  generate: (): IdempotencyKey => randomUUID() as IdempotencyKey,
}

// — Settlement —
export type SettlementItemId = Brand<string, 'SettlementItemId'>

export const SettlementItemId = {
  of:     (id: string): SettlementItemId => { requireUUID(id, 'SettlementItemId'); return id as SettlementItemId },
  create: (): SettlementItemId => randomUUID() as SettlementItemId,
}

// — Split —
export const SplitRuleId = {
  of:     (id: string): SplitRuleId => { requireUUID(id, 'SplitRuleId'); return id as SplitRuleId },
  create: (): SplitRuleId => randomUUID() as SplitRuleId,
}
