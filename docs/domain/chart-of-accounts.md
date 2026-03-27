# Plano de Contas — Payment Orchestrator

> Documento escrito para stakeholders não-técnicos: financeiro, operações, compliance e produto.
> Explica as 7 contas contábeis do sistema, o que cada uma representa em linguagem de negócio
> e como os principais eventos financeiros movimentam essas contas.
>
> Referência técnica: [ADR-010](../adr/ADR-010-chart-of-accounts.md) e [business-rules.md §7](../business-rules.md).

---

## Por que existe um plano de contas

O sistema registra toda movimentação financeira usando **contabilidade de dupla entrada**: cada real que entra em algum lugar sai de outro. Isso garante que nenhum centavo suma ou apareça do nada — o saldo total do sistema é sempre verificável.

Para isso funcionar, precisamos de um conjunto fixo de "contas" que representam as diferentes naturezas do dinheiro em trânsito: o que a plataforma vai receber, o que deve aos vendedores, o que já ganhou, e o que perdeu.

Essas contas são **fixas e imutáveis** — só podem ser alteradas com aprovação formal (um ADR). Isso garante que relatórios históricos sempre façam sentido, independente de quando são consultados.

---

## As 7 contas

### Como ler a tabela

Cada conta tem um **tipo contábil** que determina seu comportamento:

| Tipo | Representa | Saldo positivo significa |
|---|---|---|
| **Ativo** | O que a plataforma tem a receber ou possui | Dinheiro que ainda não chegou mas está garantido |
| **Passivo** | O que a plataforma deve a terceiros | Obrigação financeira com vendedores ou compradores |
| **Receita** | Ganhos da operação da plataforma | Comissões e taxas auferidas |
| **Despesa** | Custos operacionais da plataforma | Prejuízos e taxas pagas |

---

### 1001 — Receivable Gateway (A Receber do Gateway)

**Tipo:** Ativo

**O que representa:** O valor que a plataforma tem garantido junto ao gateway de pagamentos (Stripe/Asaas) mas que ainda não chegou à conta bancária. Funciona como um "cheque a compensar": a venda foi feita, o dinheiro está reservado, mas o gateway ainda não depositou.

**Aumenta quando:** Um pagamento é capturado — a plataforma passa a ter direito sobre aquele valor.

**Diminui quando:**
- O gateway deposita o valor na conta da plataforma e o dinheiro segue para o vendedor (liquidação/settlement)
- Um estorno é confirmado — o gateway devolve o valor ao comprador e debita da conta da plataforma
- Um chargeback é perdido — o gateway reverte o crédito

---

### 2001 — Payable Seller (A Pagar ao Vendedor)

**Tipo:** Passivo

**O que representa:** O saldo que a plataforma deve ao vendedor pela venda realizada, descontada a comissão da plataforma. É o dinheiro do vendedor que está temporariamente "guardado" na plataforma aguardando o prazo de liquidação (D+1, D+2, D+14 ou D+30, conforme contrato).

**Aumenta quando:** Um pagamento é capturado — a parte do vendedor é creditada ao seu saldo.

**Diminui quando:**
- O payout é executado — o dinheiro é transferido para a conta bancária do vendedor
- Um estorno ocorre — a parte do vendedor é devolvida proporcionalmente ao comprador

---

### 2002 — Payable Refund (Reserva para Estorno)

**Tipo:** Passivo

**O que representa:** Uma conta de trânsito. Quando um estorno é solicitado, o valor saí das contas do vendedor e da receita da plataforma e é reservado aqui, aguardando a confirmação do gateway de que o dinheiro foi efetivamente devolvido ao comprador.

**Aumenta quando:** Um estorno é solicitado — os valores são reservados nesta conta.

**Diminui quando:** O gateway confirma que processou o estorno — a reserva é usada para cobrir a devolução.

---

### 3001 — Revenue Platform (Receita da Plataforma)

**Tipo:** Receita

**O que representa:** A comissão da plataforma sobre as vendas realizadas. É o ganho efetivo da plataforma em cada transação, calculado como percentual do valor total.

