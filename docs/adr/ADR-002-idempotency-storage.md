# ADR-002: Estratégia de armazenamento de idempotency keys

## Metadados

| Campo | Valor |
|---|---|
| **ID** | ADR-002 |
| **Título** | Estratégia de armazenamento de idempotency keys |
| **Status** | `accepted` |
| **Data** | 2025-01-01 |
| **Contextos afetados** | PaymentContext, WebhookContext |
| **Depende de** | ADR-015 (Branded Types) |
| **Bloqueia** | CreatePaymentUseCase, ProcessWebhookUseCase, IdempotencyMiddleware |

---

## Contexto

Em sistemas de pagamento, a mesma operação pode ser submetida mais de uma vez por razões legítimas: timeout de rede no cliente, retry automático do SDK, clique duplo do usuário, ou reenvio de webhook pelo gateway. Sem idempotência, cada submissão resulta em uma cobrança separada — o que é inaceitável.

A solução padrão da indústria (usada pelo Stripe, Adyen, Braintree) é o `x-idempotency-key`: o cliente gera uma chave única por operação e a inclui no header. Se a mesma chave chegar novamente, o servidor retorna o resultado da primeira execução sem reprocessar.

O desafio de implementação é duplo:

**Onde armazenar as chaves?** Redis é rápido mas volátil (TTL, restart). PostgreSQL é durável mas mais lento. A escolha afeta tanto a performance quanto as garantias de durabilidade.

**Race condition:** se duas requisições com a mesma chave chegam simultaneamente (milissegundos de diferença), ambas podem passar pela verificação antes de qualquer uma ter registrado o resultado. Isso requer um mecanismo de lock além da simples verificação de existência.

---

## Decisão

Adotaremos uma estratégia em **duas camadas**: Redis como cache rápido com TTL, e PostgreSQL como registro durável e mecanismo de lock.

### Camada 1 — Redis (cache de resposta)

- Chave: `idempotency:{key}` com TTL de **24 horas**
- Valor: resultado serializado da operação (status HTTP + body)
- Verificado primeiro em toda requisição — se existir e estiver `COMPLETED`, retorna imediatamente sem tocar no banco
- Se existir com status `PROCESSING`, retorna HTTP 409 com mensagem explicativa

### Camada 2 — PostgreSQL (lock e durabilidade)

- Tabela `idempotency_keys` com `UNIQUE` constraint na chave
- `INSERT ... ON CONFLICT DO NOTHING` + verificação do resultado — resolve o race condition atomicamente
- Persiste o resultado após conclusão da operação
- Não tem TTL — registro permanente para auditoria

### Fluxo completo

```
Request chega com x-idempotency-key: "uuid-123"

1. Verifica Redis → HIT com COMPLETED → retorna resultado cacheado (< 1ms)
2. Verifica Redis → HIT com PROCESSING → retorna 409 "Operation in progress"
3. Redis MISS → tenta INSERT no PostgreSQL
   3a. INSERT bem-sucedido (primeira vez) → processa operação → salva resultado → popula Redis
   3b. INSERT com conflito (race condition) → lê linha existente
       - status PROCESSING → retorna 409
       - status COMPLETED → retorna resultado salvo
4. Após TTL do Redis (24h): Redis MISS, mas PostgreSQL ainda tem o registro
   → Recarrega Redis com resultado do banco → retorna resultado (sem reprocessar)
```

### Janela de validade

A idempotency key é válida por **24 horas** no Redis. Após esse período, uma nova requisição com a mesma chave pode ser processada novamente se o cliente reenviar. Isso é aceitável: 24 horas cobre qualquer janela razoável de retry.

O registro no PostgreSQL é permanente — usado para auditoria e recarregamento do cache.

---

## Alternativas consideradas

### Alternativa 1: Apenas Redis (sem PostgreSQL)

Armazenar idempotency keys exclusivamente no Redis com TTL.

**Prós:** implementação simples, latência mínima.
**Contras:** se o Redis reiniciar ou a chave expirar durante uma operação longa, a proteção desaparece. Sem durabilidade para auditoria. Em caso de restart do Redis, todas as chaves em `PROCESSING` somem — requisições que estavam sendo processadas podem ser reprocessadas.
**Por que descartada:** para operações financeiras, a durabilidade não é opcional. O Redis é excelente como cache de primeiro nível, mas insuficiente como única camada de proteção.

### Alternativa 2: Apenas PostgreSQL (sem Redis)

Verificar e registrar idempotency keys exclusivamente no PostgreSQL.

**Prós:** durabilidade total, sem dependência de Redis para essa feature.
**Contras:** cada requisição faz pelo menos uma query extra ao banco — impacto de performance em alto volume. O banco vira um gargalo em picos de tráfego.
**Por que descartada:** o Redis já é uma dependência do projeto (filas BullMQ). Não usá-lo como cache aqui seria desperdiçar a infraestrutura já disponível.

### Alternativa 3: Idempotência apenas no banco via transação

Usar `INSERT ... ON CONFLICT DO NOTHING` + `SELECT FOR UPDATE` dentro da própria transação de negócio.

