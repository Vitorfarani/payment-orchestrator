export type PaymentStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'REQUIRES_ACTION'
  | 'AUTHORIZED'
  | 'CAPTURED'
  | 'SETTLED'
  | 'REFUNDED'
  | 'PARTIALLY_REFUNDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'DISPUTED'
  | 'CHARGEBACK_WON'
  | 'CHARGEBACK_LOST'

// Único lugar que define o que pode ir pra onde.
// readonly garante que ninguém muta isso em runtime.
export const VALID_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  PENDING:             ['PROCESSING', 'CANCELLED'],
  PROCESSING:          ['AUTHORIZED', 'REQUIRES_ACTION', 'FAILED', 'CANCELLED'],
  REQUIRES_ACTION:     ['AUTHORIZED', 'FAILED', 'CANCELLED'],
  AUTHORIZED:          ['CAPTURED', 'CANCELLED'],
  CAPTURED:            ['SETTLED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'DISPUTED'],
  SETTLED:             ['REFUNDED', 'PARTIALLY_REFUNDED', 'DISPUTED'],
  REFUNDED:            [],
  PARTIALLY_REFUNDED:  ['REFUNDED', 'DISPUTED'],
  FAILED:              [],
  CANCELLED:           [],
  DISPUTED:            ['CHARGEBACK_WON', 'CHARGEBACK_LOST'],
  CHARGEBACK_WON:      [],
  CHARGEBACK_LOST:     [],
} 

export const TERMINAL_STATES: readonly PaymentStatus[] = [
  'REFUNDED',
  'FAILED',
  'CANCELLED',
  'CHARGEBACK_WON',
  'CHARGEBACK_LOST',
]

// Usada em switches para garantir que todos os estados são tratados.
// Se adicionar um novo estado e esquecer de tratar no switch,
// o TypeScript recusa compilar.
export function assertNever(status: never): never {
  throw new Error(`Estado não tratado: ${JSON.stringify(status)}`)
}