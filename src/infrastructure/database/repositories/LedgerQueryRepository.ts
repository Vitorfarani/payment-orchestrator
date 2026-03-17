import type { Knex } from 'knex'
import { Cents } from '../../../domain/shared/types'
import type { SellerId } from '../../../domain/shared/types'
import type { AccountCode } from '../../../domain/ledger/value-objects/AccountCode'

/**
 * Read model do ledger — linha da MATERIALIZED VIEW ledger_summary.
 * Exportado para uso no web layer (dashboard, relatórios de conciliação).
 */
export interface LedgerSummaryRow {
  readonly sellerId:     string
  readonly date:         Date
  readonly accountType:  string
  readonly accountCode:  AccountCode
  readonly totalDebits:  Cents
  readonly totalCredits: Cents
  readonly entryCount:   number
}

interface LedgerSummaryDbRow {
  seller_id:    string
  date:         Date
  account_type: string
  account_code: AccountCode
  total_debits:  string   // BIGINT SUM → node-postgres retorna string
  total_credits: string   // BIGINT SUM → node-postgres retorna string
  entry_count:   string   // COUNT(*) BIGINT → node-postgres retorna string
}

function dbRowToSummary(row: LedgerSummaryDbRow): LedgerSummaryRow {
  return {
    sellerId:     row.seller_id,
    date:         row.date,
    accountType:  row.account_type,
    accountCode:  row.account_code,
    totalDebits:  Cents.of(Number(row.total_debits)),
    totalCredits: Cents.of(Number(row.total_credits)),
    entryCount:   Number(row.entry_count),
  }
}

/**
 * Repositório de leitura CQRS sobre a ledger_summary MATERIALIZED VIEW (ADR-007).
 *
 * Separação write/read: PostgresLedgerRepository escreve no modelo normalizado;
 * LedgerQueryRepository lê do modelo pré-agregado (ledger_summary) para o dashboard.
 *
 * Não implementa nenhuma interface de domínio — é exclusivamente infraestrutura.
 * Injetado diretamente nos controllers/use cases de leitura, nunca via IUnitOfWork.
 */
export class LedgerQueryRepository {
  constructor(private readonly db: Knex) {}

  /**
   * Retorna o resumo de ledger por vendedor, opcionalmente filtrado por período.
   * Usado pelo dashboard do vendedor e pelo relatório de conciliação.
   */
  async findBySeller(
    sellerId: SellerId,
    from?: Date,
    to?: Date,
  ): Promise<LedgerSummaryRow[]> {
    let query = this.db<LedgerSummaryDbRow>('ledger_summary').where({ seller_id: sellerId })
    if (from !== undefined) query = query.where('date', '>=', from)
    if (to !== undefined)   query = query.where('date', '<=', to)
    const rows = await query.orderBy('date', 'asc')
    return rows.map(dbRowToSummary)
  }

  /**
   * Retorna o resumo por conta contábil, opcionalmente filtrado por período.
   * Usado por relatórios financeiros da plataforma.
   */
  async findByAccount(
    accountCode: AccountCode,
    from?: Date,
    to?: Date,
  ): Promise<LedgerSummaryRow[]> {
    let query = this.db<LedgerSummaryDbRow>('ledger_summary').where({ account_code: accountCode })
    if (from !== undefined) query = query.where('date', '>=', from)
    if (to !== undefined)   query = query.where('date', '<=', to)
    const rows = await query.orderBy('date', 'asc')
    return rows.map(dbRowToSummary)
  }

  /**
   * Atualiza a materialized view após processar uma JournalEntry.
   * Chamado pelo LedgerWorker — CONCURRENTLY evita lock exclusivo,
   * permitindo leituras simultâneas durante o refresh.
   */
  async refreshView(): Promise<void> {
    await this.db.raw('REFRESH MATERIALIZED VIEW CONCURRENTLY ledger_summary')
  }
}