**Aumenta quando:** Um pagamento é capturado — a comissão é reconhecida como receita.

**Diminui quando:** Um estorno ocorre — a comissão é devolvida proporcionalmente (a plataforma devolve sua parte do estorno).

---

### 3002 — Revenue Chargeback Fee (Taxa de Chargeback)

**Tipo:** Receita

**O que representa:** Taxa cobrada do vendedor quando um chargeback é perdido. Em alguns modelos de negócio, parte do prejuízo do chargeback é repassada ao vendedor na forma de uma taxa administrativa.

**Aumenta quando:** Um chargeback é perdido e há previsão contratual de repasse de taxa ao vendedor.

> **Nota:** em v1, o uso desta conta está previsto no plano de contas mas a lógica de aplicação automática da taxa ao vendedor é tratada como processo manual. Ver [business-rules.md §13](../business-rules.md).

---

### 4001 — Expense Chargeback Loss (Prejuízo de Chargeback)

**Tipo:** Despesa

**O que representa:** O prejuízo que a plataforma absorve quando perde uma disputa de chargeback. O comprador contestou a cobrança, o banco emissor decidiu a favor do comprador, e o gateway debitou o valor de volta. A plataforma absorve esse valor integralmente — o vendedor não é debitado automaticamente.

**Aumenta quando:** Um chargeback é perdido — o prejuízo total é registrado aqui.

**Justificativa:** chargebacks são risco operacional da plataforma. Debitar o vendedor automaticamente sem investigação prejudicaria a relação comercial. Em casos de fraude comprovada do vendedor, existe um processo manual de recuperação.

---

### 4002 — Expense Gateway Fee (Taxa do Gateway)

**Tipo:** Despesa

**O que representa:** A taxa cobrada pelo gateway (Stripe/Asaas) por cada transação processada. É um custo operacional da plataforma.

**Aumenta quando:** O gateway desconta sua taxa da liquidação.

> **Nota:** em v1, esta conta está prevista no plano de contas mas o registro automático da taxa por transação depende de dados fornecidos pelo gateway no webhook de settlement, cuja integração está em escopo futuro.

---

## Exemplos de movimentações

As movimentações abaixo usam um exemplo base: **pagamento de R$ 100,00 com comissão de 8% (R$ 8,00 para a plataforma, R$ 92,00 para o vendedor).**

Em cada movimentação, a coluna "Entra em" indica a conta que recebe o lançamento e a coluna "Sai de" indica a conta que é reduzida. Toda movimentação tem dois lados — isso é a garantia de que nenhum valor some.

---

### Captura de pagamento

**O que acontece:** o comprador pagou, o gateway confirmou a cobrança. O dinheiro está garantido.

| Conta | Saldo | Valor | Interpretação |
|---|---|---|---|
| 1001 Receivable Gateway | Aumenta | R$ 100,00 | Passamos a ter R$ 100,00 a receber do gateway |
| 3001 Revenue Platform | Aumenta | R$ 8,00 | Nossa comissão de 8% está reconhecida |
| 2001 Payable Seller | Aumenta | R$ 92,00 | Passamos a dever R$ 92,00 ao vendedor |

Verificação: R$ 100,00 entrou no ativo = R$ 8,00 de receita + R$ 92,00 de passivo. Balanceado.

---

### Liquidação (payout ao vendedor)

**O que acontece:** chegou o prazo de liquidação (ex: D+14). O gateway deposita na plataforma e a plataforma transfere para o vendedor.

| Conta | Saldo | Valor | Interpretação |
|---|---|---|---|
| 2001 Payable Seller | Diminui | R$ 92,00 | Zeramos a dívida com o vendedor |
| 1001 Receivable Gateway | Diminui | R$ 92,00 | O gateway pagou; usamos esse valor para pagar o vendedor |

O gateway deposita o valor bruto junto à plataforma; esta retém a comissão (R$ 8,00) e transfere o restante ao vendedor.

---

### Estorno total solicitado

**O que acontece:** o comprador pediu estorno total de R$ 100,00. O estorno foi solicitado mas ainda aguarda confirmação do gateway.