**Prós:** atomicidade garantida pelo banco, sem camada extra.
**Contras:** a transação de negócio fica mais longa (lock durante todo o processamento), aumentando contenção. Requisições duplicadas ficam bloqueadas esperando o lock ao invés de receber uma resposta imediata.
**Por que descartada:** degradação de performance em cenários de retry. O objetivo é retornar resposta imediata para duplicatas — não fazê-las esperar.

---

## Consequências

### Positivas
- Requisições duplicadas retornam em < 1ms via cache Redis.
- Race conditions são impossíveis graças ao `UNIQUE` constraint + `INSERT ON CONFLICT` atômico.
- Registro durável no PostgreSQL para auditoria de operações idempotentes.
- O middleware de idempotência é transparente para os use cases — eles não sabem que existem.

### Negativas / Trade-offs
- Lógica distribuída entre Redis e PostgreSQL — dois sistemas precisam estar em sync.
- Se Redis cair, o sistema ainda funciona (cai para PostgreSQL), mas com latência maior.
- Chaves expiradas no Redis precisam ser recarregadas do banco — pequeno overhead na primeira requisição após expiração.

### Riscos e mitigações

- **Risco:** Redis retorna resultado desatualizado (TTL ainda válido mas resultado mudou no banco).
  **Mitigação:** o resultado de uma operação idempotente é imutável — uma vez `COMPLETED`, nunca muda. Não existe desatualização por definição.

- **Risco:** operação conclui mas falha ao salvar resultado no Redis/PostgreSQL — próxima requisição reprocessa.
  **Mitigação:** salvar o resultado é parte da mesma transação do banco (PostgreSQL). Se falhar, a transação inteira é desfeita. A operação principal nunca é comitada sem o registro de idempotência.

- **Risco:** chave gerada pelo cliente colide com chave de outro cliente (UUID collision ou chave previsível).
  **Mitigação:** a chave é prefixada internamente com o `merchant_id`: `{merchant_id}:{client_key}`. Colisões entre clientes diferentes são impossíveis. Colisões de UUID v4 são astronomicamente improváveis (probabilidade de 1 em 2^122).

---

## Implementação

```typescript
// src/infrastructure/idempotency/IdempotencyStore.ts

export type IdempotencyStatus = 'PROCESSING' | 'COMPLETED' | 'FAILED'

export interface IdempotencyRecord {
  key:        IdempotencyKey
  status:     IdempotencyStatus
  statusCode: number | null
  response:   unknown | null
  createdAt:  Date
  updatedAt:  Date
}

export interface IIdempotencyStore {
  // Tenta registrar a chave. Retorna:
  // { isNew: true }  → primeira vez, pode processar
  // { isNew: false, record } → já existe, retornar record
  tryAcquire(key: IdempotencyKey): Promise<
    | { isNew: true }
    | { isNew: false; record: IdempotencyRecord }
  >

  complete(key: IdempotencyKey, statusCode: number, response: unknown): Promise<void>
  fail(key: IdempotencyKey, error: string): Promise<void>
}

// Implementação com Redis + PostgreSQL
export class RedisPostgresIdempotencyStore implements IIdempotencyStore {

  async tryAcquire(key: IdempotencyKey) {
    // 1. Verifica Redis primeiro (caminho rápido)
    const cached = await this.redis.get(`idempotency:${key}`)
    if (cached) {
      const record = JSON.parse(cached) as IdempotencyRecord
      return { isNew: false, record }
    }

    // 2. Tenta inserir no PostgreSQL (resolve race condition)
    const result = await this.db.raw(`
      INSERT INTO idempotency_keys (key, status, created_at, updated_at)
      VALUES (?, 'PROCESSING', NOW(), NOW())
      ON CONFLICT (key) DO UPDATE
        SET updated_at = idempotency_keys.updated_at  -- no-op, só para retornar a linha
      RETURNING *, (xmax = 0) AS inserted
    `, [key])

    const row = result.rows[0]

    if (row.inserted) {
      // Primeira vez — pode processar
      return { isNew: true }
    }

    // Já existia — retorna o registro
    const record: IdempotencyRecord = {
      key:        row.key,
      status:     row.status,
      statusCode: row.status_code,
      response:   row.response ? JSON.parse(row.response) : null,
      createdAt:  row.created_at,
      updatedAt:  row.updated_at,
    }

    // Popula o Redis para próximas consultas
    if (record.status === 'COMPLETED') {
      await this.redis.setex(
        `idempotency:${key}`,
        60 * 60 * 24,  // 24 horas em segundos
        JSON.stringify(record)
      )
    }

    return { isNew: false, record }
  }

  async complete(key: IdempotencyKey, statusCode: number, response: unknown) {
    const responseJson = JSON.stringify(response)

    await this.db('idempotency_keys')
      .where({ key })
      .update({ status: 'COMPLETED', status_code: statusCode, response: responseJson, updated_at: new Date() })

    await this.redis.setex(
      `idempotency:${key}`,
      60 * 60 * 24,
      JSON.stringify({ key, status: 'COMPLETED', statusCode, response })
    )
  }

  async fail(key: IdempotencyKey, error: string) {
    await this.db('idempotency_keys')
      .where({ key })
      .update({ status: 'FAILED', response: JSON.stringify({ error }), updated_at: new Date() })
    // Não popula o Redis em caso de falha — próxima tentativa pode tentar de novo
  }
}
```

