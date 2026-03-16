# ADR-018: Audit Log — estrutura, imutabilidade e retenção

## Metadados

| Campo | Valor |
|---|---|
| **ID** | ADR-018 |
| **Título** | Audit Log — estrutura, imutabilidade e retenção |
| **Status** | `accepted` |
| **Data** | 2025-01-01 |
| **Contextos afetados** | Todos (ações sensíveis de qualquer contexto) |
| **Depende de** | ADR-017 (Observabilidade), ADR-015 (Branded Types) |
| **Bloqueia** | Implementação de qualquer use case que envolva ação sensível |

---

## Contexto

Logs de observabilidade (ADR-017) respondem perguntas operacionais: "o que aconteceu tecnicamente?". Audit logs respondem perguntas diferentes: "quem fez o quê, quando, e em qual recurso?".

Em Fintech, audit logs são necessários por múltiplas razões:

**Regulatório:** o Banco Central do Brasil (através das normas do PIX e do Marco Legal das Fintechs) e a LGPD exigem rastreabilidade de acesso e modificação de dados financeiros e pessoais. Sem audit log, uma auditoria regulatória pode resultar em multa ou suspensão de operação.

**Segurança:** quando ocorre uma fraude interna (funcionário que acessa dados indevidos, modifica comissões, ou cancela pagamentos indevidamente), o audit log é a única fonte de evidência forense.

**Suporte:** quando um vendedor contesta "quem cancelou meu pagamento?" ou "quem mudou minha taxa de comissão?", a resposta está no audit log — não nos logs operacionais, que são muito ruidosos para investigação de negócio.

A diferença crítica entre audit log e log operacional: **o audit log não pode ser alterado ou deletado** — nem por administradores do sistema. Qualquer registro de auditoria deve ser imutável após criado.

---

## Decisão

Implementaremos um audit log dedicado com as seguintes características:

### O que é auditado (ações sensíveis)

```typescript
export type AuditAction =
  // Pagamentos
  | 'payment.created'
  | 'payment.captured'
  | 'payment.cancelled'
  | 'payment.refunded'
  | 'payment.disputed'

  // Configuração financeira (alto risco — mudança tem impacto financeiro direto)
  | 'split_rule.created'
  | 'split_rule.updated'
  | 'split_rule.deleted'

  // Vendedores
  | 'seller.created'
  | 'seller.bank_account_updated'
  | 'seller.suspended'
  | 'seller.settlement_schedule_changed'

  // Administração
  | 'admin.payment_status_forced'     // correção manual de status (runbook)
  | 'admin.ledger_entry_reversed'     // estorno manual de entrada contábil
  | 'admin.job_reprocessed'           // reprocessamento manual de job da DLQ

  // Acesso a dados sensíveis
  | 'seller.pii_accessed'             // acesso a CPF, dados bancários
  | 'payment.full_details_accessed'   // acesso a dados completos de pagamento
```

### Estrutura do registro de auditoria

```typescript
interface AuditRecord {
  // Identidade do evento
  id:         string          // UUID imutável
  occurredAt: Date            // quando aconteceu (UTC)

  // Quem fez
  actorId:    string          // user_id, merchant_id, ou 'system' para ações automáticas
  actorType:  'user' | 'merchant' | 'system' | 'worker'
  actorIp:    string | null   // IP de origem (null para ações de sistema)

  // O quê
  action:     AuditAction     // ação realizada
  resourceType: string        // ex: 'Payment', 'SplitRule', 'Seller'
  resourceId:   string        // ID do recurso afetado

  // Contexto
  requestId:  string | null   // X-Request-ID do request HTTP de origem
  traceId:    string | null   // OpenTelemetry trace ID

  // Dados (o antes e o depois — apenas campos relevantes, sem dados sensíveis)
  previousState: Record<string, unknown> | null
  newState:      Record<string, unknown> | null

  // Metadados adicionais
  metadata:   Record<string, unknown> | null
}
```

### Imutabilidade — como é garantida

**Nível de banco:** a tabela `audit_logs` tem apenas `INSERT` permitido. Sem `UPDATE`, sem `DELETE`. Isso é garantido por:

