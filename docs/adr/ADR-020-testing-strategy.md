# ADR-020: Estratégia de testes — pirâmide, ferramentas e quality gates

## Metadados

| Campo | Valor |
|---|---|
| **ID** | ADR-020 |
| **Título** | Estratégia de testes — pirâmide, ferramentas e quality gates |
| **Status** | `accepted` |
| **Data** | 2025-01-01 |
| **Contextos afetados** | Todos |
| **Depende de** | ADR-014 (Result Type), ADR-015 (Branded Types), ADR-017 (Observabilidade) |
| **Bloqueia** | Configuração do Jest, CI/CD pipeline, Testcontainers setup |

---

## Contexto

Sistemas financeiros têm um custo de bug em produção muito maior que sistemas comuns. Um bug no `SplitCalculator` pode resultar em comissões incorretas para milhares de transações antes de ser detectado. Um bug no `LedgerWorker` pode criar entradas desbalanceadas que só aparecem na auditoria semestral.

O problema não é *ter* testes — é ter a *estratégia correta* de testes. Projetos com estratégia ruim têm:
- 90% de testes unitários que mockam tudo e não detectam problemas reais de integração
- Zero testes de contrato — uma mudança na API do Stripe quebra produção na sexta à noite
- Testes de integração que dependem de banco em memória (H2, SQLite) e não testam comportamentos específicos do PostgreSQL (constraints, triggers, tipos)
- Coverage como métrica de vaidade — 90% de cobertura com testes que não assertam nada

A estratégia de testes precisa ser uma decisão de engenharia, não uma consequência acidental de "escrevemos alguns testes".

---

## Decisão

Adotaremos a pirâmide de testes com **quatro camadas** e quality gates não-negociáveis no CI.

### A pirâmide

```
              ┌─────────────────┐
              │    E2E Tests    │  ← Poucos. Fluxos críticos completos.
              │   (Supertest)   │     ~5-10 cenários
              └────────┬────────┘
           ┌───────────┴────────────┐
           │   Contract Tests       │  ← Médios. API do gateway externo.
           │      (Pact)            │     1 por endpoint consumido
           └───────────┬────────────┘
      ┌────────────────┴──────────────────┐
      │      Integration Tests            │  ← Médios. Banco real, Redis real.
      │   (Jest + Testcontainers)         │     Repositories, workers, relay
      └────────────────┬──────────────────┘
┌────────────────────────────────────────────────┐
│               Unit Tests (TDD)                 │  ← Maioria. Domínio puro.
│                  (Jest)                        │     Entities, use cases, calculators
└────────────────────────────────────────────────┘
```

---

### Camada 1 — Unit Tests (base da pirâmide)

**O que testam:** lógica de domínio pura — entidades, value objects, use cases, calculators. Zero dependências externas, zero I/O.

**Ferramenta:** Jest com TypeScript (ts-jest).

**Princípio:** seguem TDD — o teste é escrito antes da implementação. O ciclo Red → Green → Refactor é obrigatório para todo código de domínio novo.

**O que NÃO mockamos em unit tests:**
- Domínio interno (entidades, value objects) — testamos as implementações reais
- `SplitCalculator`, `SettlementScheduler`, state machine — testamos diretamente

**O que mockamos em unit tests:**
- Repositories (interfaces de infraestrutura)
- Adapters de gateway
- Logger, métricas

**Cobertura mínima obrigatória (quality gate no CI):**

```
src/domain/**         → 90% lines, 85% branches
src/application/**    → 85% lines, 80% branches
src/infrastructure/** → 60% lines (coberto principalmente por integration tests)
src/web/**            → 70% lines
```

**Casos obrigatórios para cada área:**

