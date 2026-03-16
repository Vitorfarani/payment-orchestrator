# ADR-010: Chart of Accounts — Plano de Contas do Ledger

## Metadados

| Campo | Valor |
|---|---|
| **ID** | ADR-010 |
| **Título** | Chart of Accounts — Plano de Contas do Ledger |
| **Status** | `accepted` |
| **Data** | 2025-01-01 |
| **Contextos afetados** | LedgerContext, SettlementContext |
| **Depende de** | ADR-001 (Cents) |
| **Bloqueia** | ADR-007 (CQRS), migrations do Ledger, RecordDoubleEntryUseCase |

---

## Contexto

O Ledger usa double-entry bookkeeping: toda movimentação financeira é registrada em pelo menos duas contas, garantindo que a soma de todos os débitos sempre iguala a soma de todos os créditos.

Para isso funcionar, precisamos de um **plano de contas** — o conjunto de contas contábeis que o sistema reconhece. Sem esse plano definido explicitamente, cada desenvolvedor cria nomes de conta ad-hoc (`"revenue"`, `"platform_fee"`, `"seller_balance"`) e o Ledger vira uma sopa de strings sem estrutura.

Em contabilidade, contas seguem uma tipologia padrão:
- **Asset (Ativo)**: o que a plataforma tem a receber ou possui
- **Liability (Passivo)**: o que a plataforma deve a terceiros
- **Revenue (Receita)**: ganhos da operação da plataforma
- **Expense (Despesa)**: custos operacionais
- **Equity**: patrimônio líquido (fora do escopo deste projeto)

Cada tipo tem um comportamento contábil específico: débitos aumentam Ativos e Despesas, créditos aumentam Passivos e Receitas. Sem definir os tipos, o double-entry não pode ser verificado corretamente.

---

## Decisão

Adotaremos um plano de contas fixo e versionado, definido como enum no domínio e seed no banco de dados. Nenhuma conta pode ser criada em runtime — toda nova conta requer uma migration e atualização do enum de domínio.

### Plano de contas do Payment Orchestrator

```
Código          Nome                        Tipo        Descrição
─────────────────────────────────────────────────────────────────────────────
ASSET

1001            Receivable Gateway          ASSET       Valor a receber do gateway após captura
                                                        Debitado quando: pagamento é capturado
                                                        Creditado quando: gateway liquida (settlement)

LIABILITY

2001            Payable Seller              LIABILITY   Valor devido ao vendedor após split
                                                        Creditado quando: pagamento é capturado
                                                        Debitado quando: payout é executado

2002            Payable Refund              LIABILITY   Valor reservado para estorno pendente
                                                        Creditado quando: estorno é solicitado
                                                        Debitado quando: gateway confirma estorno

REVENUE

3001            Revenue Platform            REVENUE     Comissão da plataforma sobre vendas
                                                        Creditado quando: pagamento é capturado
                                                        Debitado quando: estorno reverte comissão

3002            Revenue Chargeback Fee      REVENUE     Taxa de chargeback cobrada do vendedor
                                                        Creditado quando: chargeback é perdido

EXPENSE

4001            Expense Chargeback Loss     EXPENSE     Prejuízo de chargeback perdido
                                                        Debitado quando: chargeback é perdido
                                                        (a plataforma devolve o valor ao comprador)

4002            Expense Gateway Fee         EXPENSE     Taxa cobrada pelo gateway por transação
                                                        Debitado quando: gateway desconta a taxa
```

### Fluxo contábil completo — pagamento de R$ 100,00 com split 8%

```
Evento: PaymentCaptured (R$ 100,00 | comissão 8%)
─────────────────────────────────────────────────
DEBIT   1001 Receivable Gateway    10.000 cents  ← vamos receber do gateway
CREDIT  3001 Revenue Platform         800 cents  ← nossa comissão
CREDIT  2001 Payable Seller          9.200 cents  ← devemos ao vendedor
Balanço: 10.000 = 800 + 9.200 ✓

Evento: SettlementReceived (gateway deposita)
─────────────────────────────────────────────
DEBIT   2001 Payable Seller          9.200 cents  ← zeramos a dívida com o vendedor
CREDIT  1001 Receivable Gateway      9.200 cents  ← gateway pagou
(a comissão já ficou na plataforma)

Evento: PayoutExecuted (payout ao vendedor)
─────────────────────────────────────────────
— neste modelo simplificado, o payout é o próprio settlement do vendedor
— em modelo mais complexo, adicionaríamos conta Cash/Bank

Evento: RefundRequested (estorno total)
─────────────────────────────────────────
DEBIT   3001 Revenue Platform           800 cents  ← devolvemos comissão
DEBIT   2001 Payable Seller            9.200 cents  ← zeramos saldo do vendedor
CREDIT  2002 Payable Refund           10.000 cents  ← reservamos para devolver

Evento: RefundConfirmed (gateway confirma)
──────────────────────────────────────────
DEBIT   2002 Payable Refund           10.000 cents  ← usamos a reserva
CREDIT  1001 Receivable Gateway       10.000 cents  ← gateway debitará nossa conta

Evento: ChargebackLost
──────────────────────
DEBIT   4001 Expense Chargeback Loss  10.000 cents  ← prejuízo total
CREDIT  1001 Receivable Gateway       10.000 cents  ← gateway debita de volta
```