**Fase 1 — Reserva do valor:**

| Conta | Saldo | Valor | Interpretação |
|---|---|---|---|
| 3001 Revenue Platform | Diminui | R$ 8,00 | Devolvemos nossa comissão |
| 2001 Payable Seller | Diminui | R$ 92,00 | Zeramos o saldo do vendedor referente a esta venda |
| 2002 Payable Refund | Aumenta | R$ 100,00 | Reservamos R$ 100,00 para devolver ao comprador |

**Fase 2 — Gateway confirma o estorno:**

| Conta | Saldo | Valor | Interpretação |
|---|---|---|---|
| 2002 Payable Refund | Diminui | R$ 100,00 | Usamos a reserva |
| 1001 Receivable Gateway | Diminui | R$ 100,00 | O gateway debitou R$ 100,00 da nossa conta para devolver ao comprador |

Ao final: todas as contas voltam ao estado anterior à captura. O ciclo está fechado.

---

### Estorno parcial (R$ 50,00)

**O que acontece:** o comprador pediu devolução de R$ 50,00 (metade do pedido). As mesmas proporções do split original são mantidas.

**Fase 1 — Reserva proporcional:**

| Conta | Saldo | Valor | Interpretação |
|---|---|---|---|
| 3001 Revenue Platform | Diminui | R$ 4,00 | 8% de R$ 50,00 — devolvemos nossa comissão proporcional |
| 2001 Payable Seller | Diminui | R$ 46,00 | 92% de R$ 50,00 — reduzimos o saldo do vendedor |
| 2002 Payable Refund | Aumenta | R$ 50,00 | Reservamos R$ 50,00 para o comprador |

**Fase 2 — Gateway confirma:**

| Conta | Saldo | Valor | Interpretação |
|---|---|---|---|
| 2002 Payable Refund | Diminui | R$ 50,00 | Usamos a reserva |
| 1001 Receivable Gateway | Diminui | R$ 50,00 | Gateway debitou R$ 50,00 para devolver ao comprador |

Após o estorno parcial, permanecem: R$ 4,00 de receita (comissão sobre os R$ 50,00 restantes) e R$ 46,00 de passivo com o vendedor.

---

### Chargeback perdido

**O que acontece:** o comprador abriu uma disputa de chargeback junto ao banco. A disputa foi julgada desfavoravelmente à plataforma. O banco debitou R$ 100,00 da conta da plataforma.

| Conta | Saldo | Valor | Interpretação |
|---|---|---|---|
| 4001 Expense Chargeback Loss | Aumenta | R$ 100,00 | Prejuízo total registrado — a plataforma absorve o valor inteiro |
| 1001 Receivable Gateway | Diminui | R$ 100,00 | O gateway debitou R$ 100,00 de volta (o dinheiro foi para o comprador) |

O vendedor não é debitado automaticamente. O saldo em `2001 Payable Seller` — caso o payout ainda não tenha ocorrido — permanece como passivo. A recuperação desse valor junto ao vendedor é um processo manual fora do escopo da automação atual.

---

## Regras fundamentais

**1. Imutabilidade:** nenhum lançamento contábil pode ser alterado ou deletado após criado. Erros são corrigidos com um novo lançamento de estorno (reversing entry) que anula o efeito do original, seguido de um lançamento correto.

**2. Contas fixas:** as 7 contas acima são as únicas reconhecidas pelo sistema. Nenhuma conta pode ser criada em tempo de execução. Qualquer adição ao plano de contas requer aprovação formal.

**3. Balanço obrigatório:** o banco de dados valida automaticamente, ao final de cada operação, que a soma de todas as entradas de um lançamento está zerada. Se um lançamento não fechar, a operação inteira é revertida — o sistema prefere falhar visivelmente a registrar um valor incorreto silenciosamente.

**4. Rastreabilidade total:** cada lançamento está vinculado ao evento de negócio que o originou (ID do pagamento, ID do evento de estorno, etc.) e ao timestamp de quando o evento aconteceu — não apenas de quando foi registrado. Isso permite reconstruir o histórico financeiro completo em qualquer ponto no tempo.
