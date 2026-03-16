# ADR-007: CQRS no Ledger — separação de write model e read model

## Metadados

| Campo | Valor |
|---|---|
| **ID** | ADR-007 |
| **Título** | CQRS no Ledger — separação de write model e read model |
| **Status** | `accepted` |
| **Data** | 2025-01-01 |
| **Contextos afetados** | LedgerContext |
| **Depende de** | ADR-001 (Cents), ADR-010 (Chart of Accounts) |

---

## Contexto

O Ledger tem dois perfis de uso completamente diferentes que conflitam entre si:

**Escrita (write):** precisa de integridade máxima. Cada `JournalEntry` envolve múltiplas linhas em `ledger_entries`, deve ser atômica (ACID), e o banco deve rejeitar qualquer entrada que quebre o equilíbrio débito/crédito. O schema é normalizado por design — é isso que garante a confiabilidade financeira.

**Leitura (read):** o Dashboard de Conciliação precisa exibir totais por vendedor por período, saldo atual de cada conta, histórico de transações com filtros. Essas queries em um schema normalizado exigem múltiplos JOINs pesados entre `accounts`, `journal_entries` e `ledger_entries`. Em produção com volume alto, isso degrada a performance de escrita por competição de locks.

O problema central: **o modelo otimizado para garantir integridade é o oposto do modelo otimizado para consulta eficiente**.

---

## Decisão

Aplicaremos **CQRS (Command Query Responsibility Segregation)** no Ledger, separando o modelo de escrita do modelo de leitura via **Materialized View no PostgreSQL**.

- O **write model** permanece normalizado: `accounts` → `journal_entries` → `ledger_entries`. Nenhuma alteração nessa estrutura.
- O **read model** é uma `MATERIALIZED VIEW` chamada `ledger_summary` que desnormaliza os dados para o dashboard: uma linha por `(seller_id, date, account_type)` com totais pré-calculados.
- A view é atualizada via `REFRESH MATERIALIZED VIEW CONCURRENTLY` — disparado pelo Outbox Relay após eventos de ledger processados, ou por job agendado a cada 5 minutos.
- O dashboard **nunca consulta as tabelas normalizadas diretamente** — sempre via `ledger_summary` ou views derivadas.

---

## Alternativas consideradas

### Alternativa 1: Banco de dados separado para leitura (CQRS completo)

Manter um segundo banco (ex: PostgreSQL read replica ou Redis) sincronizado via eventos de domínio, dedicado exclusivamente às queries do dashboard.

**Prós:** isolamento total de performance, pode escalar independentemente, tecnologia otimizada para leitura.
**Contras:** complexidade operacional muito maior — dois bancos, sincronização de eventos, eventual consistency no dashboard, infraestrutura adicional no Docker Compose.
**Por que descartada:** o volume de um portfólio não justifica essa complexidade. `MATERIALIZED VIEW` resolve o problema com a mesma infraestrutura existente. Podemos migrar para essa alternativa se o volume crescer sem breaking changes no domínio.

### Alternativa 2: Views comuns (não materializadas)

Criar `VIEW` normais no PostgreSQL que executam as queries complexas no momento da consulta.

**Prós:** sempre atualizadas (zero lag), sem necessidade de refresh.
**Contras:** cada consulta ao dashboard re-executa os JOINs pesados nas tabelas normalizadas, competindo com as escritas. Sem benefício de performance.
**Por que descartada:** não resolve o problema de performance que motivou o CQRS. É apenas um alias de query, não uma separação de modelo.

### Alternativa 3: Queries diretas com índices otimizados

Manter um único modelo, mas com índices compostos otimizados para as queries do dashboard.

**Prós:** arquitetura mais simples, sem sincronização.
**Contras:** índices adicionais aumentam o custo de escrita. Para queries com agregações e múltiplos filtros dinâmicos, índices não eliminam os JOINs.
**Por que descartada:** mitiga mas não resolve. A raiz do problema é estrutural — escrita e leitura têm modelos de dados fundamentalmente diferentes.

