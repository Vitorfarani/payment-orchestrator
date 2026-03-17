import { SettlementScheduler, DEFAULT_SCHEDULE } from '../../../src/domain/settlement/SettlementSchedule'
import type { SettlementScheduleType } from '../../../src/domain/settlement/SettlementSchedule'

// Data base fixa para os testes: 2025-06-15 12:30:45 UTC
const BASE_DATE = new Date(Date.UTC(2025, 5, 15, 12, 30, 45))

describe('DEFAULT_SCHEDULE', () => {
  it('é D+14 — padrão para novos vendedores (ADR-011)', () => {
    expect(DEFAULT_SCHEDULE).toBe('D+14')
  })
})

describe('SettlementScheduler.calculatePayoutDate()', () => {
  it('D+1: adiciona 1 dia corrido', () => {
    const result = SettlementScheduler.calculatePayoutDate(BASE_DATE, 'D+1')
    expect(result.getUTCDate()).toBe(16)
    expect(result.getUTCMonth()).toBe(5) // junho
    expect(result.getUTCFullYear()).toBe(2025)
  })

  it('D+2: adiciona 2 dias corridos', () => {
    const result = SettlementScheduler.calculatePayoutDate(BASE_DATE, 'D+2')
    expect(result.getUTCDate()).toBe(17)
  })

  it('D+14: adiciona 14 dias corridos', () => {
    const result = SettlementScheduler.calculatePayoutDate(BASE_DATE, 'D+14')
    expect(result.getUTCDate()).toBe(29)
    expect(result.getUTCMonth()).toBe(5) // ainda junho
  })

  it('D+30: adiciona 30 dias corridos', () => {
    const result = SettlementScheduler.calculatePayoutDate(BASE_DATE, 'D+30')
    // 15 Jun + 30 = 15 Jul
    expect(result.getUTCDate()).toBe(15)
    expect(result.getUTCMonth()).toBe(6) // julho
  })

  it('sem schedule explícito usa DEFAULT_SCHEDULE (D+14)', () => {
    const comDefault  = SettlementScheduler.calculatePayoutDate(BASE_DATE)
    const comExplicito = SettlementScheduler.calculatePayoutDate(BASE_DATE, 'D+14')
    expect(comDefault.getTime()).toBe(comExplicito.getTime())
  })

  it('normaliza sempre para meia-noite UTC, ignorando a hora da captura', () => {
    const comHora = new Date(Date.UTC(2025, 5, 15, 23, 59, 59, 999))
    const result  = SettlementScheduler.calculatePayoutDate(comHora, 'D+1')
    expect(result.getUTCHours()).toBe(0)
    expect(result.getUTCMinutes()).toBe(0)
    expect(result.getUTCSeconds()).toBe(0)
    expect(result.getUTCMilliseconds()).toBe(0)
  })

  it('atravessa fim de mês: 31 Jan + 14 dias = 14 Fev', () => {
    const jan31 = new Date(Date.UTC(2025, 0, 31))
    const result = SettlementScheduler.calculatePayoutDate(jan31, 'D+14')
    expect(result.getUTCDate()).toBe(14)
    expect(result.getUTCMonth()).toBe(1) // fevereiro
    expect(result.getUTCFullYear()).toBe(2025)
  })

  it('atravessa virada de ano: 31 Dez + 2 dias = 2 Jan do ano seguinte', () => {
    const dez31 = new Date(Date.UTC(2025, 11, 31))
    const result = SettlementScheduler.calculatePayoutDate(dez31, 'D+2')
    expect(result.getUTCDate()).toBe(2)
    expect(result.getUTCMonth()).toBe(0) // janeiro
    expect(result.getUTCFullYear()).toBe(2026)
  })

  it('não modifica a data original passada como argumento', () => {
    const original    = new Date(Date.UTC(2025, 5, 15))
    const originalMs  = original.getTime()
    SettlementScheduler.calculatePayoutDate(original, 'D+30')
    expect(original.getTime()).toBe(originalMs)
  })

  it('suporta todos os 4 schedules sem erro', () => {
    const schedules: SettlementScheduleType[] = ['D+1', 'D+2', 'D+14', 'D+30']
    for (const schedule of schedules) {
      expect(() => SettlementScheduler.calculatePayoutDate(BASE_DATE, schedule))
        .not.toThrow()
    }
  })
})