```typescript
// SplitCalculator — edge cases financeiros críticos
describe('SplitCalculator', () => {
  it('floor para plataforma, resto para vendedor (ADR-005)')
  it('split de valor que não divide exatamente')
  it('multi-split: soma sempre iguala o total')
  it('rejeita total zero ou negativo')
  it('rejeita taxa fora de 0..1')
  it('invariante: platform + seller === total — sempre')
})

// Payment state machine — transições
describe('Payment.transition()', () => {
  it('permite transições válidas do mapa VALID_TRANSITIONS')
  it('rejeita transições inválidas com BusinessRuleError')
  it('estados terminais não aceitam nenhuma transição')
  it('cada transição válida dispara o domain event correto')
  it('assertNever cobre todos os estados — cobertura de branches')
})

// Idempotência — comportamento sob duplicata
describe('CreatePaymentUseCase', () => {
  it('cria payment e outbox event na mesma transação')
  it('retorna resultado cacheado para chave já processada')
  it('retorna 409 para chave em PROCESSING')
  it('resultado: platform + seller === total (invariante do split)')
})
```

---

### Camada 2 — Integration Tests com Testcontainers

**O que testam:** a interação real entre a aplicação e suas dependências — PostgreSQL real, Redis real. Repositories, workers, OutboxRelay, triggers do banco, constraints.

**Por que Testcontainers e não mocks do banco?**

Mocks de banco mentem. Um `MockPaymentRepository` não testa:
- Se a query SQL está correta
- Se o índice está sendo usado
- Se o trigger de double-entry rejeita entradas desbalanceadas
- Se o `UNIQUE` constraint de idempotência funciona sob race condition
- Se o `SELECT FOR UPDATE SKIP LOCKED` do OutboxRelay funciona corretamente

Testcontainers sobe um PostgreSQL e Redis Docker reais, roda as migrations, e destrói tudo ao final. São testes mais lentos (~2-5s por suite) mas que testam o que realmente importa.

**Setup:**

```typescript
// tests/integration/setup.ts
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { RedisContainer, StartedRedisContainer }            from '@testcontainers/redis'

let pgContainer:    StartedPostgreSqlContainer
let redisContainer: StartedRedisContainer

beforeAll(async () => {
  pgContainer    = await new PostgreSqlContainer('postgres:16').start()
  redisContainer = await new RedisContainer('redis:7').start()

  const db = createKnexConnection(pgContainer.getConnectionUri())
  await db.migrate.latest()   // roda todas as migrations — banco idêntico ao de produção
  await db.seed.run()         // seed de contas do Chart of Accounts (ADR-010)
}, 60_000) // timeout generoso para pull da imagem Docker

afterAll(async () => {
  await pgContainer.stop()
  await redisContainer.stop()
})
```

**O que cada suite de integração testa:**

```typescript
// PostgresPaymentRepository
describe('PostgresPaymentRepository (integration)', () => {
  it('salva e recupera payment com todos os campos')
  it('findByIdForUpdate adquire lock — segundo SELECT aguarda')
  it('CHECK constraint rejeita amount_cents <= 0')
  it('CHECK constraint rejeita status inválido')
  it('UNIQUE constraint em idempotency_key')
})

// Trigger de double-entry (ADR-016) — o mais crítico
describe('Ledger double-entry trigger (integration)', () => {
  it('aceita journal entry balanceada (débitos = créditos)')
  it('REJEITA journal entry desbalanceada com exceção clara')
  it('aceita inserção em batch dentro da mesma transação')
  it('REJEITA inserção parcial após commit')
})

// OutboxRelay
describe('OutboxRelay (integration)', () => {
  it('publica eventos não processados no BullMQ')
  it('marca eventos como processed após publicação')
  it('SELECT FOR UPDATE SKIP LOCKED — duas instâncias não processam o mesmo evento')
  it('idempotência — publicar duas vezes o mesmo event_id não cria job duplicado no BullMQ')
})

// IdempotencyStore — race condition
describe('IdempotencyStore race condition (integration)', () => {
  it('duas requisições simultâneas com mesma chave: apenas uma processa')
  it('segunda requisição recebe resultado da primeira após COMPLETED')
  it('segunda requisição recebe 409 enquanto primeira está PROCESSING')
})
```

---

### Camada 3 — Contract Tests com Pact

**O que testam:** o contrato entre este sistema (consumidor) e o gateway externo (provedor). Garante que, se a API do Stripe mudar de forma incompatível, sabemos antes de chegar em produção.

