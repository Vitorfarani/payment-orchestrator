// Plano de contas fixo — ADR-010.
// Toda nova conta exige migration + atualização deste enum.
// Nunca crie contas em runtime.

export enum AccountCode {
  // Assets
  RECEIVABLE_GATEWAY      = '1001',

  // Liabilities
  PAYABLE_SELLER          = '2001',
  PAYABLE_REFUND          = '2002',

  // Revenue
  REVENUE_PLATFORM        = '3001',
  REVENUE_CHARGEBACK_FEE  = '3002',

  // Expenses
  EXPENSE_CHARGEBACK_LOSS = '4001',
  EXPENSE_GATEWAY_FEE     = '4002',
}

export enum AccountType {
  ASSET     = 'ASSET',
  LIABILITY = 'LIABILITY',
  REVENUE   = 'REVENUE',
  EXPENSE   = 'EXPENSE',
}

// Usado pelo domínio e pelo trigger de double-entry para verificar
// se débitos e créditos estão nas contas corretas.
export const ACCOUNT_TYPES: Readonly<Record<AccountCode, AccountType>> = {
  [AccountCode.RECEIVABLE_GATEWAY]:      AccountType.ASSET,
  [AccountCode.PAYABLE_SELLER]:          AccountType.LIABILITY,
  [AccountCode.PAYABLE_REFUND]:          AccountType.LIABILITY,
  [AccountCode.REVENUE_PLATFORM]:        AccountType.REVENUE,
  [AccountCode.REVENUE_CHARGEBACK_FEE]:  AccountType.REVENUE,
  [AccountCode.EXPENSE_CHARGEBACK_LOSS]: AccountType.EXPENSE,
  [AccountCode.EXPENSE_GATEWAY_FEE]:     AccountType.EXPENSE,
}
