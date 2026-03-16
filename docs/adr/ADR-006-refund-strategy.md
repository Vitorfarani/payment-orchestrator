# ADR-006: Estratégia de estorno em pagamentos com split

## Metadados

| Campo | Valor |
|---|---|
| **ID** | ADR-006 |
| **Título** | Estratégia de estorno em pagamentos com split |
| **Status** | `accepted` |
| **Data** | 2025-01-01 |
| **Contextos afetados** | SplitContext, LedgerContext, PaymentContext |
| **Depende de** | ADR-005 (Split Rounding), ADR-010 (Chart of Accounts), ADR-004 (State Machine) |
| **Bloqueia** | RefundPaymentUseCase |

---

## Contexto

Quando um pagamento com split é estornado, o dinheiro precisa ser devolvido ao comprador. Mas o dinheiro já foi dividido: uma parte foi para a plataforma (comissão) e outra foi para o vendedor (ou está a caminho). A questão é: **quem paga o estorno?**

Este problema tem múltiplas dimensões:

**Estorno total vs parcial:** um estorno total reverte 100% do valor. Um estorno parcial (ex: devolução de um item de um pedido multi-item) reverte apenas uma fração.

**Timing do estorno:** se o estorno acontece antes do payout ao vendedor, o saldo do vendedor ainda está na plataforma. Se acontece depois do payout, o vendedor já recebeu — a plataforma precisa recuperar o valor antes de devolver ao comprador.

**Chargeback vs refund voluntário:** um refund é iniciado pela plataforma/vendedor. Um chargeback é iniciado pelo comprador via banco/operadora, e o resultado pode ser desfavorável à plataforma independente da situação.

**Quem absorve o prejuízo:** se o vendedor entregou o produto e o comprador pede estorno indevidamente, quem perde? Se o vendedor não entregou, quem paga?

Sem uma decisão explícita, cada caso vira uma negociação ad-hoc e o Ledger acumula entradas inconsistentes.

---

## Decisão

Adotaremos a estratégia **proporcional ao split original** com as seguintes regras:

### Regra 1 — Estorno total: reversão proporcional

Cada parte devolve proporcionalmente ao que recebeu no split original:

```
Pagamento original: R$ 100,00
  Plataforma recebeu: R$ 8,00 (8%)
  Vendedor recebeu:   R$ 92,00 (92%)

Estorno total:
  Plataforma devolve: R$ 8,00
  Vendedor devolve:   R$ 92,00
  Total devolvido:    R$ 100,00 ✓
```

### Regra 2 — Estorno parcial: baseado no valor estornado com as mesmas proporções

```
Estorno parcial de R$ 50,00 (50% do pedido):
  Plataforma devolve: floor(5000 × 0.08) = 400 cents = R$ 4,00
  Vendedor devolve:   5000 - 400 = 4600 cents = R$ 46,00
  Total devolvido:    R$ 50,00 ✓
```

O arredondamento segue ADR-005: floor para plataforma, resto para vendedor.

### Regra 3 — Chargeback perdido: plataforma absorve

Quando um chargeback é perdido, **a plataforma absorve o valor total** e registra como `Expense Chargeback Loss` (conta 4001 do ADR-010). O vendedor não é debitado automaticamente.

**Justificativa:** chargebacks são risco operacional da plataforma. Debitar o vendedor automaticamente sem investigação prejudica a relação comercial. Em casos de fraude comprovada do vendedor, existe um fluxo manual de recuperação fora do escopo deste projeto.

### Regra 4 — Timing: saldo antes do payout

O sistema verifica o saldo disponível do vendedor antes de executar o estorno:
- Se saldo `Payable_Seller` cobre o estorno → debita do saldo (sem impacto no vendedor)
- Se saldo insuficiente → plataforma adianta o valor e cria um registro de `seller_debt` para recuperação futura (fora do escopo v1 — tratado como `Expense` por enquanto)

### Entradas do Ledger por cenário

```
Estorno total (saldo disponível):
DEBIT   3001 Revenue Platform            800 cents  ← comissão devolvida
DEBIT   2001 Payable Seller             9.200 cents  ← saldo do vendedor reduzido
CREDIT  2002 Payable Refund            10.000 cents  ← reserva para devolver ao comprador

Confirmação do gateway (refund processado):
DEBIT   2002 Payable Refund            10.000 cents  ← usa a reserva
CREDIT  1001 Receivable Gateway        10.000 cents  ← gateway debitará nossa conta

Chargeback perdido:
DEBIT   4001 Expense Chargeback Loss   10.000 cents  ← prejuízo registrado
CREDIT  1001 Receivable Gateway        10.000 cents  ← gateway debita de volta
```

---

## Alternativas consideradas

### Alternativa 1: Plataforma absorve todos os estornos

A plataforma sempre paga o estorno, independente da comissão já recebida.

**Prós:** simples, vendedor nunca é impactado por estornos.
**Contras:** a plataforma perde tanto a comissão quanto assume o risco do valor do vendedor. Em marketplaces de alto volume, isso é financeiramente inviável.
**Por que descartada:** desequilíbrio financeiro claro. A comissão existe em parte para cobrir riscos operacionais, mas assumir 100% do valor é insustentável.

### Alternativa 2: Vendedor absorve todos os estornos

O vendedor é integralmente responsável por qualquer estorno.

