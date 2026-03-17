import { VALID_TRANSITIONS, TERMINAL_STATES, assertNever } from '../../../../src/domain/payment/value-objects/PaymentStatus'

describe('VALID_TRANSITIONS', () => {
  it('PENDING só pode ir para PROCESSING ou CANCELLED', () => {
    expect(VALID_TRANSITIONS['PENDING']).toEqual(['PROCESSING', 'CANCELLED'])
  })

  it('CAPTURED pode ir para SETTLED, REFUNDED, PARTIALLY_REFUNDED, DISPUTED', () => {
    expect(VALID_TRANSITIONS['CAPTURED']).toEqual([
      'SETTLED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'DISPUTED'
    ])
  })

  it('estados terminais têm array vazio', () => {
    expect(VALID_TRANSITIONS['REFUNDED']).toEqual([])
    expect(VALID_TRANSITIONS['FAILED']).toEqual([])
    expect(VALID_TRANSITIONS['CANCELLED']).toEqual([])
    expect(VALID_TRANSITIONS['CHARGEBACK_WON']).toEqual([])
    expect(VALID_TRANSITIONS['CHARGEBACK_LOST']).toEqual([])
  })

  it('cobre todos os 13 estados', () => {
    expect(Object.keys(VALID_TRANSITIONS).length).toBe(13)
  })
})

describe('TERMINAL_STATES', () => {
  it('contém os 5 estados terminais', () => {
    expect(TERMINAL_STATES).toContain('REFUNDED')
    expect(TERMINAL_STATES).toContain('FAILED')
    expect(TERMINAL_STATES).toContain('CANCELLED')
    expect(TERMINAL_STATES).toContain('CHARGEBACK_WON')
    expect(TERMINAL_STATES).toContain('CHARGEBACK_LOST')
  })
})

describe('assertNever', () => {
  it('lança erro com o valor recebido', () => {
    expect(() => assertNever('INVALIDO' as never)).toThrow('INVALIDO')
  })
})