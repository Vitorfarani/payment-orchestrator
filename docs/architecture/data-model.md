# Data Model — Payment Orchestrator

> ERD das 12 tabelas + 1 materialized view implementadas na Fase 3.
> Migrations em `src/infrastructure/database/migrations/`.

---

## Diagrama de entidades (ERD ASCII)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          WRITE MODEL (normalizado)                          │
└─────────────────────────────────────────────────────────────────────────────┘

 sellers                           payments
 ─────────────────────────         ─────────────────────────────────────────
 id             UUID  PK           id               UUID  PK
 name           TEXT  NN           seller_id        UUID  FK → sellers.id  [idx]
 document       TEXT  NN UNIQUE    amount_cents     BIGINT NN CHECK(>0)
 email          TEXT  NN UNIQUE    currency         TEXT  NN CHECK='BRL'
 bank_account   JSONB              status           TEXT  NN CHECK(13 estados)
 settlement_    TEXT  NN           idempotency_key  TEXT  NN UNIQUE
   schedule           CHECK(4)     gateway          TEXT  CHECK(STRIPE|ASAAS)
 status         TEXT  NN CHECK(3)  gateway_         TEXT
 created_at     TSTZ  NN             payment_id
 updated_at     TSTZ  NN           gateway_response JSONB     [idx partial]
 [trigger: set_updated_at]         metadata         JSONB
                 1                 error_code       TEXT
                 │                 error_message    TEXT
                 │ N               authorized_at    TSTZ
                 │                 captured_at      TSTZ
 split_rules     │                 refunded_at      TSTZ
 ──────────────  │                 failed_at        TSTZ
 id    UUID  PK  │                 created_at       TSTZ  NN
 seller_id  FK──►│                 updated_at       TSTZ  NN
 commission_     │                 [trigger: set_updated_at]
   rate DECIMAL  │                 [idx: seller_id, seller_id+status]
 flat_fee_ BIGINT│
   cents         │    1            journal_entries
 active   BOOL NN│    │            ───────────────────────────────
 created_at TSTZ │    │ N          id          UUID  PK
 updated_at TSTZ │    │            payment_id  UUID  FK → payments.id  [idx]
 [idx: seller_id,│    │            description TEXT  NN
       active]   │    │            occurred_at TSTZ  NN   ← quando aconteceu
                 │    │            created_at  TSTZ  NN   ← quando foi inserido
                 │    │
                 │    │ N          ledger_entries
                 │    │            ───────────────────────────────────────────
                 │    │            id               UUID  PK
                 │    └──────────► journal_entry_id UUID  FK [idx]
                 │                 account_code     TEXT  FK → accounts.code [idx]
                 │                 entry_type       TEXT  NN CHECK(DEBIT|CREDIT)
                 │                 amount_cents     BIGINT NN CHECK(>0)
                 │                 created_at       TSTZ  NN
                 │
                 │                 [CONSTRAINT TRIGGER: trg_verify_journal_balance]
                 │                 [DEFERRABLE INITIALLY DEFERRED]
                 │                 [valida: SUM(DEBIT) = SUM(CREDIT) no COMMIT]
                 │
                 │ N
 settlement_items│
 ────────────────┘
 id             UUID  PK
 payment_id     UUID  FK → payments.id   [idx]
 seller_id      UUID  FK → sellers.id    [idx]
 amount_cents   BIGINT NN CHECK(>0)
 scheduled_date DATE  NN
 status         TEXT  NN CHECK(4 estados)
 created_at     TSTZ  NN
 updated_at     TSTZ  NN
 [trigger: set_updated_at]
 [idx partial: scheduled_date WHERE status='PENDING']


 accounts                          payment_status_history
 ─────────────────────────         ─────────────────────────────────
 id    UUID  PK                    id          UUID  PK
 code  TEXT  NN UNIQUE (FK target) payment_id  UUID  FK → payments.id
 name  TEXT  NN                    from_status TEXT      ← NULL = inicial
 type  TEXT  NN CHECK(4 tipos)     to_status   TEXT  NN
 created_at TSTZ NN               occurred_at TSTZ  NN
                                   metadata    JSONB
 [SEED na migration 004]           [idx: payment_id + occurred_at]
 1001 Receivable Gateway  ASSET
 2001 Payable Seller       LIABILITY
 2002 Payable Refund       LIABILITY
 3001 Revenue Platform     REVENUE
 3002 Revenue Chargeback   REVENUE
 4001 Expense Chargeback   EXPENSE
 4002 Expense Gateway Fee  EXPENSE


 outbox_events                     idempotency_keys
 ─────────────────────────         ─────────────────────────────────
 id             UUID  PK           key          TEXT  PK (header value)
 event_type     TEXT  NN           response_body JSONB
 aggregate_type TEXT  NN           status_code  INT
 aggregate_id   UUID  NN           created_at   TSTZ  NN
 payload        JSONB NN           expires_at   TSTZ  NN
 processed      BOOL  NN DEF=false [idx: expires_at]
 retry_count    INT   NN DEF=0
 error          TEXT
 created_at     TSTZ  NN
 processed_at   TSTZ
 [idx partial: created_at WHERE processed=false]
 [idx: aggregate_type + aggregate_id]


 audit_logs
 ─────────────────────────────────────────────────────────
 id             UUID  PK
 occurred_at    TSTZ  NN DEF=now()
 actor_id       TEXT  NN
 actor_type     TEXT  NN CHECK(user|merchant|system|worker)
 actor_ip       INET
 action         TEXT  NN     ex: 'payment.created'
 resource_type  TEXT  NN     ex: 'Payment'
 resource_id    TEXT  NN
 request_id     TEXT
 trace_id       TEXT
 previous_state JSONB
 new_state      JSONB
 metadata       JSONB
 [IMUTÁVEL: REVOKE UPDATE, DELETE FROM payment_app_role — ADR-018]
 [idx: resource_type+resource_id, actor_id+occurred_at, occurred_at]