**Por que isso importa em Fintech:** gateways de pagamento evoluem suas APIs. Um campo que antes era opcional que se torna obrigatório, ou um status que muda de nome, pode quebrar o processamento de pagamentos silenciosamente se não houver contract tests.

**Como funciona o Pact:**

1. Este sistema (consumidor) define as interações esperadas com o gateway
2. Pact gera um "pact file" (contrato) a partir dessas interações
3. O contrato pode ser verificado contra uma versão real da API (ou mock dela)
4. Se o gateway mudar de forma incompatível, a verificação falha

```typescript
// tests/contract/StripeAdapter.pact.test.ts

describe('StripeAdapter — Pact contract', () => {
  const provider = new PactV3({
    consumer: 'payment-orchestrator',
    provider: 'stripe-api',
  })

  it('POST /v1/payment_intents — criação bem-sucedida', async () => {
    await provider
      .given('cartão válido')
      .uponReceiving('requisição de criação de payment intent')
      .withRequest({
        method: 'POST',
        path: '/v1/payment_intents',
        body: like({ amount: integer(), currency: string('brl') }),
      })
      .willRespondWith({
        status: 200,
        body: like({
          id: string('pi_test_123'),
          status: string('requires_capture'),
          amount: integer(),
        }),
      })
      .executeTest(async (mockServer) => {
        const adapter = new StripeAdapter(mockServer.url)
        const result  = await adapter.charge({ amount: Cents.of(10000), currency: 'BRL' })
        expect(result.ok).toBe(true)
      })
  })

  it('POST /v1/payment_intents — cartão recusado', async () => {
    await provider
      .given('cartão inválido')
      .uponReceiving('requisição com cartão recusado')
      // ...
      .willRespondWith({ status: 402, body: like({ error: { code: string('card_declined') } }) })
      .executeTest(async (mockServer) => {
        const result = await adapter.charge(/* ... */)
        expect(result.ok).toBe(false)
        expect((result as any).error.code).toBe('CARD_DECLINED')
      })
  })
})
```

---

### Camada 4 — E2E Tests

**O que testam:** fluxos críticos de negócio completos — da requisição HTTP ao estado final no banco, passando por workers e Ledger.

**Ferramenta:** Supertest (HTTP) + Testcontainers (infraestrutura real).

**Quantos:** poucos e focados. E2E tests são lentos e frágeis por natureza. Testamos apenas os happy paths e failure paths mais críticos.

**Cenários obrigatórios:**

```typescript
describe('E2E: fluxo completo de pagamento', () => {
  it('checkout → worker → ledger → dashboard', async () => {
    // 1. POST /payments → 201 {status: PROCESSING}
    const { body: payment } = await request(app)
      .post('/payments')
      .set('x-idempotency-key', randomUUID())
      .send({ amount: 10000, currency: 'BRL', seller_id: testSellerId })
      .expect(201)

    // 2. Worker processa (aguarda conclusão via poll)
    await waitForStatus(payment.id, 'CAPTURED', { timeout: 10_000 })

    // 3. Ledger tem entradas balanceadas
    const entries = await db('ledger_entries').where({ payment_id: payment.id })
    const debitTotal  = entries.filter(e => e.entry_type === 'DEBIT').reduce((s, e) => s + e.amount_cents, 0)
    const creditTotal = entries.filter(e => e.entry_type === 'CREDIT').reduce((s, e) => s + e.amount_cents, 0)
    expect(debitTotal).toBe(creditTotal)   // invariante de double-entry

    // 4. Dashboard mostra a transação
    const { body: summary } = await request(app)
      .get(`/ledger/summary?seller_id=${testSellerId}`)
      .expect(200)
    expect(summary.transactions).toContainEqual(expect.objectContaining({ payment_id: payment.id }))
  })

  it('idempotência: mesmo pagamento submetido 3 vezes = 1 cobrança', async () => {
    const key = randomUUID()
    const results = await Promise.all([
      request(app).post('/payments').set('x-idempotency-key', key).send(payload),
      request(app).post('/payments').set('x-idempotency-key', key).send(payload),
      request(app).post('/payments').set('x-idempotency-key', key).send(payload),
    ])

    // Todas retornam o mesmo payment_id
    const ids = results.map(r => r.body.id)
    expect(new Set(ids).size).toBe(1)

    // Apenas um registro no banco
    const count = await db('payments').where({ id: ids[0] }).count('* as n').first()
    expect(Number(count?.n)).toBe(1)
  })

  it('estorno: ledger fecha corretamente após refund', async () => { /* ... */ })
  it('webhook duplicado: processado apenas uma vez', async () => { /* ... */ })
  it('gateway fora: payment fica em PENDING, processa quando volta', async () => { /* ... */ })
})
```