---

## Alternativas consideradas

### Alternativa 1: Contas criadas dinamicamente por vendedor

Criar uma conta `Payable_Seller_{sellerId}` para cada vendedor individualmente.

**Prós:** rastreabilidade por vendedor diretamente nas contas contábeis.
**Contras:** número de contas cresce linearmente com vendedores, consultas de balanço agregado ficam complexas, não é como contabilidade funciona na prática.
**Por que descartada:** a discriminação por vendedor é responsabilidade do campo `seller_id` nas entradas, não da conta em si. Contas contábeis representam categorias econômicas, não entidades individuais.

### Alternativa 2: Plano de contas configurável via banco de dados

Permitir que administradores criem novas contas via interface, sem migration.

**Prós:** flexibilidade operacional, sem deploy para adicionar conta.
**Contras:** o código de domínio referencia contas por código (`AccountCode.RECEIVABLE_GATEWAY`). Se uma conta pode aparecer ou sumir em runtime, o domínio perde a garantia de que a conta existe quando precisa dela. Requer validação em runtime onde compile-time seria suficiente.
**Por que descartada:** YAGNI. O plano de contas de um marketplace é estável — não muda com frequência. A rigidez é uma feature, não um bug: garante que o domínio sempre tem as contas que espera.

---

## Consequências

### Positivas
- O domínio pode referenciar contas como constantes tipadas — sem magic strings.
- Toda nova conta passa por code review (migration + enum) — mudanças no plano de contas são rastreáveis no Git.
- O trigger de double-entry (ADR-016) pode verificar balanços de forma confiável porque o conjunto de contas é finito e conhecido.
- Fácil de auditar: listar todas as contas é uma query simples em uma tabela pequena e estável.

### Negativas / Trade-offs
- Adicionar uma nova conta requer migration + deploy — sem agilidade operacional.
- O plano de contas atual é simplificado para um portfólio. Um marketplace real teria mais contas (impostos, múltiplas moedas, diferentes tipos de fee).

### Riscos e mitigações
- **Risco:** fluxo contábil implementado errado (débito/crédito invertidos).
  **Mitigação:** testes unitários para cada fluxo do diagrama acima. O trigger de balanço no banco detecta qualquer entrada que não feche em zero.

- **Risco:** nova feature precisar de conta não prevista no plano atual.
  **Mitigação:** processo claro: abrir PR com migration + atualização deste ADR (nova versão do plano de contas na seção Implementação) + atualização do enum de domínio.

---

## Implementação

```typescript
// src/domain/ledger/value-objects/AccountCode.ts
// Enum do domínio — fonte de verdade no código.
// Sempre em sync com a migration seed.

export enum AccountCode {
  // Assets
  RECEIVABLE_GATEWAY    = '1001',

  // Liabilities
  PAYABLE_SELLER        = '2001',
  PAYABLE_REFUND        = '2002',

  // Revenue
  REVENUE_PLATFORM      = '3001',
  REVENUE_CHARGEBACK_FEE = '3002',

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

// Mapa de tipo por código — usado pelo trigger e pelo domínio
export const ACCOUNT_TYPES: Record<AccountCode, AccountType> = {
  [AccountCode.RECEIVABLE_GATEWAY]:      AccountType.ASSET,
  [AccountCode.PAYABLE_SELLER]:          AccountType.LIABILITY,
  [AccountCode.PAYABLE_REFUND]:          AccountType.LIABILITY,
  [AccountCode.REVENUE_PLATFORM]:        AccountType.REVENUE,
  [AccountCode.REVENUE_CHARGEBACK_FEE]:  AccountType.REVENUE,
  [AccountCode.EXPENSE_CHARGEBACK_LOSS]: AccountType.EXPENSE,
  [AccountCode.EXPENSE_GATEWAY_FEE]:     AccountType.EXPENSE,
}
```

```sql
-- migration: seed das contas (tabela accounts)
INSERT INTO accounts (id, code, name, type, description) VALUES
  (gen_random_uuid(), '1001', 'Receivable Gateway',     'ASSET',     'Valor a receber do gateway após captura'),
  (gen_random_uuid(), '2001', 'Payable Seller',          'LIABILITY', 'Valor devido ao vendedor após split'),
  (gen_random_uuid(), '2002', 'Payable Refund',          'LIABILITY', 'Reserva para estornos pendentes'),
  (gen_random_uuid(), '3001', 'Revenue Platform',        'REVENUE',   'Comissão da plataforma sobre vendas'),
  (gen_random_uuid(), '3002', 'Revenue Chargeback Fee',  'REVENUE',   'Taxa de chargeback cobrada do vendedor'),
  (gen_random_uuid(), '4001', 'Expense Chargeback Loss', 'EXPENSE',   'Prejuízo de chargeback perdido'),
  (gen_random_uuid(), '4002', 'Expense Gateway Fee',     'EXPENSE',   'Taxa cobrada pelo gateway por transação')
ON CONFLICT (code) DO NOTHING;
```

**Arquivos:**
- `src/domain/ledger/value-objects/AccountCode.ts`
- `src/infrastructure/database/migrations/006_accounts_seed.ts`
- `docs/domain/chart-of-accounts.md` — versão legível para stakeholders não-técnicos
