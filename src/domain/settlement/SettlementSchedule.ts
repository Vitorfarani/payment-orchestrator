// Schedules suportados (ADR-011).
// Dias corridos — não dias úteis (v1 não trata feriados).
export type SettlementScheduleType = 'D+1' | 'D+2' | 'D+14' | 'D+30'

// Padrão para novos vendedores: cobre a janela de chargeback mais comum
// e o prazo do Asaas para marketplaces brasileiros.
export const DEFAULT_SCHEDULE: SettlementScheduleType = 'D+14'

const SCHEDULE_DAYS: Readonly<Record<SettlementScheduleType, number>> = {
  'D+1':  1,
  'D+2':  2,
  'D+14': 14,
  'D+30': 30,
}

export class SettlementScheduler {
  // Calcula a data de payout a partir da data de captura.
  // Sempre retorna meia-noite UTC — payouts rodam no início do dia.
  // Não modifica a data de entrada.
  static calculatePayoutDate(
    capturedAt: Date,
    schedule: SettlementScheduleType = DEFAULT_SCHEDULE,
  ): Date {
    const days       = SCHEDULE_DAYS[schedule]
    const payoutDate = new Date(capturedAt)
    payoutDate.setUTCDate(payoutDate.getUTCDate() + days)
    payoutDate.setUTCHours(0, 0, 0, 0)
    return payoutDate
  }
}