1. A role PostgreSQL usada pela aplicação (`payment_app_role`) tem apenas `INSERT` e `SELECT` na tabela `audit_logs` — sem `UPDATE`, sem `DELETE`.
2. Uma role separada (`audit_readonly_role`) tem apenas `SELECT` — usada por ferramentas de auditoria externas.
3. Nenhuma migration pode adicionar `UPDATE` ou `DELETE` sem passar por revisão explícita — documentado no processo de PR.

**Nível de aplicação:** `AuditLogger` expõe apenas o método `log()` — sem `update()` ou `delete()`. O domínio não tem como modificar um registro existente.

### Retenção

- Registros de auditoria são mantidos por **7 anos** (exigência do Banco Central para registros financeiros).
- Após 7 anos, podem ser arquivados em storage frio (S3 Glacier ou equivalente) antes da exclusão.
- **Nunca deletados** durante o período de retenção ativo — nem por scripts, nem por migrations, nem por limpeza automática.

### Separação de concerns: audit log ≠ log operacional

| | Audit Log | Log Operacional (Pino) |
|---|---|---|
| Propósito | Rastreabilidade de negócio | Debugging técnico |
| Imutável | Sim | Não |
| Retenção | 7 anos | 30-90 dias |
| Quem lê | Auditores, compliance, suporte | Engenheiros |
| Storage | PostgreSQL (tabela dedicada) | Stdout / sistema de logs |
| Conteúdo | Ações de negócio com contexto | Eventos técnicos com stack trace |

---

## Alternativas consideradas

### Alternativa 1: Usar os logs operacionais (Pino) como audit log

Adicionar campos de auditoria aos logs estruturados existentes e filtrá-los quando necessário.

**Prós:** sem infraestrutura adicional, sem nova tabela.
**Contras:** logs operacionais não são imutáveis — podem ser rotacionados, deletados, ou modificados. Não atendem requisitos regulatórios de imutabilidade. Mistura eventos técnicos com eventos de negócio, dificultando consultas de auditoria.
**Por que descartada:** regulatoriamente inadequado. Audit log em Fintech precisa de garantias de imutabilidade que logs operacionais não oferecem.

### Alternativa 2: Serviço externo de auditoria (AWS CloudTrail, Datadog Audit)

Usar um serviço SaaS dedicado para audit log.

**Prós:** imutabilidade garantida pelo provedor, sem manutenção de infraestrutura.
**Contras:** custo adicional, dados de auditoria saindo da infraestrutura controlada, lock-in de vendor.
**Por que descartada:** para um portfólio v1, a implementação local demonstra mais domínio técnico e não tem custo operacional. Em produção real com requisitos regulatórios severos, um serviço externo seria considerado.

### Alternativa 3: Tabela com triggers automáticos (CDC interno)

Usar triggers PostgreSQL para capturar automaticamente toda mudança em tabelas críticas.

**Prós:** cobertura automática — nenhum desenvolvedor esquece de auditar uma mudança.
**Contras:** captura tudo indiscriminadamente, sem contexto de negócio (quem fez, por qual motivo). Um `UPDATE` na tabela `payments` pelo trigger não sabe se foi um usuário, um worker, ou uma migration.
**Por que descartada:** audit log precisa de contexto de negócio que só existe na camada de aplicação. Triggers capturam o "o quê" mas não o "quem" e "por quê". Complementar, não substituto.

---

## Consequências

### Positivas
- Rastreabilidade completa de todas as ações sensíveis — "quem cancelou este pagamento?" tem resposta em segundos.
- Imutabilidade garantida em dois níveis (banco + aplicação) — evidência forense confiável.
- Separação clara entre auditoria e observabilidade — cada um no seu lugar.
- Atende requisitos regulatórios de rastreabilidade financeira (LGPD, normas BCB).

### Negativas / Trade-offs
- Escrita extra em cada operação sensível — overhead pequeno mas mensurável em alto volume.
- A tabela `audit_logs` cresce indefinidamente (sem DELETE) — planejamento de storage necessário. Estimativa: ~500 bytes por registro × 1M operações/mês = ~500MB/mês.
- Desenvolvedores precisam lembrar de chamar `auditLogger.log()` em cada use case sensível — sem automação garante cobertura total.

### Riscos e mitigações

