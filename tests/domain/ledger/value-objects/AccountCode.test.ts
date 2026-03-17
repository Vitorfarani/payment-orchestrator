import { AccountCode, AccountType, ACCOUNT_TYPES } from '../../../../src/domain/ledger/value-objects/AccountCode'

describe('AccountCode', () => {
  it('define as 7 contas do plano de contas com os códigos corretos', () => {
    expect(AccountCode.RECEIVABLE_GATEWAY).toBe('1001')
    expect(AccountCode.PAYABLE_SELLER).toBe('2001')
    expect(AccountCode.PAYABLE_REFUND).toBe('2002')
    expect(AccountCode.REVENUE_PLATFORM).toBe('3001')
    expect(AccountCode.REVENUE_CHARGEBACK_FEE).toBe('3002')
    expect(AccountCode.EXPENSE_CHARGEBACK_LOSS).toBe('4001')
    expect(AccountCode.EXPENSE_GATEWAY_FEE).toBe('4002')
  })
})

describe('ACCOUNT_TYPES', () => {
  it('mapeia RECEIVABLE_GATEWAY como ASSET', () => {
    expect(ACCOUNT_TYPES[AccountCode.RECEIVABLE_GATEWAY]).toBe(AccountType.ASSET)
  })

  it('mapeia contas Payable como LIABILITY', () => {
    expect(ACCOUNT_TYPES[AccountCode.PAYABLE_SELLER]).toBe(AccountType.LIABILITY)
    expect(ACCOUNT_TYPES[AccountCode.PAYABLE_REFUND]).toBe(AccountType.LIABILITY)
  })

  it('mapeia contas Revenue como REVENUE', () => {
    expect(ACCOUNT_TYPES[AccountCode.REVENUE_PLATFORM]).toBe(AccountType.REVENUE)
    expect(ACCOUNT_TYPES[AccountCode.REVENUE_CHARGEBACK_FEE]).toBe(AccountType.REVENUE)
  })

  it('mapeia contas Expense como EXPENSE', () => {
    expect(ACCOUNT_TYPES[AccountCode.EXPENSE_CHARGEBACK_LOSS]).toBe(AccountType.EXPENSE)
    expect(ACCOUNT_TYPES[AccountCode.EXPENSE_GATEWAY_FEE]).toBe(AccountType.EXPENSE)
  })

  it('cobre todas as 7 contas sem lacunas no mapa', () => {
    const codes = Object.values(AccountCode)
    expect(codes).toHaveLength(7)
    for (const code of codes) {
      expect(ACCOUNT_TYPES[code]).toBeDefined()
    }
  })
})
