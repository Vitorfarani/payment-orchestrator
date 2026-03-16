# ADR-008: Circuit Breaker para chamadas ao gateway externo

## Metadados

| Campo | Valor |
|---|---|
| **ID** | ADR-008 |
| **Título** | Circuit Breaker para chamadas ao gateway externo |
| **Status** | `accepted` |
| **Data** | 2025-01-01 |
| **Contextos afetados** | PaymentContext |
| **Depende de** | ADR-003 (Sync vs Async) |
| **Bloqueia** | StripeAdapter, AsaasAdapter |

---

## Contexto

O gateway externo (Stripe/Asaas) é uma dependência crítica mas fora do nosso controle. Qualquer serviço externo pode degradar — timeout, erro 500, latência elevada — e a questão não é se vai acontecer, mas quando.

Sem proteção, um gateway degradado causa um efeito cascata:

1. Cada chamada ao gateway espera o timeout completo (ex: 30 segundos)
2. Workers ficam bloqueados aguardando respostas que nunca chegam
3. A fila de jobs cresce indefinidamente
4. Memória e conexões do banco são esgotadas pelos workers bloqueados
5. O sistema inteiro para — não só os pagamentos

O Circuit Breaker é o padrão que evita esse cascata: após um número configurável de falhas consecutivas, o "circuito abre" e as chamadas falham imediatamente (sem esperar timeout), liberando recursos e permitindo que o sistema continue operando em modo degradado.

---

## Decisão

Implementaremos Circuit Breaker usando a biblioteca **`opossum`** — a mais madura para Node.js, amplamente usada em produção.

### Três estados do circuito

```
CLOSED (normal)
  ↓ após 5 falhas em 10 segundos
OPEN (protegido)
  ↓ após 30 segundos de espera (halfOpenAfter)
HALF-OPEN (testando recuperação)
  ↓ sucesso                     ↓ falha
CLOSED                         OPEN (reset do timer)
```

### Configuração dos thresholds

```typescript
const CIRCUIT_BREAKER_OPTIONS = {
  timeout:               5000,   // ms — falha se gateway não responder em 5s
  errorThresholdPercent: 50,     // % de falhas para abrir (em janela de volumeThreshold)
  volumeThreshold:       5,      // mínimo de chamadas antes de avaliar percentual
  resetTimeout:          30000,  // ms — tempo no estado OPEN antes de tentar HALF-OPEN
}
```

### Comportamento quando o circuito está OPEN

Quando o circuito está aberto, a chamada ao gateway falha imediatamente com `CircuitOpenError`. O `PaymentWorker` trata esse erro de forma especial:

- **Não** move o job para DLQ (o gateway pode voltar em 30 segundos)
- Agenda retry com backoff curto (10 segundos)
- Depois de N retries com circuito aberto, move para DLQ com flag `circuit_open: true`

### Um circuito por gateway

Mantemos instâncias separadas de Circuit Breaker para cada gateway (`stripe-circuit`, `asaas-circuit`). Se o Stripe cair, o Asaas não é afetado.

---

## Alternativas consideradas

### Alternativa 1: Timeout simples sem Circuit Breaker

Configurar apenas um timeout de 5s nas chamadas ao gateway.

**Prós:** simples, sem biblioteca adicional.
**Contras:** cada chamada ainda espera 5 segundos antes de falhar. Com 100 workers simultâneos e gateway fora, são 500 segundos de threads bloqueadas. Sem "memória" de falhas anteriores — cada chamada repete o erro de forma independente.
**Por que descartada:** não resolve o efeito cascata. O timeout é necessário mas insuficiente.

### Alternativa 2: Implementação manual do Circuit Breaker

Implementar o padrão manualmente com Redis para estado compartilhado entre instâncias.

**Prós:** zero dependência externa, controle total.
**Contras:** reimplementar corretamente a lógica de estado (CLOSED/OPEN/HALF-OPEN), contadores de falha, janela de tempo, e propagação entre instâncias é complexo e propenso a bugs sutis. Já existe biblioteca testada em produção por milhares de projetos.
**Por que descartada:** KISS. `opossum` tem 5 anos de histórico, boa documentação, e é a escolha padrão para Node.js. A única razão para implementar manualmente seria um requisito muito específico que `opossum` não atende — o que não é o caso.

### Alternativa 3: Bulkhead Pattern (isolamento de thread pool)

Limitar o número de chamadas simultâneas ao gateway com um semáforo, independente de falhas.

**Prós:** previne sobrecarga mesmo quando o gateway está lento (não necessariamente falhando).
**Contras:** não protege contra falhas em cascata — só limita throughput. Complementar ao Circuit Breaker, não substituto.
**Por que descartada:** `opossum` inclui `maxConcurrentRequests` como opção, que equivale ao Bulkhead. Não precisamos de implementação separada.

---

## Consequências

### Positivas
- Falhas do gateway não degradam o sistema inteiro — workers ficam livres.
- Recovery automático: o circuito testa periodicamente se o gateway voltou.
- Métricas built-in do `opossum`: sucesso, falha, rejeição (circuito aberto), latência.
- O sistema pode continuar aceitando novos pagamentos (ficarão em `PENDING` na fila) mesmo com gateway fora.

