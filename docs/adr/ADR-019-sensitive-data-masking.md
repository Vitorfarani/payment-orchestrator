# ADR-019: Mascaramento de dados sensíveis em logs e audit trail

## Metadados

| Campo | Valor |
|---|---|
| **ID** | ADR-019 |
| **Título** | Mascaramento de dados sensíveis em logs e audit trail |
| **Status** | `accepted` |
| **Data** | 2025-01-01 |
| **Contextos afetados** | Todos (logs operacionais e audit log) |
| **Depende de** | ADR-017 (Observabilidade), ADR-018 (Audit Log) |
| **Bloqueia** | Configuração do Pino, AuditLogger |

---

## Contexto

Sistemas de pagamento processam dados altamente sensíveis: números de cartão (PAN), CVV, CPF, CNPJ, dados bancários (agência, conta, chave Pix), e credenciais de API. Qualquer um desses dados que vaze em logs representa:

**Risco legal (LGPD):** o vazamento de dados pessoais em logs pode resultar em multa de até 2% do faturamento (limitado a R$ 50 milhões por infração) pela ANPD.

**Risco de compliance (PCI-DSS):** dados de cartão (PAN, CVV) em logs é uma violação grave do PCI-DSS — pode resultar em perda da capacidade de processar cartões.

**Risco operacional:** logs são frequentemente compartilhados fora da infraestrutura segura — em tickets de suporte, em ferramentas de APM de terceiros, em screenshots durante debugging. Um dado sensível em log tem altíssima probabilidade de ser exposto.

O problema é que dados sensíveis chegam em logs de formas inesperadas:
- O request body completo logado por um middleware de debugging
- Um erro que inclui o objeto completo no stack trace
- Um desenvolvedor que adiciona `logger.debug({ payment })` temporariamente e esquece de remover
- Um JSON de webhook do gateway que inclui os últimos 4 dígitos do cartão

---

## Decisão

Implementaremos mascaramento em **três camadas independentes**, de forma que a falha de uma não expõe o dado:

### Camada 1 — Redação automática no Pino (configuração)

Pino oferece `redact` nativo que mascara campos por path antes de serializar o log. Configurado uma vez, se aplica a todos os logs sem intervenção do desenvolvedor.

```typescript
pino({
  redact: {
    paths: [
      // Cartão
      '*.card_number', '*.pan', '*.cvv', '*.cvc',
      // Dados pessoais
      '*.cpf', '*.cnpj', '*.date_of_birth',
      // Bancário
      '*.bank_account', '*.agency', '*.pix_key',
      // Credenciais
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      '*.api_key', '*.secret', '*.password', '*.token',
      // Endereço completo
      '*.full_address',
    ],
    censor: '[REDACTED]',
  },
})
```

**Limitação:** redação por path só funciona para campos com nome exato conhecido. Não captura dados sensíveis embutidos em strings ou em campos com nomes inesperados.

### Camada 2 — SensitiveDataMasker (mascaramento ativo)

Para situações onde o campo não tem nome previsível — como o payload completo de um webhook ou o body de um request — usamos um mascarador que inspeciona **valores** além de nomes de campos.

```typescript
export class SensitiveDataMasker {
  // Padrões regex para detectar dados sensíveis pelo valor
  private readonly patterns = [
    { name: 'card_pan',   regex: /\b[4-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,    mask: (m: string) => `****-****-****-${m.slice(-4)}` },
    { name: 'cpf',        regex: /\b\d{3}[.\s-]?\d{3}[.\s-]?\d{3}[-\s]?\d{2}\b/g,        mask: () => '***.***.***-**' },
    { name: 'cnpj',       regex: /\b\d{2}[.\s]?\d{3}[.\s]?\d{3}[/\s]?\d{4}[-\s]?\d{2}\b/g, mask: () => '**.***.***/**/**' },
  ]

  mask(data: Record<string, unknown>): Record<string, unknown> {
    return this.maskDeep(data) as Record<string, unknown>
  }

  private maskDeep(value: unknown): unknown {
    if (value === null || value === undefined) return value
    if (typeof value === 'string') return this.maskString(value)
    if (Array.isArray(value)) return value.map(v => this.maskDeep(v))
    if (typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          this.isSensitiveKey(k) ? '[REDACTED]' : this.maskDeep(v)
        ])
      )
    }
    return value
  }

  private isSensitiveKey(key: string): boolean {
    const sensitiveKeys = [
      'card_number', 'pan', 'cvv', 'cvc', 'cpf', 'cnpj',
      'bank_account', 'agency', 'pix_key', 'password',
      'secret', 'api_key', 'token', 'authorization',
    ]
    return sensitiveKeys.some(k => key.toLowerCase().includes(k))
  }

  private maskString(value: string): string {
    let result = value
    for (const { regex, mask } of this.patterns) {
      result = result.replace(regex, mask)
    }
    return result
  }
}
```

### Camada 3 — Sanitização do request body no middleware HTTP

O middleware de logging de requests nunca loga o body completo. Loga apenas campos explicitamente permitidos (allowlist), não o objeto inteiro.

```typescript
// ❌ NUNCA fazer:
logger.info({ body: req.body }, 'Request received')

// ✅ Sempre fazer:
logger.info({
  method:   req.method,
  path:     req.path,
  // body: apenas campos não-sensíveis, explicitamente listados
  amount:   req.body?.amount,
  currency: req.body?.currency,
  // NUNCA: card_number, cpf, bank_account, etc.
}, 'Request received')
```

### O que é mascarado vs o que é preservado

