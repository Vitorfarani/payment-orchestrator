import { ok, err } from '../../../src/domain/shared/Result'

describe('Result', () => {
  it('ok() retorna sucesso com o valor', () => {
    const result = ok(42)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toBe(42)
    }
  })

  it('err() retorna falha com o erro', () => {
    const error = new Error('algo deu errado')
    const result = err(error)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toBe('algo deu errado')
    }
  })

  it('ok() funciona com objetos', () => {
    const result = ok({ id: '123', amount: 1000 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.amount).toBe(1000)
    }
  })
})