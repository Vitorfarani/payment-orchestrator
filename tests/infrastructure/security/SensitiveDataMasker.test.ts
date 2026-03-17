import { SensitiveDataMasker } from '../../../src/infrastructure/security/SensitiveDataMasker'

describe('SensitiveDataMasker', () => {
  let masker: SensitiveDataMasker

  beforeEach(() => {
    delete process.env['MASK_SENSITIVE_DATA']
    masker = new SensitiveDataMasker()
  })

  afterEach(() => {
    delete process.env['MASK_SENSITIVE_DATA']
  })

  // ─── Mascaramento por nome de chave ────────────────────────────────────────

  describe('mascaramento por nome de chave (isSensitiveKey)', () => {
    it.each([
      ['card_number'],
      ['pan'],
      ['cvv'],
      ['cvc'],
      ['bank_account'],
      ['agency'],
      ['pix_key'],
      ['password'],
      ['secret'],
      ['api_key'],
      ['token'],
      ['authorization'],
    ])('mascara campo "%s" com [REDACTED]', (field) => {
      const result = masker.mask({ [field]: 'qualquer-valor' })
      expect(result[field]).toBe('[REDACTED]')
    })

    it('mascara quando o nome do campo contém a chave sensível como substring', () => {
      // 'user_password' contém 'password' → REDACTED
      // 'buyer_card_number' contém 'card_number' → REDACTED
      const result = masker.mask({ user_password: 'x', buyer_card_number: 'y' })
      expect(result['user_password']).toBe('[REDACTED]')
      expect(result['buyer_card_number']).toBe('[REDACTED]')
    })

    it('preserva campo não-sensível mesmo que tenha valor parecido com dado sensível', () => {
      const result = masker.mask({ description: '123.456.789-00' })
      // 'description' não é chave sensível → aplica regex, não [REDACTED] por nome
      // CPF na string livre é mascarado pela regex
      expect(result['description']).toBe('***.***.***-**')
    })
  })

  // ─── Mascaramento de CPF por regex ─────────────────────────────────────────

  describe('mascaramento de CPF', () => {
    it('mascara campo cpf por nome (retorna [REDACTED])', () => {
      const result = masker.mask({ cpf: '123.456.789-00' })
      expect(result['cpf']).toBe('[REDACTED]')
    })

    it('mascara CPF formatado em string livre', () => {
      const result = masker.mask({ message: 'CPF do cliente: 123.456.789-00' })
      expect(result['message']).toBe('CPF do cliente: ***.***.***-**')
    })

    it('mascara CPF sem formatação em string livre', () => {
      const result = masker.mask({ message: 'dados: 12345678900' })
      expect(result['message']).toBe('dados: ***.***.***-**')
    })

    it('mascara CPF com hífens alternativos', () => {
      const result = masker.mask({ message: '123-456-789-00' })
      expect(result['message']).toBe('***.***.***-**')
    })

    it('mascara múltiplos CPFs em uma mesma string', () => {
      const result = masker.mask({ msg: 'CPFs: 123.456.789-00 e 987.654.321-00' })
      expect(result['msg']).toBe('CPFs: ***.***.***-** e ***.***.***-**')
    })
  })

  // ─── Mascaramento de CNPJ por regex ────────────────────────────────────────

  describe('mascaramento de CNPJ', () => {
    it('mascara campo cnpj por nome (retorna [REDACTED])', () => {
      const result = masker.mask({ cnpj: '11.222.333/0001-81' })
      expect(result['cnpj']).toBe('[REDACTED]')
    })

    it('mascara CNPJ formatado em string livre', () => {
      const result = masker.mask({ message: 'CNPJ: 11.222.333/0001-81' })
      expect(result['message']).toBe('CNPJ: **.***.***/**/**')
    })

    it('mascara CNPJ sem formatação em string livre', () => {
      const result = masker.mask({ message: 'empresa: 11222333000181' })
      expect(result['message']).toBe('empresa: **.***.***/**/**')
    })
  })

  // ─── Mascaramento de PAN por regex ─────────────────────────────────────────

  describe('mascaramento de PAN (cartão)', () => {
    it('mascara campo card_number por nome (retorna [REDACTED])', () => {
      const result = masker.mask({ card_number: '4111111111111111' })
      expect(result['card_number']).toBe('[REDACTED]')
    })

    it('mascara PAN sem formatação preservando últimos 4 dígitos', () => {
      const result = masker.mask({ message: 'cartão: 4111111111111111' })
      expect(result['message']).toBe('cartão: ****-****-****-1111')
    })

    it('mascara PAN com espaços preservando últimos 4 dígitos', () => {
      const result = masker.mask({ message: '4111 1111 1111 1111 aprovado' })
      expect(result['message']).toBe('****-****-****-1111 aprovado')
    })

    it('mascara PAN com hífens preservando últimos 4 dígitos', () => {
      const result = masker.mask({ message: '4111-1111-1111-2222' })
      expect(result['message']).toBe('****-****-****-2222')
    })

    it('preserva últimos 4 dígitos distintos', () => {
      const result = masker.mask({ message: '5500005555555559' })
      expect(result['message']).toBe('****-****-****-5559')
    })
  })

  // ─── Preservação de campos não-sensíveis ───────────────────────────────────

  describe('preservação de campos não-sensíveis', () => {
    it('preserva payment_id e amount_cents', () => {
      const result = masker.mask({ payment_id: 'pay_123', amount_cents: 10000 })
      expect(result['payment_id']).toBe('pay_123')
      expect(result['amount_cents']).toBe(10000)
    })

    it('preserva gateway_payment_id', () => {
      const result = masker.mask({ gateway_payment_id: 'ch_stripe_abc' })
      expect(result['gateway_payment_id']).toBe('ch_stripe_abc')
    })

    it('preserva strings sem dados sensíveis', () => {
      const result = masker.mask({ status: 'CAPTURED', method: 'PIX' })
      expect(result['status']).toBe('CAPTURED')
      expect(result['method']).toBe('PIX')
    })

    it('preserva booleanos', () => {
      const result = masker.mask({ active: true, verified: false })
      expect(result['active']).toBe(true)
      expect(result['verified']).toBe(false)
    })

    it('preserva números inteiros', () => {
      const result = masker.mask({ retry_count: 3, amount: 5000 })
      expect(result['retry_count']).toBe(3)
      expect(result['amount']).toBe(5000)
    })
  })

  // ─── Recursão em estruturas aninhadas ──────────────────────────────────────

  describe('recursão em objetos aninhados e arrays', () => {
    it('mascara campos sensíveis em objeto aninhado', () => {
      const result = masker.mask({ buyer: { cpf: '123.456.789-00', name: 'João' } })
      const buyer = result['buyer'] as Record<string, unknown>
      expect(buyer['cpf']).toBe('[REDACTED]')
      expect(buyer['name']).toBe('João')
    })

    it('mascara 3 níveis de profundidade', () => {
      const result = masker.mask({ a: { b: { pan: 'valor' } } })
      const inner = (result['a'] as Record<string, unknown>)['b'] as Record<string, unknown>
      expect(inner['pan']).toBe('[REDACTED]')
    })

    it('mascara campos sensíveis em array de objetos', () => {
      const result = masker.mask({ items: [{ cpf: '123.456.789-00' }, { cpf: '987.654.321-11' }] })
      const items = result['items'] as Record<string, unknown>[]
      expect(items[0]?.['cpf']).toBe('[REDACTED]')
      expect(items[1]?.['cpf']).toBe('[REDACTED]')
    })

    it('mascara CPF em array de strings via regex', () => {
      const result = masker.mask({ logs: ['CPF: 123.456.789-00', 'status: ok'] })
      const logs = result['logs'] as string[]
      expect(logs[0]).toBe('CPF: ***.***.***-**')
      expect(logs[1]).toBe('status: ok')
    })

    it('mascara dados em array misto preservando tipos não-string', () => {
      const result = masker.mask({ mixed: [42, 'CPF: 123.456.789-00', true] })
      const mixed = result['mixed'] as unknown[]
      expect(mixed[0]).toBe(42)
      expect(mixed[1]).toBe('CPF: ***.***.***-**')
      expect(mixed[2]).toBe(true)
    })
  })

  // ─── Casos limites ──────────────────────────────────────────────────────────

  describe('casos limites', () => {
    it('retorna objeto vazio sem erro', () => {
      const result = masker.mask({})
      expect(result).toStrictEqual({})
    })

    it('preserva valor null em campo não-sensível', () => {
      const result = masker.mask({ field: null })
      expect(result['field']).toBeNull()
    })

    it('preserva valor undefined em campo não-sensível', () => {
      const result = masker.mask({ field: undefined })
      expect(result['field']).toBeUndefined()
    })

    it('preserva array vazio', () => {
      const result = masker.mask({ tags: [] })
      expect(result['tags']).toStrictEqual([])
    })

    it('mascara null em campo sensível por nome (campo recebe [REDACTED])', () => {
      // isSensitiveKey → [REDACTED] independente do valor
      const result = masker.mask({ password: null })
      expect(result['password']).toBe('[REDACTED]')
    })

    it('string sem dados sensíveis não é alterada', () => {
      const result = masker.mask({ info: 'pagamento processado com sucesso' })
      expect(result['info']).toBe('pagamento processado com sucesso')
    })
  })

  // ─── MASK_SENSITIVE_DATA=false ──────────────────────────────────────────────

  describe('MASK_SENSITIVE_DATA=false desabilita mascaramento', () => {
    it('retorna dados sem alteração quando desabilitado', () => {
      process.env['MASK_SENSITIVE_DATA'] = 'false'
      const disabledMasker = new SensitiveDataMasker()

      const data = { cpf: '123.456.789-00', pan: '4111111111111111', amount: 1000 }
      const result = disabledMasker.mask(data)

      expect(result['cpf']).toBe('123.456.789-00')
      expect(result['pan']).toBe('4111111111111111')
      expect(result['amount']).toBe(1000)
    })

    it('mascara normalmente quando MASK_SENSITIVE_DATA não está definido', () => {
      const result = masker.mask({ cpf: '123.456.789-00' })
      expect(result['cpf']).toBe('[REDACTED]')
    })

    it('mascara normalmente quando MASK_SENSITIVE_DATA=true', () => {
      process.env['MASK_SENSITIVE_DATA'] = 'true'
      const enabledMasker = new SensitiveDataMasker()
      const result = enabledMasker.mask({ cpf: '123.456.789-00' })
      expect(result['cpf']).toBe('[REDACTED]')
    })
  })
})