```

---

## Read Model — CQRS (ADR-007)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         READ MODEL (pré-agregado)                           │
└─────────────────────────────────────────────────────────────────────────────┘

 ledger_summary  (MATERIALIZED VIEW)
 ─────────────────────────────────────────────────────────────
 seller_id      UUID           grupo primário
 date           DATE           date_trunc('day', le.created_at)
 account_type   TEXT           ASSET | LIABILITY | REVENUE | EXPENSE
 account_code   TEXT           1001..4002
 total_debits   BIGINT         SUM(DEBIT)
 total_credits  BIGINT         SUM(CREDIT)
 entry_count    BIGINT         COUNT(*)

 [UNIQUE INDEX: seller_id + date + account_code]
 [Obrigatório para REFRESH MATERIALIZED VIEW CONCURRENTLY]
 [Atualizado pelo LedgerWorker após cada JournalEntry processada]
```

---

## Funções e triggers

| Nome | Tipo | Tabela | Comportamento |
|------|------|--------|---------------|
| `set_updated_at()` | FUNCTION + TRIGGER | sellers, payments, split_rules, settlement_items | BEFORE UPDATE: `NEW.updated_at = NOW()` |
| `verify_journal_entry_balance()` | FUNCTION + CONSTRAINT TRIGGER | ledger_entries | AFTER INSERT DEFERRABLE INITIALLY DEFERRED: valida `SUM(DEBIT) = SUM(CREDIT)` por `journal_entry_id` no COMMIT |

---

## Índices notáveis

| Índice | Tabela | Tipo | Motivo |
|--------|--------|------|--------|
| `idx_payments_seller_id` | payments | B-tree | FK — PostgreSQL não auto-indexa |
| `idx_payments_seller_status` | payments | B-tree composto | "pagamentos pendentes do seller X" |
| `idx_outbox_unprocessed` | outbox_events | Parcial `WHERE processed=false` | `SELECT FOR UPDATE SKIP LOCKED` do OutboxRelay |
| `idx_settlement_pending` | settlement_items | Parcial `WHERE status='PENDING'` | Batch job de settlement por data |
| `idx_ledger_summary` | ledger_summary | UNIQUE | Obrigatório para `REFRESH CONCURRENTLY` |
| `idx_audit_logs_resource` | audit_logs | B-tree composto | Auditoria por entidade |

> **Nota:** `CREATE INDEX CONCURRENTLY` não pode rodar dentro de transação. Todos os
> índices das migrations usam `CREATE INDEX` simples. O `CONCURRENTLY` só é usado
> nos `REFRESH MATERIALIZED VIEW` feitos em runtime pelo LedgerWorker.

---

## Decisões técnicas

| Decisão | ADR | Motivo |
|---------|-----|--------|
| `BIGINT` para `amount_cents` | ADR-001 | Zero erros de ponto flutuante |
| `TEXT + CHECK` em vez de ENUM | ADR-016 | `ALTER ENUM` exige recriação; TEXT é mais fácil de migrar |
| `DECIMAL(5,4)` para `commission_rate` | ADR-001 (exceção documentada) | Taxa é ratio, não valor monetário |
| Trigger DEFERRABLE INITIALLY DEFERRED | ADR-016 | Valida double-entry no COMMIT, não linha a linha |
| Seed das 7 contas na migration 004 | ADR-010 | Seed é parte do schema — não é dado de teste |
| `REVOKE UPDATE, DELETE` em audit_logs | ADR-018 | Imutabilidade garantida no nível do banco |
| `occurred_at` separado de `created_at` | ADR-010 | Suporte a entradas retroativas (estornos de datas passadas) |
| `aggregate_type` + `aggregate_id` em outbox | ADR-009 | OutboxRelay precisa rotear para o handler correto |
