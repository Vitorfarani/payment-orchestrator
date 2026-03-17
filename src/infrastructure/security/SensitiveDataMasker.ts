/**
 * Camada 2 de mascaramento de dados sensíveis (ADR-019).
 *
 * Independente do Pino: a falha da Camada 1 (redact do Pino) não expõe dados.
 * Inspeciona tanto nomes de campos (chaves sensíveis) quanto valores em strings
 * livres (regex de PAN, CPF e CNPJ).
 *
 * Uso típico:
 *   const masker = new SensitiveDataMasker()
 *   logger.info(masker.mask({ buyer: { cpf: '...', name: '...' } }), 'checkout')
 *
 * Em desenvolvimento local, defina `MASK_SENSITIVE_DATA=false` para depuração
 * pontual — nunca em produção (ADR-019).
 */

/**
 * Lista de nomes (substrings) de campos sensíveis.
 * Exportada para integração DRY com o logger Pino (ADR-019).
 */
export const SENSITIVE_KEY_PATHS: readonly string[] = [
  'card_number',
  'pan',
  'cvv',
  'cvc',
  'cpf',
  'cnpj',
  'bank_account',
  'agency',
  'pix_key',
  'password',
  'secret',
  'api_key',
  'token',
  'authorization',
]

interface MaskPattern {
  readonly regex: RegExp
  readonly mask: (match: string) => string
}

/** Type predicate: distingue array de objeto genérico em `unknown`. */
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

/** Type predicate: narrowing seguro para Record sem usar `as`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isUnknownArray(value)
}

export class SensitiveDataMasker {
  private readonly disabled: boolean

  /**
   * Padrões para detectar dados sensíveis pelo valor em strings livres.
   * Aplicados após a verificação de chave sensível — capturam dados em campos
   * com nomes não previstos (ex: `message`, `description`, `body`).
   */
  private readonly patterns: readonly MaskPattern[] = [
    {
      // PAN de cartão: primeiros dígitos 4–9, grupos de 4 com espaço/hífen opcionais.
      // Preserva os últimos 4 dígitos para suporte ao cliente.
      regex: /\b[4-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
      mask: (m: string): string => `****-****-****-${m.slice(-4)}`,
    },
    {
      // CPF: formatado (123.456.789-00) ou sem formatação (12345678900).
      regex: /\b\d{3}[.\s-]?\d{3}[.\s-]?\d{3}[-\s]?\d{2}\b/g,
      mask: (): string => '***.***.***-**',
    },
    {
      // CNPJ: formatado (11.222.333/0001-81) ou sem formatação (11222333000181).
      regex: /\b\d{2}[.\s]?\d{3}[.\s]?\d{3}[/\s]?\d{4}[-\s]?\d{2}\b/g,
      mask: (): string => '**.***.***/**/**',
    },
  ]

  constructor() {
    this.disabled = process.env['MASK_SENSITIVE_DATA'] === 'false'
  }

  /**
   * Percorre `data` recursivamente e mascara dados sensíveis.
   * Retorna `data` sem modificação se `MASK_SENSITIVE_DATA=false`.
   */
  mask(data: Record<string, unknown>): Record<string, unknown> {
    if (this.disabled) return data
    return this.maskRecord(data)
  }

  private maskRecord(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(obj)) {
      result[key] = this.isSensitiveKey(key) ? '[REDACTED]' : this.maskDeep(val)
    }
    return result
  }

  private maskDeep(value: unknown): unknown {
    if (value === null || value === undefined) return value
    if (typeof value === 'string') return this.maskString(value)
    if (isUnknownArray(value)) return value.map((v: unknown) => this.maskDeep(v))
    if (isRecord(value)) return this.maskRecord(value)
    return value
  }

  /**
   * Verifica se `key` (case-insensitive) contém alguma substring sensível.
   * Ex: `'USER_PASSWORD'` contém `'password'` → true.
   */
  private isSensitiveKey(key: string): boolean {
    const lower = key.toLowerCase()
    return SENSITIVE_KEY_PATHS.some((k) => lower.includes(k))
  }

  /** Aplica todos os padrões regex sobre uma string livre. */
  private maskString(value: string): string {
    let result = value
    for (const { regex, mask } of this.patterns) {
      result = result.replace(regex, mask)
    }
    return result
  }
}
