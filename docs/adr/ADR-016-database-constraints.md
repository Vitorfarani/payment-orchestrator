# ADR-016: Banco de dados como segunda linha de defesa — constraints e triggers financeiros

## Metadados

| Campo | Valor |
|---|---|
| **ID** | ADR-016 |
| **Título** | Banco de dados como segunda linha de defesa — constraints e triggers financeiros |
| **Status** | `accepted` |
| **Data** | 2025-01-01 |
| **Contextos afetados** | LedgerContext, PaymentContext |
| **Depende de** | ADR-001 (Cents), ADR-010 (Chart of Accounts) |

---

## Contexto

A lógica de negócio deste sistema existe em duas camadas: na aplicação TypeScript (domínio + use cases) e potencialmente no banco de dados (constraints, triggers).

A posição default de muitos projetos modernos é confiar exclusivamente na aplicação: "o domínio valida tudo, o banco é só storage". Essa abordagem tem uma falha grave em sistemas financeiros: **o banco de dados pode ser acessado por múltiplos caminhos além da aplicação principal** — scripts de migração, jobs de correção, acesso direto de um DBA, outra versão da aplicação rodando simultaneamente durante um deploy.

Em todos esses cenários, a lógica da aplicação é bypassada. Se o banco não tem suas próprias garantias, dados inválidos entram silenciosamente.

O exemplo mais crítico é o Ledger com double-entry bookkeeping: se um `JournalEntry` for inserido com débitos que não batem com os créditos, o Ledger está corrompido. Isso não pode acontecer sob nenhuma circunstância — nem por bug na aplicação, nem por script manual, nem por deploy parcial.

---

## Decisão

O banco de dados atuará como **segunda linha de defesa**: a aplicação valida primeiro (via domínio e branded types), e o banco valida novamente com constraints e triggers. As duas camadas são independentes — a falha de uma não anula a outra.

**Camada 1 — aplicação:** Result Types, State Machine, Branded Types (ADR-014, ADR-015).
**Camada 2 — banco:** CHECK constraints, NOT NULL, UNIQUE, FOREIGN KEY, e um trigger específico para o invariante do Ledger.

A decisão é **deliberada e documentada**, não acidental. Adicionar lógica ao banco sem documentar cria confusão. Cada constraint e trigger tem um comentário explicando sua razão de existir.

---

## Alternativas consideradas

### Alternativa 1: Confiar exclusivamente na aplicação

Sem constraints além de NOT NULL e FK básicas. A aplicação é responsável por toda validação.

**Prós:** schema mais simples, sem lógica dividida entre app e banco, mais fácil de entender para devs que não dominam SQL avançado.
**Contras:** qualquer acesso direto ao banco (script, outro serviço, DBA) pode inserir dados inválidos. O Ledger pode ficar desbalanceado sem nenhum aviso. Em auditoria financeira, isso é inaceitável.
**Por que descartada:** o risco de corrupção silenciosa do Ledger é alto demais. Um `JournalEntry` desbalanceado que entra sem trigger de validação pode levar dias para ser detectado — e a reconciliação retroativa é extremamente complexa.

### Alternativa 2: Validação apenas via triggers (sem lógica no domínio)

Colocar toda a lógica de validação financeira no banco via triggers, removendo do domínio.

**Prós:** garantia centralizada no banco, funciona para qualquer cliente.
**Contras:** lógica de negócio em PL/pgSQL é difícil de testar, difícil de versionar, e ilegível para a maioria dos devs. Viola o princípio de Clean Architecture — o domínio deve ser a fonte de verdade das regras de negócio.
**Por que descartada:** inverte o problema. A lógica deve viver no domínio TypeScript (testável, versionável, legível) e o banco deve ser o guardião de último recurso.

---

## Consequências

### Positivas
- O Ledger tem uma garantia matemática de consistência — impossível inserir JournalEntry desbalanceada.
- Scripts de migração e jobs manuais são protegidos contra erros acidentais.
- Em auditoria, o banco pode ser inspecionado diretamente com confiança de que os dados são íntegros.
- Erros detectados pelo banco geram exceções claras (com mensagem do trigger) — fáceis de diagnosticar.

### Negativas / Trade-offs
- Lógica duplicada entre aplicação e banco — precisa ser mantida sincronizada.
- Triggers adicionam overhead em escritas (pequeno, mas mensurável em alto volume).
- Desenvolvedores precisam saber que o banco tem lógica — documentado aqui e no overview da arquitetura.

### Riscos e mitigações
- **Risco:** constraint ou trigger modificado no banco sem atualizar a lógica correspondente na aplicação.
  **Mitigação:** migrations são a única forma de alterar o schema. Qualquer mudança em constraint ou trigger passa pelo processo de PR e code review, igual ao código TypeScript.

- **Risco:** trigger de balanço causa falsos positivos durante migrations que inserem dados em múltiplos passos.
  **Mitigação:** o trigger valida o balanço **por `journal_entry_id`** — não por toda a tabela. Durante uma migration, se os dois lados de um journal entry são inseridos na mesma transação, o trigger só dispara no COMMIT.

---

## Implementação