- **Risco:** desenvolvedor implementa use case sensível sem adicionar audit log.
  **Mitigação:** checklist de code review inclui "este use case precisa de audit log?". Testes de integração verificam que `audit_logs` tem registro após operações sensíveis.

- **Risco:** `previousState` ou `newState` contém dados sensíveis (CPF, número de cartão).
  **Mitigação:** `AuditLogger` aplica as mesmas máscaras do ADR-019 antes de persistir os estados. Dados sensíveis nunca aparecem no audit log.

---

## Implementação

```typescript
// src/infrastructure/audit/AuditLogger.ts

export class AuditLogger {
  constructor(
    private readonly db: Knex,
    private readonly sensitiveDataMasker: SensitiveDataMasker  // ADR-019
  ) {}

  async log(entry: Omit<AuditRecord, 'id' | 'occurredAt'>): Promise<void> {
    // Mascara dados sensíveis antes de persistir (ADR-019)
    const safeEntry = {
      ...entry,
      previousState: entry.previousState
        ? this.sensitiveDataMasker.mask(entry.previousState)
        : null,
      newState: entry.newState
        ? this.sensitiveDataMasker.mask(entry.newState)
        : null,
    }

    // INSERT apenas — nunca UPDATE ou DELETE
    await this.db('audit_logs').insert({
      id:             randomUUID(),
      occurred_at:    new Date(),
      actor_id:       safeEntry.actorId,
      actor_type:     safeEntry.actorType,
      actor_ip:       safeEntry.actorIp,
      action:         safeEntry.action,
      resource_type:  safeEntry.resourceType,
      resource_id:    safeEntry.resourceId,
      request_id:     safeEntry.requestId,
      trace_id:       safeEntry.traceId,
      previous_state: safeEntry.previousState
        ? JSON.stringify(safeEntry.previousState)
        : null,
      new_state: safeEntry.newState
        ? JSON.stringify(safeEntry.newState)
        : null,
      metadata: safeEntry.metadata
        ? JSON.stringify(safeEntry.metadata)
        : null,
    })
  }
}
```

```typescript
// Exemplo de uso em um use case sensível
class RefundPaymentUseCase {
  async execute(input: RefundInput): Promise<Result<void>> {
    // ... lógica de estorno ...

    // Audit log: sempre após a operação bem-sucedida
    await this.auditLogger.log({
      actorId:       input.requestedBy,
      actorType:     'user',
      actorIp:       input.requestIp,
      action:        'payment.refunded',
      resourceType:  'Payment',
      resourceId:    input.paymentId,
      requestId:     input.requestId,
      traceId:       getCurrentTraceId(),
      previousState: { status: 'CAPTURED', amount: payment.amount },
      newState:      { status: 'REFUNDED', refundAmount: input.refundAmount },
      metadata:      { reason: input.reason },
    })

    return ok(undefined)
  }
}
```

```sql
-- migration: tabela audit_logs (append-only)
CREATE TABLE audit_logs (
  id             UUID         PRIMARY KEY,
  occurred_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  actor_id       VARCHAR(255) NOT NULL,
  actor_type     VARCHAR(50)  NOT NULL CHECK (actor_type IN ('user','merchant','system','worker')),
  actor_ip       INET,
  action         VARCHAR(100) NOT NULL,
  resource_type  VARCHAR(100) NOT NULL,
  resource_id    VARCHAR(255) NOT NULL,
  request_id     VARCHAR(255),
  trace_id       VARCHAR(255),
  previous_state JSONB,
  new_state      JSONB,
  metadata       JSONB
);

-- Índices para queries de auditoria (sem degradar writes)
CREATE INDEX idx_audit_resource   ON audit_logs (resource_type, resource_id, occurred_at DESC);
CREATE INDEX idx_audit_actor      ON audit_logs (actor_id, occurred_at DESC);
CREATE INDEX idx_audit_action     ON audit_logs (action, occurred_at DESC);

-- Role da aplicação: apenas INSERT e SELECT
-- (executado como superuser na migration de setup)
REVOKE UPDATE, DELETE ON audit_logs FROM payment_app_role;
```

**Arquivos:**
- `src/infrastructure/audit/AuditLogger.ts`
- `src/infrastructure/audit/AuditAction.ts`
- `src/infrastructure/database/migrations/011_audit_logs.ts`