### Negativas / Trade-offs
- Falhas com circuito aberto são imediatas — o cliente não tem feedback mais rico de "gateway temporariamente indisponível".
- Thresholds precisam de calibração em produção — muito sensível = muitos falsos positivos; pouco sensível = não protege a tempo.
- Adiciona uma dependência externa (`opossum`).

### Riscos e mitigações

- **Risco:** circuito abre por falha transiente única (ex: timeout de rede de 1 segundo), bloqueando pagamentos desnecessariamente.
  **Mitigação:** `volumeThreshold: 5` garante que o circuito só avalia após pelo menos 5 chamadas. `errorThresholdPercent: 50` requer que 50%+ dessas chamadas falhem. Uma falha isolada não abre o circuito.

- **Risco:** circuito permanece aberto após gateway voltar (halfOpenAfter muito longo).
  **Mitigação:** `resetTimeout: 30000` (30 segundos) é conservador mas razoável. Em produção, pode ser reduzido para 15 segundos após calibração.

- **Risco:** múltiplas instâncias da API com estado do circuito não sincronizado (instância A abre, instância B não sabe).
  **Mitigação:** o Circuit Breaker vive no `PaymentWorker`, não na API. Os workers são processos únicos por instância. Para múltiplas instâncias de worker, o estado do circuito é local — cada worker decide independentemente. Isso é aceitável: o gateway está degradado para todos, então todos vão abrir o circuito em paralelo.

---

## Implementação

```typescript
// src/infrastructure/gateway/CircuitBreakerFactory.ts

import CircuitBreaker from 'opossum'

export interface CircuitBreakerOptions {
  name:                  string
  timeout?:              number
  errorThresholdPercent?: number
  volumeThreshold?:      number
  resetTimeout?:         number
}

export function createCircuitBreaker<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  options: CircuitBreakerOptions
): CircuitBreaker<T> {

  const breaker = new CircuitBreaker(fn, {
    name:                  options.name,
    timeout:               options.timeout               ?? 5000,
    errorThresholdPercent: options.errorThresholdPercent ?? 50,
    volumeThreshold:       options.volumeThreshold       ?? 5,
    resetTimeout:          options.resetTimeout          ?? 30000,
  })

  // Métricas — emitidas para Prometheus (ADR-017)
  breaker.on('open',     () => metrics.circuitBreakerState.set({ name: options.name, state: 'open' }, 1))
  breaker.on('close',    () => metrics.circuitBreakerState.set({ name: options.name, state: 'closed' }, 1))
  breaker.on('halfOpen', () => metrics.circuitBreakerState.set({ name: options.name, state: 'half_open' }, 1))
  breaker.on('fallback', () => metrics.circuitBreakerFallbacks.inc({ name: options.name }))

  // Log de mudança de estado
  breaker.on('open',     () => logger.warn({ circuit: options.name }, 'Circuit breaker opened'))
  breaker.on('close',    () => logger.info({ circuit: options.name }, 'Circuit breaker closed'))
  breaker.on('halfOpen', () => logger.info({ circuit: options.name }, 'Circuit breaker half-open'))

  return breaker
}
```

```typescript
// src/infrastructure/gateway/StripeAdapter.ts

export class StripeAdapter implements IPaymentGateway {
  private readonly chargeBreaker: CircuitBreaker

  constructor(private readonly stripe: Stripe, private readonly logger: Logger) {
    // Circuit breaker envolve a função de charge — não o adapter inteiro
    this.chargeBreaker = createCircuitBreaker(
      this.callStripeCharge.bind(this),
      { name: 'stripe-charge', timeout: 5000, resetTimeout: 30000 }
    )

    // Fallback: quando circuito está aberto, retorna erro imediatamente
    this.chargeBreaker.fallback(() => ({
      ok: false as const,
      error: new GatewayError('Payment gateway temporarily unavailable. Will retry automatically.', 'CIRCUIT_OPEN')
    }))
  }

  async charge(input: ChargeInput): Promise<Result<ChargeResult, GatewayError>> {
    try {
      return await this.chargeBreaker.fire(input)
    } catch (error) {
      // opossum lança CircuitBreakerOpenError quando o circuito está aberto
      // e não há fallback configurado — mas com fallback, nunca chega aqui
      this.logger.error({ error }, 'Unexpected circuit breaker error')
      return { ok: false, error: new GatewayError('Unexpected gateway error', 'UNKNOWN') }
    }
  }

  private async callStripeCharge(input: ChargeInput): Promise<Result<ChargeResult, GatewayError>> {
    try {
      const paymentIntent = await this.stripe.paymentIntents.create({
        amount:   input.amount,
        currency: input.currency.toLowerCase(),
        metadata: input.metadata,
      })
      return { ok: true, value: { id: paymentIntent.id, status: paymentIntent.status } }
    } catch (error) {
      if (error instanceof Stripe.errors.StripeConnectionError) {
        throw error // re-throw para o circuit breaker contar como falha
      }
      return { ok: false, error: new GatewayError(error.message, 'STRIPE_ERROR') }
    }
  }
}
```

**Arquivos:**
- `src/infrastructure/gateway/CircuitBreakerFactory.ts`
- `src/infrastructure/gateway/StripeAdapter.ts`
- `src/infrastructure/gateway/AsaasAdapter.ts`