---

### Quality Gates — não-negociáveis no CI

O CI **bloqueia merge** se qualquer gate falhar. Sem exceções.

```yaml
# .github/workflows/quality.yml

jobs:
  quality:
    steps:
      - name: TypeScript — zero erros de tipo
        run: tsc --noEmit
        # Um erro de tipo = CI quebra. Sem @ts-ignore sem justificativa.

      - name: ESLint — zero warnings
        run: eslint . --max-warnings 0
        # Warning = erro aqui. A regra existe por uma razão.

      - name: Unit tests + coverage gate
        run: jest --testPathPattern=unit --coverage
        env:
          JEST_COVERAGE_THRESHOLD_DOMAIN: 90
          JEST_COVERAGE_THRESHOLD_APPLICATION: 85
        # < threshold = CI quebra.

      - name: Integration tests
        run: jest --testPathPattern=integration
        # Requer Docker — roda em GitHub Actions com Docker disponível.

      - name: Contract tests
        run: jest --testPathPattern=contract

      - name: Security audit
        run: npm audit --audit-level=high
        # Vulnerabilidade HIGH ou CRITICAL = CI quebra.

      - name: Secrets scan
        run: npx secretlint "**/*"
        # API key ou secret no código = CI quebra.

      - name: Build Docker image
        run: docker build -t payment-orchestrator .
        # Se o build falha, não chegamos em produção nunca.
```

### O que NÃO é um quality gate (mas é recomendado)

- **E2E tests no CI:** rodam em uma pipeline separada (nightly ou pré-deploy) — lentos demais para todo PR.
- **Performance tests:** fora do escopo v1 — adicionados quando houver baseline de produção.
- **Mutation testing:** recomendado para o `SplitCalculator` e `Payment` state machine em v2.

---

## Alternativas consideradas

### Alternativa 1: Apenas unit tests com mocks de tudo

O padrão mais comum — mockar repositories, banco, Redis, e testar tudo isoladamente.

**Prós:** rápido, simples, alta cobertura aparente.
**Contras:** não detecta bugs de integração — o mock do banco aceita qualquer insert, mas o PostgreSQL real rejeita com constraint violation. O trigger de double-entry nunca é testado. Race conditions de idempotência nunca aparecem.
**Por que descartada:** para sistemas financeiros, bugs de integração são exatamente os mais caros. Ter 95% de cobertura com mocks que não refletem o comportamento real do banco é falsa segurança.

### Alternativa 2: Banco em memória para testes de integração (SQLite)

Usar SQLite em memória para testes mais rápidos que Testcontainers.

**Prós:** muito mais rápido que subir Docker, sem dependência de Docker no CI.
**Contras:** SQLite tem dialeto SQL diferente do PostgreSQL. Não suporta `SELECT FOR UPDATE SKIP LOCKED`. Não executa triggers PL/pgSQL. Não tem o tipo `JSONB`. Os comportamentos mais críticos do nosso schema PostgreSQL são invisíveis no SQLite.
**Por que descartada:** testar com o banco errado é pior que não testar — cria falsa confiança. Testcontainers tem overhead aceitável (30-60s de startup amortizado por toda a suite) e garante comportamento idêntico ao de produção.

### Alternativa 3: Coverage de 100% como meta

Exigir 100% de cobertura em todas as camadas.

**Prós:** nenhuma linha sem teste.
**Contras:** leva a testes que existem apenas para satisfazer a métrica — sem assertar comportamento real. Casos triviais (getters, construtores) ficam testados enquanto edge cases financeiros complexos ficam com testes superficiais. Coverage é uma métrica proxy, não o objetivo.
**Por que descartada:** 90% de cobertura com testes que assertam comportamentos críticos é melhor que 100% com testes vazios. O threshold escolhido é suficientemente alto para forçar cobertura real sem virar jogo de métricas.