```sql
-- === PAYMENTS ===

ALTER TABLE payments
  -- Valor sempre positivo e em centavos inteiros (aplicação já garante, banco confirma)
  ADD CONSTRAINT chk_payment_amount_positive
    CHECK (amount_cents > 0),

  -- Moedas suportadas (atualizar quando ADR de multi-moeda for criado)
  ADD CONSTRAINT chk_payment_currency_valid
    CHECK (currency IN ('BRL', 'USD')),

  -- Status deve ser um valor reconhecido pela state machine
  ADD CONSTRAINT chk_payment_status_valid
    CHECK (status IN (
      'PENDING', 'PROCESSING', 'REQUIRES_ACTION',
      'AUTHORIZED', 'CAPTURED', 'SETTLED',
      'REFUNDED', 'PARTIALLY_REFUNDED',
      'FAILED', 'CANCELLED',
      'DISPUTED', 'CHARGEBACK_WON', 'CHARGEBACK_LOST'
    ));

-- === LEDGER ENTRIES ===

ALTER TABLE ledger_entries
  -- Entradas do ledger nunca têm valor zero ou negativo
  ADD CONSTRAINT chk_ledger_entry_amount_positive
    CHECK (amount_cents > 0),

  -- Tipo deve ser DEBIT ou CREDIT — sem ambiguidade
  ADD CONSTRAINT chk_ledger_entry_type_valid
    CHECK (entry_type IN ('DEBIT', 'CREDIT'));

-- === TRIGGER: INVARIANTE DO DOUBLE-ENTRY ===
-- Garante que todo JournalEntry seja balanceado: sum(DEBIT) = sum(CREDIT)
-- Este é o invariante financeiro mais crítico do sistema.
-- Disparado AFTER INSERT em ledger_entries, por journal_entry_id.

CREATE OR REPLACE FUNCTION verify_journal_entry_balance()
RETURNS TRIGGER AS $$
DECLARE
  v_balance BIGINT;
BEGIN
  -- Calcula o balanço atual do JournalEntry que foi modificado
  -- DEBIT soma positivo, CREDIT soma negativo — resultado deve ser 0
  SELECT COALESCE(SUM(
    CASE entry_type
      WHEN 'DEBIT'  THEN  amount_cents
      WHEN 'CREDIT' THEN -amount_cents
    END
  ), 0)
  INTO v_balance
  FROM ledger_entries
  WHERE journal_entry_id = NEW.journal_entry_id;

  -- Se o balanço não for zero, o JournalEntry está incompleto ou incorreto
  IF v_balance != 0 THEN
    RAISE EXCEPTION
      'Journal entry % is unbalanced. Net balance: % cents. Debits must equal credits.',
      NEW.journal_entry_id,
      v_balance
    USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- O trigger dispara AFTER INSERT de cada linha do ledger_entries,
-- mas o check do balanço acontece por journal_entry_id — não por linha isolada.
-- Em uma transação que insere débito e crédito, o trigger valida no COMMIT.
-- Uma inserção parcial (só o débito) dentro de uma transação aberta não dispara o erro
-- até o COMMIT — o que é o comportamento correto para inserções em batch.
CREATE CONSTRAINT TRIGGER trg_verify_journal_balance
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED  -- valida no COMMIT, não em cada INSERT individual
  FOR EACH ROW
  EXECUTE FUNCTION verify_journal_entry_balance();

-- === SPLIT RULES ===

ALTER TABLE split_rules
  -- Commission rate entre 0% e 100% (0.0 a 1.0 como decimal)
  ADD CONSTRAINT chk_split_commission_rate_valid
    CHECK (commission_rate >= 0.0 AND commission_rate <= 1.0),

  -- Ao menos uma forma de comissão deve estar definida
  ADD CONSTRAINT chk_split_has_commission
    CHECK (commission_rate IS NOT NULL OR flat_fee_cents IS NOT NULL);
```

```typescript
// Como o domínio e o banco se complementam:

// Aplicação — primeira linha (valida antes de tentar inserir)
class JournalEntry {
  static create(entries: LedgerEntryProps[]): Result<JournalEntry, DomainError> {
    const debitTotal  = entries.filter(e => e.type === 'DEBIT').reduce((s, e) => s + e.amount, 0)
    const creditTotal = entries.filter(e => e.type === 'CREDIT').reduce((s, e) => s + e.amount, 0)

    if (debitTotal !== creditTotal) {
      return err(new BusinessRuleError(
        `Journal entry unbalanced: debits=${debitTotal} credits=${creditTotal}`
      ))
    }
    // ... cria o JournalEntry
    return ok(new JournalEntry(entries))
  }
}

// Banco — segunda linha (rejeita se a aplicação deixou passar)
// Se o trigger disparar, a exceção do PostgreSQL será capturada como
// erro de infraestrutura no use case — nunca chegará ao usuário como 500 silencioso.
// O logger registrará o erro com o journal_entry_id para investigação.
```

**Arquivos:**
- `src/infrastructure/database/migrations/003_ledger_constraints.ts`
- `src/infrastructure/database/migrations/004_journal_balance_trigger.ts`
- `src/infrastructure/database/migrations/005_payment_constraints.ts`