**Prós:** protege totalmente a plataforma financeiramente.
**Contras:** desincentiva vendedores, pode ser ilegalmente agressivo dependendo da regulação (Brasil tem proteções ao lojista em contratos de marketplace), e inviabiliza parceiros menores que não têm reserva de capital.
**Por que descartada:** desequilíbrio comercial e risco regulatório.

### Alternativa 3: Pool de reserva para estornos

Reter uma porcentagem de cada pagamento em uma reserva (escrow) e usar para cobrir estornos.

**Prós:** proteção financeira para ambas as partes, modelo usado por grandes marketplaces (Shopify Payments, Stripe Connect).
**Contras:** complexidade significativa — conta de reserva por vendedor, regras de liberação, comunicação com vendedores sobre retenção. Fora do escopo de um portfólio v1.
**Por que descartada:** YAGNI para v1. O design atual não impede adicionar isso — `Payable_Seller` pode se tornar uma reserva gradual em uma versão futura sem breaking changes no Ledger.

---

## Consequências

### Positivas
- Regras claras e documentadas — vendedores podem entender o impacto de estornos.
- O Ledger sempre fecha: cada estorno tem entradas balanceadas.
- Chargebacks não criam dívidas automáticas com vendedores — protege o relacionamento.
- Alinhado com o Chart of Accounts (ADR-010) — usa exatamente as contas definidas.

### Negativas / Trade-offs
- A plataforma absorve chargebacks perdidos — risco financeiro assumido conscientemente.
- Estornos com saldo insuficiente do vendedor ficam como `Expense` temporariamente — recuperação é processo manual em v1.
- Estorno parcial com arredondamento pode acumular diferenças de 1 centavo em casos extremos de múltiplos estornos parciais do mesmo pedido.

### Riscos e mitigações
- **Risco:** estorno executado antes da captura (pagamento ainda em AUTHORIZED).
  **Mitigação:** a state machine (ADR-004) só permite `REFUNDED` a partir de `CAPTURED` ou `SETTLED`. Tentativa de estorno em AUTHORIZED retorna erro de transição inválida.

- **Risco:** estorno duplicado (usuário clica duas vezes ou webhook duplicado).
  **Mitigação:** idempotência (ADR-002) no `RefundPaymentUseCase`. Segundo request com mesma `idempotency_key` retorna resultado do primeiro.

- **Risco:** estorno parcial excede valor original.
  **Mitigação:** `RefundPaymentUseCase` valida que `refund_amount ≤ (original_amount - total_already_refunded)`. Retorna `BusinessRuleError` se exceder.

---

## Implementação

```typescript
// src/application/payment/RefundPaymentUseCase.ts

export interface RefundInput {
  paymentId:      PaymentId
  refundAmount:   Cents           // null = estorno total
  idempotencyKey: IdempotencyKey
  reason:         string
}

export class RefundPaymentUseCase {
  async execute(input: RefundInput): Promise<Result<void, DomainError>> {

    return this.db.transaction(async (trx) => {

      // 1. Busca o pagamento com lock (previne race condition)
      const payment = await this.paymentRepo.findByIdForUpdate(input.paymentId, trx)
      if (!payment) return err(new NotFoundError('Payment', input.paymentId))

      // 2. Determina valor do estorno
      const isTotal = input.refundAmount === null || input.refundAmount >= payment.amount
      const refundCents = isTotal
        ? payment.amount
        : input.refundAmount

      // 3. Valida que não excede o já estornado
      const alreadyRefunded = await this.refundRepo.getTotalRefunded(input.paymentId, trx)
      const remaining       = Cents.of(payment.amount - alreadyRefunded)

      if (refundCents > remaining) {
        return err(new BusinessRuleError(
          `Refund amount ${refundCents} exceeds remaining refundable amount ${remaining}`
        ))
      }

      // 4. Calcula split do estorno (proporcional ao split original)
      const originalSplit = await this.splitRepo.findByPaymentId(input.paymentId, trx)
      const refundSplit   = SplitCalculator.calculate(refundCents, originalSplit.commissionRate)
      if (!refundSplit.ok) return refundSplit

      // 5. Transição de estado
      const newStatus = refundCents >= payment.amount ? 'REFUNDED' : 'PARTIALLY_REFUNDED'
      const transition = payment.transition(newStatus, { refundAmount: refundCents })
      if (!transition.ok) return transition

      // 6. Persiste tudo na mesma transação
      await this.paymentRepo.save(payment, trx)

      // 7. Registra entry no Ledger (domain event será processado pelo worker)
      // O outbox event carrega o split do estorno para o LedgerWorker calcular as entradas
      await this.outboxRepo.save(
        OutboxEvent.create({
          eventType:     'payment.refunded',
          aggregateId:   input.paymentId,
          aggregateType: 'Payment',
          payload: {
            paymentId:       input.paymentId,
            refundCents,
            platformRefund:  refundSplit.value.platform,
            sellerRefund:    refundSplit.value.seller,
            isTotal,
          }
        }),
        trx
      )

      return ok(undefined)
    })
  }
}
```

**Arquivos:**
- `src/application/payment/RefundPaymentUseCase.ts`
- `src/application/ledger/RecordRefundEntryUseCase.ts`
- `src/domain/split/SplitCalculator.ts` — método `calculateRefund`