---

## Consequências

### Positivas
- Queries do dashboard são simples e rápidas — sem JOINs, sem agregações em tempo real.
- O write model permanece 100% normalizado, sem comprometer a integridade.
- `REFRESH MATERIALIZED VIEW CONCURRENTLY` não bloqueia reads enquanto atualiza.
- Migração futura para banco separado é possível sem alterar domínio ou use cases.

### Negativas / Trade-offs
- O dashboard tem **lag eventual** entre uma transação acontecer e aparecer no dashboard (máximo 5 minutos pelo job agendado, geralmente segundos pelo Outbox Relay).
- Necessidade de gerenciar o refresh — se parar de rodar, o dashboard mostra dados desatualizados.
- Dois "lugares" para entender o Ledger: o write model para integridade, o read model para visualização.

### Riscos e mitigações
- **Risco:** refresh falha silenciosamente e dashboard mostra dados antigos por horas.
  **Mitigação:** métrica `ledger_read_model_lag_seconds` monitorada pelo Prometheus. Alerta se lag > 10 minutos.

- **Risco:** developer consulta tabelas normalizadas diretamente no dashboard, bypassando o read model.
  **Mitigação:** convenção documentada + code review. O repositório de leitura (`LedgerQueryRepository`) é a única interface permitida para o dashboard.

---

## Implementação

```sql
-- Read model: desnormalizado para queries do dashboard
CREATE MATERIALIZED VIEW ledger_summary AS
SELECT
  le.seller_id,
  je.created_at::date                    AS entry_date,
  a.account_type,
  a.account_code,
  SUM(CASE WHEN le.entry_type = 'CREDIT'
        THEN le.amount_cents ELSE 0 END) AS total_credits,
  SUM(CASE WHEN le.entry_type = 'DEBIT'
        THEN le.amount_cents ELSE 0 END) AS total_debits,
  SUM(CASE WHEN le.entry_type = 'CREDIT'
        THEN le.amount_cents ELSE -le.amount_cents END) AS balance_cents,
  COUNT(DISTINCT je.id)                  AS transaction_count
FROM ledger_entries le
JOIN journal_entries je ON je.id = le.journal_entry_id
JOIN accounts a ON a.id = le.account_id
GROUP BY le.seller_id, entry_date, a.account_type, a.account_code
WITH DATA;

-- Índice para queries por vendedor + período (padrão do dashboard)
CREATE UNIQUE INDEX idx_ledger_summary_pk
  ON ledger_summary (seller_id, entry_date, account_code);

-- Refresh sem bloquear leitura (requer o índice UNIQUE acima)
REFRESH MATERIALIZED VIEW CONCURRENTLY ledger_summary;
```

```typescript
// infrastructure/database/repositories/LedgerQueryRepository.ts
// Este é o ÚNICO ponto de acesso ao read model.
// Use cases e controllers nunca consultam ledger_entries diretamente.

export class LedgerQueryRepository {
  async getSummaryBySeller(
    sellerId: SellerId,
    from: Date,
    to: Date
  ): Promise<SellerLedgerSummary[]> {
    return this.db('ledger_summary')
      .where({ seller_id: sellerId })
      .whereBetween('entry_date', [from, to])
      .orderBy('entry_date', 'desc')
  }

  async getBalanceByAccount(accountCode: string): Promise<Cents> {
    const row = await this.db('ledger_summary')
      .sum('balance_cents as total')
      .where({ account_code: accountCode })
      .first()
    return Cents.of(Number(row?.total ?? 0))
  }
}
```

**Refresh do read model** — disparado em dois momentos:
1. Pelo `OutboxRelay` após processar eventos `ledger.entry_recorded` (quase tempo real)
2. Por job agendado a cada 5 minutos como fallback (garante consistência mesmo se o relay atrasar)

Referências: `src/infrastructure/database/views/ledger-summary.sql`, `src/infrastructure/queue/workers/LedgerRefreshWorker.ts`
