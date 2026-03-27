import { GenericContainer, Wait } from 'testcontainers'
import type { StartedTestContainer } from 'testcontainers'
import Knex from 'knex'
import type { Knex as KnexType } from 'knex'
import path from 'path'
import { PostgresSplitRuleRepository } from '../../../src/infrastructure/database/repositories/PostgresSplitRuleRepository'
import { SplitRule } from '../../../src/domain/split/SplitRule'
import { SplitRuleId, SellerId, CommissionRate } from '../../../src/domain/shared/types'

// ──────────────────────────────────────────────────────────────────────────────
// Integration tests — PostgreSQL real via Testcontainers (GenericContainer)
//
// O que testamos:
//   1. save()  — persiste a rule no banco (constraint de FK e DECIMAL corretos)
//   2. findById() — encontra por PK ou retorna null
//   3. findActiveBySellerId() — filtra por seller + active: true
//
// Para rodar: npm run test:int  (--runInBand obrigatório — um container por suite)
// ──────────────────────────────────────────────────────────────────────────────

const PG_USER = 'test_user'
const PG_PASS = 'test_pass'
const PG_DB   = 'test_db'

let container: StartedTestContainer
let db: KnexType

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_DB:       PG_DB,
      POSTGRES_USER:     PG_USER,
      POSTGRES_PASSWORD: PG_PASS,
    })
    .withExposedPorts(5432)
    .withWaitStrategy(
      Wait.forLogMessage('database system is ready to accept connections', 2),
    )
    .start()

  const port = container.getMappedPort(5432)
  const connectionUri = `postgresql://${PG_USER}:${PG_PASS}@localhost:${port}/${PG_DB}`

  db = Knex({
    client: 'pg',
    connection: connectionUri,
    migrations: {
      directory: path.resolve(__dirname, '../../../src/infrastructure/database/migrations'),
      loadExtensions: ['.ts'],
    },
  })

  await db.migrate.latest()
}, 120_000) // 2 min — pull da imagem Docker pode demorar na primeira execução

afterAll(async () => {
  await db.destroy()
  await container.stop()
})

// ── Helpers ────────────────────────────────────────────────────────────────────

let sellerCounter = 0

async function insertSeller(): Promise<string> {
  sellerCounter++
  const [row] = await db('sellers')
    .insert({
      name:     `Seller Split ${sellerCounter}`,
      document: `DOC-SPLIT-${sellerCounter}-${Date.now()}`,
      email:    `split${sellerCounter}-${Date.now()}@test.com`,
    })
    .returning('id') as Array<{ id: string }>
  if (!row) throw new Error('insertSeller: nenhuma linha retornada')
  return row.id
}

function makeRule(
  sellerId: string,
  rate: number,
  active?: boolean,
): SplitRule {
  return SplitRule.create({
    id:             SplitRuleId.create(),
    sellerId:       SellerId.of(sellerId),
    commissionRate: CommissionRate.of(rate),
    ...(active !== undefined && { active }),
  })
}

// ── Testes ────────────────────────────────────────────────────────────────────

describe('PostgresSplitRuleRepository (integration)', () => {
  let repo: PostgresSplitRuleRepository

  beforeEach(() => {
    repo = new PostgresSplitRuleRepository(db)
  })

  // ── save() ──────────────────────────────────────────────────────────────────

  describe('save()', () => {
    it('persiste a rule de forma que findById a encontra', async () => {
      const sellerId = await insertSeller()
      const rule = makeRule(sellerId, 0.15)

      await repo.save(rule)

      const found = await repo.findById(rule.id)
      expect(found).not.toBeNull()
      expect(found?.id).toBe(rule.id)
    })

    it('persiste commission_rate como DECIMAL — parseFloat recupera o valor original', async () => {
      const sellerId = await insertSeller()
      const rule = makeRule(sellerId, 0.0825)

      await repo.save(rule)

      const found = await repo.findById(rule.id)
      // pg retorna DECIMAL como string '0.0825'; parseFloat '0.0825' === 0.0825 em IEEE-754
      expect(found?.commissionRate).toBe(0.0825)
    })

    it('persiste active: false corretamente', async () => {
      const sellerId = await insertSeller()
      const rule = makeRule(sellerId, 0.10, false)

      await repo.save(rule)

      const found = await repo.findById(rule.id)
      expect(found?.active).toBe(false)
    })

    it('respeita a FK de seller_id — rejeita seller inexistente', async () => {
      const rule = makeRule(SellerId.create() as string, 0.15)

      await expect(repo.save(rule)).rejects.toThrow()
    })
  })

  // ── findById() ──────────────────────────────────────────────────────────────

  describe('findById()', () => {
    it('retorna null quando o id não existe', async () => {
      const result = await repo.findById(SplitRuleId.create())
      expect(result).toBeNull()
    })

    it('reconstitui sellerId corretamente', async () => {
      const sellerId = await insertSeller()
      const rule = makeRule(sellerId, 0.15)

      await repo.save(rule)

      const found = await repo.findById(rule.id)
      expect(found?.sellerId).toBe(sellerId)
    })

    it('converte commission_rate de string para number ao reconstituir', async () => {
      const sellerId = await insertSeller()
      // '0.1500' → parseFloat → 0.15
      const rule = makeRule(sellerId, 0.15)

      await repo.save(rule)

      const found = await repo.findById(rule.id)
      expect(found?.commissionRate).toBe(0.15)
    })

    it('preserva o campo active ao reconstituir', async () => {
      const sellerId = await insertSeller()
      const rule = makeRule(sellerId, 0.12, false)

      await repo.save(rule)

      const found = await repo.findById(rule.id)
      expect(found?.active).toBe(false)
    })
  })

  // ── findActiveBySellerId() ──────────────────────────────────────────────────

  describe('findActiveBySellerId()', () => {
    it('retorna a regra ativa do vendedor', async () => {
      const sellerId = await insertSeller()
      const rule = makeRule(sellerId, 0.15)

      await repo.save(rule)

      const found = await repo.findActiveBySellerId(SellerId.of(sellerId))
      expect(found).not.toBeNull()
      expect(found?.active).toBe(true)
      expect(found?.sellerId).toBe(sellerId)
    })

    it('retorna null quando seller não tem nenhuma regra', async () => {
      const sellerId = await insertSeller()

      const result = await repo.findActiveBySellerId(SellerId.of(sellerId))

      expect(result).toBeNull()
    })

    it('retorna null quando seller só tem regras inativas', async () => {
      const sellerId = await insertSeller()
      const rule = makeRule(sellerId, 0.15, false)

      await repo.save(rule)

      const result = await repo.findActiveBySellerId(SellerId.of(sellerId))
      expect(result).toBeNull()
    })

    it('converte commission_rate de string para number', async () => {
      const sellerId = await insertSeller()
      const rule = makeRule(sellerId, 0.08)

      await repo.save(rule)

      const found = await repo.findActiveBySellerId(SellerId.of(sellerId))
      expect(found?.commissionRate).toBe(0.08)
    })
  })
})