---

## Consequências

### Positivas
- Bugs de arredondamento no split são detectados antes de chegar em produção.
- O trigger de double-entry é testado contra o PostgreSQL real — não existe surpresa em produção.
- Contract tests com Pact detectam mudanças na API do gateway antes do deploy.
- Quality gates no CI tornam impossível fazer merge de código sem testes passando.
- TDD no domínio resulta em APIs mais simples e focadas — o design melhora como efeito colateral.

### Negativas / Trade-offs
- CI mais lento com Testcontainers — ~2-3 minutos adicionais por pull request.
- Testcontainers requer Docker disponível no ambiente de CI — configuração adicional no GitHub Actions.
- Pact requer disciplina para manter os contratos atualizados quando o adapter muda.

### Riscos e mitigações

- **Risco:** developer desabilita quality gate localmente para fazer merge rápido.
  **Mitigação:** quality gates rodam no CI, não apenas localmente. Branch protection rules no GitHub impedem merge sem CI verde — mesmo para admins do repositório.

- **Risco:** Testcontainers lento no CI causa timeout e falha não-relacionada ao código.
  **Mitigação:** timeout generoso (5 minutos por suite de integração). Pull das imagens Docker é cacheado no CI. Imagens fixadas em versões específicas (`postgres:16.2`, não `postgres:latest`) para evitar surpresas.

- **Risco:** testes de integração dependem de ordem de execução (dados de um teste afetam o próximo).
  **Mitigação:** cada suite de integração roda em uma transação que é revertida no `afterEach` — banco sempre volta ao estado limpo. Para testes que não podem usar rollback (ex: teste do OutboxRelay que faz commit), limpa explicitamente no `afterEach`.

---

## Implementação

```typescript
// jest.config.ts — configuração completa

import type { Config } from 'jest'

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],

  // Separação por tipo — permite rodar camadas independentemente
  projects: [
    {
      displayName: 'unit',
      testMatch: ['<rootDir>/src/**/*.test.ts'],
      coverageThreshold: {
        './src/domain/':      { lines: 90, branches: 85 },
        './src/application/': { lines: 85, branches: 80 },
      },
    },
    {
      displayName: 'integration',
      testMatch: ['<rootDir>/tests/integration/**/*.test.ts'],
      testTimeout: 30_000,  // Testcontainers precisa de mais tempo
      globalSetup:    '<rootDir>/tests/integration/setup.ts',
      globalTeardown: '<rootDir>/tests/integration/teardown.ts',
    },
    {
      displayName: 'contract',
      testMatch: ['<rootDir>/tests/contract/**/*.test.ts'],
    },
    {
      displayName: 'e2e',
      testMatch: ['<rootDir>/tests/e2e/**/*.test.ts'],
      testTimeout: 60_000,
    },
  ],

  // Aliases para imports limpos nos testes
  moduleNameMapper: {
    '@domain/(.*)':         '<rootDir>/src/domain/$1',
    '@application/(.*)':    '<rootDir>/src/application/$1',
    '@infrastructure/(.*)': '<rootDir>/src/infrastructure/$1',
  },
}

export default config
```

```bash
# Scripts npm — comandos claros para cada camada
"test":         "jest --selectProjects unit",
"test:int":     "jest --selectProjects integration",
"test:contract":"jest --selectProjects contract",
"test:e2e":     "jest --selectProjects e2e",
"test:all":     "jest",
"test:watch":   "jest --selectProjects unit --watch",
"test:coverage":"jest --selectProjects unit --coverage",
```

**Arquivos:**
- `jest.config.ts`
- `tests/integration/setup.ts` — Testcontainers global setup
- `tests/integration/teardown.ts`
- `tests/integration/helpers/db.ts` — transaction rollback helper
- `tests/contract/StripeAdapter.pact.test.ts`
- `tests/e2e/payment-flow.test.ts`
- `.github/workflows/quality.yml`
