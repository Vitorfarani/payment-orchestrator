# ADR-011: Settlement schedule — quando o dinheiro vai para o vendedor

## Metadados

| Campo | Valor |
|---|---|
| **ID** | ADR-011 |
| **Título** | Settlement schedule — quando o dinheiro vai para o vendedor |
| **Status** | `accepted` |
| **Data** | 2025-01-01 |
| **Contextos afetados** | SettlementContext, LedgerContext |
| **Depende de** | ADR-010 (Chart of Accounts), ADR-004 (State Machine) |
| **Bloqueia** | SettlementWorker, PayoutUseCase |

---

## Contexto

Quando um pagamento é capturado, o dinheiro não vai imediatamente para o vendedor. Existe um período entre a captura e o payout — chamado de **settlement window** ou prazo de liquidação.

Esse prazo existe por razões legítimas:
- **Proteção contra fraude e chargebacks:** se o comprador contestar a cobrança, a plataforma precisa ter o dinheiro disponível para devolver.
- **Operacional do gateway:** o próprio Stripe/Asaas tem seu prazo para liquidar na conta bancária da plataforma (tipicamente D+2 no Brasil).
- **Modelo de negócio:** prazo mais longo dá à plataforma mais float financeiro.

O problema de não definir isso explicitamente: vendedores não sabem quando vão receber, o sistema não tem base para calcular saldo disponível vs saldo em hold, e o dashboard de conciliação não consegue projetar fluxo de caixa.

**Terminologia:**
- **Settlement date:** dia em que o gateway liquida na conta da plataforma
- **Payout date:** dia em que a plataforma transfere para o vendedor
- **Hold period:** prazo entre captura e payout disponível
- **D+N:** N dias úteis após a captura

---

## Decisão

### Schedule padrão e schedules configuráveis por vendedor

O sistema suporta múltiplos schedules de settlement, configuráveis por vendedor. Novos vendedores recebem o **schedule padrão D+14**.

```
D+1   — vendedores verificados com histórico positivo e volume alto
D+2   — vendedores estabelecidos (padrão após 90 dias sem chargebacks)
D+14  — padrão para novos vendedores (período de warm-up)
D+30  — vendedores em período de monitoramento ou categorias de alto risco
```

**Justificativa do D+14 como padrão:**
- Cobre a janela de chargeback mais comum (7 dias para a maioria dos cartões no Brasil)
- Dá tempo para verificar entrega e resolver disputas antes do payout
- Alinhado com o prazo padrão do Asaas para marketplaces brasileiros

### Como funciona no sistema

Quando um pagamento vai para `CAPTURED`:
1. O `SettlementScheduler` calcula a `payout_date` = `captured_at` + N dias úteis
2. Cria um registro em `settlement_items` com status `PENDING` e a `payout_date`
3. O `SettlementWorker` roda diariamente e processa todos os `settlement_items` com `payout_date <= hoje` e status `PENDING`
4. Para cada item, executa o payout via API do gateway e transiciona para `PROCESSED`

### Dias úteis vs dias corridos

O cálculo usa **dias corridos**, não dias úteis, para simplicidade. A distinção entre dias úteis e corridos cria complexidade significativa (feriados nacionais, regionais, bancários) que está fora do escopo v1. Um ADR futuro pode converter para dias úteis se necessário.

### Entradas do Ledger no settlement

```
Evento: SettlementProcessed (payout executado para o vendedor)
────────────────────────────────────────────────────────────────
DEBIT   2001 Payable Seller      92.00  ← zeramos a dívida com o vendedor
CREDIT  1001 Receivable Gateway  92.00  ← representamos a saída do caixa

(a conta 1001 foi debitada quando o gateway liquidou na plataforma —
 aqui fechamos o ciclo: o que recebemos do gateway foi para o vendedor)
```

---

## Alternativas consideradas

### Alternativa 1: Schedule único fixo para todos os vendedores

Um prazo único (ex: D+14 para todos), sem configuração por vendedor.

**Prós:** implementação muito mais simples, sem tabela de configuração.
**Contras:** trata vendedores estabelecidos igual a novos, o que prejudica o relacionamento com parceiros de alto volume que merecem liquidação mais rápida.
**Por que descartada:** flexibilidade por vendedor é um requisito de negócio mínimo para um marketplace competitivo. A implementação com tabela de configuração não é significativamente mais complexa.

### Alternativa 2: Settlement em tempo real (D+0)

Pagar o vendedor imediatamente após a captura.

**Prós:** melhor experiência para o vendedor.
**Contras:** sem proteção contra chargeback. Se o comprador contestar depois, a plataforma já não tem o dinheiro — precisa recuperar do vendedor, criando complexidade operacional alta.
**Por que descartada:** risco financeiro inaceitável para v1. D+0 é possível com seguro de chargeback ou em casos específicos (vendedores ultra-verificados), mas requer infraestrutura de gestão de risco fora do escopo.

### Alternativa 3: Settlement via saldo acumulado (não por transação)

Em vez de liquidar por transação, acumular o saldo do vendedor e pagar quando atingir um mínimo ou em uma data fixa mensal.