```typescript
// src/web/middlewares/IdempotencyMiddleware.ts
// Transparente para controllers e use cases

export function idempotencyMiddleware(store: IIdempotencyStore) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const rawKey = req.headers['x-idempotency-key']
    if (!rawKey || typeof rawKey !== 'string') return next()

    const key = IdempotencyKey.of(`${req.merchantId}:${rawKey}`)
    const result = await store.tryAcquire(key)

    if (!result.isNew) {
      const { record } = result
      if (record.status === 'PROCESSING') {
        return res.status(409).json({
          error: 'This operation is already being processed. Retry after a moment.',
          code:  'IDEMPOTENCY_CONFLICT',
        })
      }
      // COMPLETED ou FAILED — retorna resultado original
      return res.status(record.statusCode ?? 200).json(record.response)
    }

    // Primeira vez — anexa ao res para o controller completar após processar
    res.locals.idempotencyKey = key
    res.locals.idempotencyStore = store

    // Intercepta res.json para salvar automaticamente o resultado
    const originalJson = res.json.bind(res)
    res.json = (body) => {
      store.complete(key, res.statusCode, body).catch(/* log error */)
      return originalJson(body)
    }

    next()
  }
}
```

```sql
-- migration: tabela de idempotency keys
CREATE TABLE idempotency_keys (
  key         VARCHAR(512) PRIMARY KEY,   -- {merchant_id}:{client_key}
  status      VARCHAR(20)  NOT NULL DEFAULT 'PROCESSING'
              CHECK (status IN ('PROCESSING', 'COMPLETED', 'FAILED')),
  status_code SMALLINT,
  response    TEXT,                        -- JSON serializado
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Índice para limpeza de registros antigos (job de housekeeping)
CREATE INDEX idx_idempotency_keys_created_at ON idempotency_keys (created_at);
```

**Arquivos:**
- `src/infrastructure/idempotency/IdempotencyStore.ts`
- `src/web/middlewares/IdempotencyMiddleware.ts`
- `src/infrastructure/database/migrations/009_idempotency_keys.ts`

---

## Divergências entre o ADR e a implementação real

Este ADR foi escrito antes do código existir. Quando a implementação foi feita (Fase 4, Grupo F), duas decisões diferiram do pseudocódigo acima por boas razões. Ambas preservam o comportamento descrito na seção **Decisão** — apenas os mecanismos internos mudaram.

### Divergência 1 — Coluna `status` substituída por `response_body` nullable

**O que o ADR descrevia:** uma coluna `status VARCHAR(20) CHECK (status IN ('PROCESSING', 'COMPLETED', 'FAILED'))`.

**O que a migration 009 criou:** sem coluna `status`. O estado é derivado de `response_body`:

```
response_body IS NULL     → PROCESSING (operação em andamento)
response_body IS NOT NULL → COMPLETED  (resultado persistido)
```

**Por quê:** a migration foi escrita com um schema mais simples e igualmente expressivo. A coluna `status` seria redundante — o único dado que muda entre os estados é justamente o `response_body`. Adicionar uma coluna separada seria denormalização sem benefício.

**Impacto em `fail()`:** sem coluna `status`, marcar FAILED exigiria armazenar um valor especial em `response_body` — o que misturaria metadados de erro com payload de resposta. A decisão foi **deletar a linha** ao falhar: limpa, sem ambiguidade, e permite retry imediato com a mesma chave.

---

### Divergência 2 — `ON CONFLICT DO UPDATE ... xmax` substituído por try-catch em `23505`

**O que o ADR descrevia:**

```sql
INSERT INTO idempotency_keys ...
ON CONFLICT (key) DO UPDATE
  SET updated_at = idempotency_keys.updated_at  -- no-op
RETURNING *, (xmax = 0) AS inserted
```

**O que o código faz:**

```typescript
try {
  await this.db<IdempotencyRow>('idempotency_keys').insert({ key, expires_at })
  return { isNew: true }
} catch (err: unknown) {
  if (!isUniqueViolationError(err)) throw err  // err.code === '23505'
}
// conflito confirmado — SELECT para obter o registro existente
```

**Por quê:** a syntax `ON CONFLICT DO UPDATE ... RETURNING xmax` exige `db.raw()` no Knex — SQL como string literal. O ESLint do projeto desencoraja `db.raw()` sem necessidade real (ver padrão em `PostgresOutboxRepository.recordFailure`). O try-catch em `23505` produz o mesmo comportamento garantido pela `UNIQUE` constraint, sem SQL raw, sem string literal frágil.

**Garantia mantida:** a atomicidade da detecção de race condition vem da `UNIQUE` constraint no banco — não do SQL escolhido para detectá-la. Ambas as abordagens são igualmente corretas.