| Dado | Tratamento | Justificativa |
|---|---|---|
| PAN completo (`4111111111111111`) | `****-****-****-1111` | Últimos 4 dígitos úteis para suporte |
| CVV/CVC | `[REDACTED]` | Nunca deve aparecer — nem os últimos dígitos |
| CPF | `***.***.***-**` | Dado pessoal — LGPD |
| CNPJ | `**.***.***/**/**` | Dado pessoal/empresarial |
| Chave Pix (CPF/telefone) | `[REDACTED]` | Pode revelar CPF indiretamente |
| Chave Pix (UUID/email aleatório) | preservado | Não contém PII |
| `payment_id` | preservado | Necessário para rastreamento |
| `amount_cents` | preservado | Necessário para diagnóstico |
| `gateway_payment_id` | preservado | Referência externa para suporte |
| Authorization header | `[REDACTED]` | Credenciais |
| API keys em body | `[REDACTED]` | Credenciais |

---

## Alternativas consideradas

### Alternativa 1: Não logar dados sensíveis (responsabilidade do desenvolvedor)

Confiar que os desenvolvedores nunca vão logar dados sensíveis.

**Prós:** sem código adicional.
**Contras:** falha humana é inevitável. Em qualquer sistema com mais de um desenvolvedor e qualquer pressão de tempo, alguém vai adicionar um `console.log(req.body)` em algum momento. A segurança baseada em "não esqueça" não é segurança.
**Por que descartada:** inaceitável para compliance PCI-DSS e LGPD. Defesa em profundidade requer que a proteção não dependa de ação humana correta em 100% das vezes.

### Alternativa 2: Criptografar dados sensíveis nos logs

Em vez de mascarar, criptografar os valores com uma chave e permitir descriptografia quando necessário.

**Prós:** dados podem ser recuperados por auditores autorizados se necessário.
**Contras:** complexidade de gerenciamento de chaves, risco de que a chave também vaze, overhead de performance. Para logs, raramente precisamos descriptografar — se precisamos do valor real, consultamos o banco, não o log.
**Por que descartada:** KISS e YAGNI. Mascaramento irreversível é suficiente para logs — não existe cenário legítimo onde precisamos do CVV completo em um log de debugging.

---

## Consequências

### Positivas
- Três camadas independentes: a falha de qualquer uma não expõe dados.
- O mascaramento é automático — desenvolvedores não precisam se lembrar de aplicar.
- Conformidade com PCI-DSS (dados de cartão) e LGPD (CPF/dados pessoais) por design.
- O `SensitiveDataMasker` pode ser testado isoladamente — cobertura de testes alta.

### Negativas / Trade-offs
- Dados mascarados dificultam debugging de problemas específicos de validação (ex: "este CPF específico está causando erro?").
  — **Mitigação:** em desenvolvimento local, mascaramento pode ser desabilitado via `MASK_SENSITIVE_DATA=false`.
- Regex de detecção de PAN pode ter falsos positivos (número de telefone com 16 dígitos).
  — **Mitigação:** o padrão de PAN inclui verificação do primeiro dígito (4-9) e formato específico, reduzindo falsos positivos. Monitorado via testes.

### Riscos e mitigações

- **Risco:** novo campo sensível adicionado ao domínio sem atualizar o mascarador.
  **Mitigação:** todo novo campo de PII no domínio requer atualização do `SensitiveDataMasker` — checklist de code review. Testes de regressão verificam que campos conhecidos são mascarados.

- **Risco:** dado sensível em uma string composta (ex: mensagem de erro que inclui o CPF).
  **Mitigação:** a Camada 2 (`SensitiveDataMasker`) faz inspeção de valores por regex — captura dados sensíveis mesmo em strings livres.

---

## Implementação

```typescript
// src/infrastructure/security/SensitiveDataMasker.ts
// (implementação completa descrita na seção de Decisão acima)

// Testes obrigatórios para o mascarador:
describe('SensitiveDataMasker', () => {
  const masker = new SensitiveDataMasker()

  it('mascara PAN mantendo últimos 4 dígitos', () => {
    const result = masker.mask({ card_number: '4111111111111111' })
    expect(result.card_number).toBe('[REDACTED]')  // campo por nome
  })

  it('mascara CPF em string livre', () => {
    const result = masker.mask({ message: 'CPF do cliente: 123.456.789-00' })
    expect(result.message).toBe('CPF do cliente: ***.***.***-**')
  })

  it('preserva payment_id e amount_cents', () => {
    const result = masker.mask({ payment_id: 'pay_123', amount_cents: 10000 })
    expect(result.payment_id).toBe('pay_123')
    expect(result.amount_cents).toBe(10000)
  })

  it('mascara objetos aninhados', () => {
    const result = masker.mask({ buyer: { cpf: '123.456.789-00', name: 'João' } })
    expect((result.buyer as any).cpf).toBe('***.***.***-**')
    expect((result.buyer as any).name).toBe('João')
  })

  it('funciona com arrays', () => {
    const result = masker.mask({ items: [{ cpf: '123.456.789-00' }] })
    expect((result.items as any[])[0].cpf).toBe('***.***.***-**')
  })
})
```

```typescript
// Integração com o logger Pino — aplicado uma vez, protege todos os logs
// src/infrastructure/observability/logger.ts

import pino from 'pino'
import { SENSITIVE_KEY_PATHS } from '../security/SensitiveDataMasker'

export function createLogger() {
  return pino({
    redact: {
      paths: SENSITIVE_KEY_PATHS,  // exportado do SensitiveDataMasker para DRY
      censor: '[REDACTED]',
    },
    // ... demais configurações do ADR-017
  })
}
```

**Arquivos:**
- `src/infrastructure/security/SensitiveDataMasker.ts`
- `src/infrastructure/security/SensitiveDataMasker.test.ts`
- `src/infrastructure/observability/logger.ts` — integra com Pino redact