**Prós:** menos transferências bancárias, menor custo operacional (cada TED/PIX tem custo).
**Contras:** vendedor tem menos previsibilidade, saldo acumulado aumenta exposição financeira da plataforma, implementação mais complexa (saldo de vendedor precisa de conta virtual por vendedor).
**Por que descartada:** a abordagem por transação com schedule configurável é mais simples e mais transparente para o vendedor. Consolidação de pagamentos pode ser adicionada como otimização futura.

---

## Consequências

### Positivas
- Vendedores sabem exatamente quando vão receber — `payout_date` é calculada no momento da captura.
- O dashboard pode mostrar "a receber por período" — saldo em hold vs disponível.
- Proteção natural contra chargebacks dentro da janela de hold.
- Configuração por vendedor permite evolução gradual: novos vendedores começam em D+14 e migram para D+2 após histórico positivo.

### Negativas / Trade-offs
- D+14 para novos vendedores pode ser um fator de atrito no onboarding.
- Dias corridos (não úteis) pode resultar em payouts em fins de semana — o gateway tentará no próximo dia útil, criando pequena divergência entre `payout_date` calculada e payout efetivo.

### Riscos e mitigações
- **Risco:** `SettlementWorker` não roda por falha e `settlement_items` acumulam vencidos.
  **Mitigação:** métrica `settlement_items_overdue_count` monitorada. Alerta se houver itens com `payout_date < today - 1 dia`. Worker tem retry automático e DLQ (ADR-012).

- **Risco:** payout executado mas não registrado no Ledger (falha após API do gateway, antes do UPDATE).
  **Mitigação:** Outbox Pattern (ADR-009) — o evento de payout é registrado atomicamente com o UPDATE do `settlement_item`. O Ledger worker processa o evento de forma idempotente.

- **Risco:** payout duplicado (worker roda duas vezes para o mesmo item).
  **Mitigação:** `settlement_items` tem status `PROCESSING` que é setado com `SELECT FOR UPDATE` antes da chamada ao gateway. Segundo worker vê `PROCESSING` e pula.

---

## Implementação

```typescript
// src/domain/settlement/SettlementSchedule.ts

export type SettlementScheduleType = 'D+1' | 'D+2' | 'D+14' | 'D+30'

export const DEFAULT_SCHEDULE: SettlementScheduleType = 'D+14'

const SCHEDULE_DAYS: Record<SettlementScheduleType, number> = {
  'D+1':  1,
  'D+2':  2,
  'D+14': 14,
  'D+30': 30,
}

export class SettlementScheduler {
  static calculatePayoutDate(
    capturedAt: Date,
    schedule: SettlementScheduleType = DEFAULT_SCHEDULE
  ): Date {
    const days = SCHEDULE_DAYS[schedule]
    const payoutDate = new Date(capturedAt)
    payoutDate.setDate(payoutDate.getDate() + days)
    // Normaliza para meia-noite UTC — payouts rodam no início do dia
    payoutDate.setUTCHours(0, 0, 0, 0)
    return payoutDate
  }
}
```

```sql
-- migration: tabela de settlement items
CREATE TABLE settlement_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id      UUID NOT NULL REFERENCES payments(id),
  seller_id       UUID NOT NULL,
  amount_cents    BIGINT NOT NULL CHECK (amount_cents > 0),
  schedule        VARCHAR(5) NOT NULL CHECK (schedule IN ('D+1','D+2','D+14','D+30')),
  payout_date     DATE NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED')),
  processed_at    TIMESTAMPTZ,
  gateway_payout_id VARCHAR(255),   -- ID do payout no gateway externo
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Um pagamento gera exatamente um settlement item
  CONSTRAINT uq_settlement_payment UNIQUE (payment_id)
);

-- Índice para o worker: busca por data de vencimento e status
CREATE INDEX idx_settlement_items_due
  ON settlement_items (payout_date, status)
  WHERE status = 'PENDING';
```

```typescript
// src/infrastructure/queue/workers/SettlementWorker.ts (estrutura)
// Roda diariamente às 06:00 UTC via cron job no BullMQ

export class SettlementWorker {
  async process(): Promise<void> {
    const dueItems = await this.settlementRepo.findDueItems(new Date())

    for (const item of dueItems) {
      await this.db.transaction(async (trx) => {
        // Lock para evitar processamento duplicado
        const locked = await this.settlementRepo.lockForProcessing(item.id, trx)
        if (!locked) return  // outro worker pegou este item

        try {
          const payout = await this.gatewayAdapter.executePayout(item)
          await this.settlementRepo.markProcessed(item.id, payout.gatewayId, trx)
          await this.outboxRepo.save(
            OutboxEvent.create({
              eventType: 'settlement.processed',
              aggregateId: item.id,
              aggregateType: 'SettlementItem',
              payload: { paymentId: item.paymentId, amountCents: item.amount, sellerId: item.sellerId }
            }),
            trx
          )
        } catch (error) {
          await this.settlementRepo.markFailed(item.id, trx)
          throw error  // BullMQ gerencia o retry
        }
      })
    }
  }
}
```

**Arquivos:**
- `src/domain/settlement/SettlementSchedule.ts`
- `src/application/settlement/ScheduleSettlementUseCase.ts`
- `src/infrastructure/queue/workers/SettlementWorker.ts`
- `src/infrastructure/database/migrations/008_settlement_items.ts`
