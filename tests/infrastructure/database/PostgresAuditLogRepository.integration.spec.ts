import { GenericContainer, Wait } from 'testcontainers'
import type { StartedTestContainer } from 'testcontainers'
import Knex from 'knex'
import type { Knex as KnexType } from 'knex'
import path from 'path'
import { PostgresAuditLogRepository } from '../../../src/infrastructure/database/repositories/PostgresAuditLogRepository'
import type { InsertAuditLogInput } from '../../../src/infrastructure/audit/AuditAction'

// ──────────────────────────────────────────────────────────────────────────────
// Integration tests — PostgresAuditLogRepository com PostgreSQL real
//
// O que testamos:
//   1. save()              — INSERT com campos obrigatórios
//   2. save() campos null  — actorIp, requestId, traceId, states e metadata null
//   3. save() JSONB        — previousState / newState / metadata round-trip
//   4. constraint CHECK    — actor_type inválido rejeitado pelo banco
//   5. imutabilidade RBAC  — DELETE via payment_app_role falha (ADR-018, REVOKE)
//   6. UPDATE bloqueado    — UPDATE via payment_app_role falha (ADR-018, REVOKE)
//
// Para rodar: npm run test:int
// ──────────────────────────────────────────────────────────────────────────────

const PG_USER = 'test_user'
const PG_PASS = 'test_pass'
const PG_DB   = 'test_db'

// Usuário restrito criado no beforeAll para testar o REVOKE da migration
const RESTRICTED_USER = 'payment_app_tester'
const RESTRICTED_PASS = 'tester_pass'

let container: StartedTestContainer
let db: KnexType
let restrictedDb: KnexType   // conectado como payment_app_tester (payment_app_role)

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
  const adminUri     = `postgresql://${PG_USER}:${PG_PASS}@localhost:${port}/${PG_DB}`
  const restrictedUri = `postgresql://${RESTRICTED_USER}:${RESTRICTED_PASS}@localhost:${port}/${PG_DB}`

  db = Knex({
    client: 'pg',
    connection: adminUri,
    pool: { min: 2, max: 5 },
    migrations: {
      directory: path.resolve(__dirname, '../../../src/infrastructure/database/migrations'),
      loadExtensions: ['.ts'],
    },
  })

  // Migrations criam a tabela audit_logs e a payment_app_role com REVOKE DELETE/UPDATE
  await db.migrate.latest()

  // Cria usuário de teste com a role restrita — idempotente
  await db.raw(`
    DO $$ BEGIN
      CREATE USER ${RESTRICTED_USER} WITH PASSWORD '${RESTRICTED_PASS}';
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `)
  await db.raw(`GRANT payment_app_role TO ${RESTRICTED_USER}`)

  // Conexão restrita: representa a aplicação rodando como payment_app_role
  restrictedDb = Knex({
    client: 'pg',
    connection: restrictedUri,
    pool: { min: 1, max: 3 },
  })
}, 120_000)

afterAll(async () => {
  await restrictedDb.destroy()
  await db.destroy()
  await container.stop()
})

// ── Helper ────────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<InsertAuditLogInput> = {}): InsertAuditLogInput {
  return {
    actorId:       'user-123',
    actorType:     'user',
    actorIp:       null,
    action:        'payment.created',
    resourceType:  'Payment',
    resourceId:    'pay-abc',
    requestId:     null,
    traceId:       null,
    previousState: null,
    newState:      null,
    metadata:      null,
    ...overrides,
  }
}

// ── Testes ────────────────────────────────────────────────────────────────────

describe('PostgresAuditLogRepository (integration)', () => {
  let repo: PostgresAuditLogRepository

  beforeEach(() => {
    repo = new PostgresAuditLogRepository(db)
  })

  // ── 1. save() — campos obrigatórios ────────────────────────────────────────

  describe('save()', () => {
    it('persiste um registro de auditoria e o encontra no banco', async () => {
      const resourceId = `pay-${Date.now()}`
      await repo.save(makeEntry({ resourceId }))

      const rows = await db('audit_logs').where({ resource_id: resourceId })
      expect(rows.length).toBe(1)

      const row = rows[0]
      expect(row?.actor_id).toBe('user-123')
      expect(row?.actor_type).toBe('user')
      expect(row?.action).toBe('payment.created')
      expect(row?.resource_type).toBe('Payment')
      expect(row?.resource_id).toBe(resourceId)
    })

    it('gera id e occurred_at internamente — chamador não precisa fornecer', async () => {
      const resourceId = `pay-uuid-${Date.now()}`
      await repo.save(makeEntry({ resourceId }))

      const rows = await db('audit_logs').where({ resource_id: resourceId })
      const row  = rows[0]

      expect(row?.id).toBeTruthy()
      expect(row?.occurred_at).toBeInstanceOf(Date)
    })

    it('aceita todos os actorTypes válidos', async () => {
      const types: InsertAuditLogInput['actorType'][] = ['user', 'merchant', 'system', 'worker']

      for (const actorType of types) {
        const resourceId = `pay-type-${actorType}-${Date.now()}`
        await expect(
          repo.save(makeEntry({ actorType, resourceId })),
        ).resolves.toBeUndefined()
      }
    })
  })

  // ── 2. save() — campos opcionais null ─────────────────────────────────────

  describe('save() com campos null', () => {
    it('persiste corretamente quando todos os opcionais são null', async () => {
      const resourceId = `pay-null-${Date.now()}`
      await repo.save(makeEntry({ resourceId }))

      const rows = await db('audit_logs').where({ resource_id: resourceId })
      const row  = rows[0]

      expect(row?.actor_ip).toBeNull()
      expect(row?.request_id).toBeNull()
      expect(row?.trace_id).toBeNull()
      expect(row?.previous_state).toBeNull()
      expect(row?.new_state).toBeNull()
      expect(row?.metadata).toBeNull()
    })

    it('persiste com actorIp preenchido (tipo INET do PostgreSQL)', async () => {
      const resourceId = `pay-ip-${Date.now()}`
      await repo.save(makeEntry({ actorIp: '192.168.1.42', resourceId }))

      const rows = await db('audit_logs').where({ resource_id: resourceId })
      expect(rows[0]?.actor_ip).toBe('192.168.1.42')
    })
  })

  // ── 3. JSONB round-trip ────────────────────────────────────────────────────

  describe('JSONB round-trip', () => {
    it('persiste e recupera previousState e newState com fidelidade', async () => {
      const resourceId = `pay-jsonb-${Date.now()}`
      const previous   = { status: 'PENDING',    amount: 5000 }
      const next       = { status: 'PROCESSING', amount: 5000 }

      await repo.save(makeEntry({
        resourceId,
        previousState: previous,
        newState:      next,
      }))

      const rows = await db('audit_logs').where({ resource_id: resourceId })
      const row  = rows[0]

      expect(row?.previous_state).toEqual(previous)
      expect(row?.new_state).toEqual(next)
    })

    it('persiste e recupera metadata com fidelidade', async () => {
      const resourceId = `pay-meta-${Date.now()}`
      const metadata   = { gateway: 'asaas', attempt: 1, idempotencyKey: 'abc-123' }

      await repo.save(makeEntry({ resourceId, metadata }))

      const rows = await db('audit_logs').where({ resource_id: resourceId })
      expect(rows[0]?.metadata).toEqual(metadata)
    })
  })

  // ── 4. Constraint CHECK — actor_type ──────────────────────────────────────

  describe('constraint CHECK actor_type', () => {
    it('rejeita actor_type fora do enum permitido', async () => {
      await expect(
        db('audit_logs').insert({
          id:            '00000000-0000-4000-8000-000000000001',
          actor_id:      'x',
          actor_type:    'hacker',    // inválido
          action:        'payment.created',
          resource_type: 'Payment',
          resource_id:   'pay-x',
        }),
      ).rejects.toThrow()
    })
  })

  // ── 5 & 6. Imutabilidade — REVOKE DELETE, UPDATE via payment_app_role ──────
  //
  // O teste conecta como payment_app_tester (que herda payment_app_role).
  // A migration rodou REVOKE UPDATE, DELETE ON audit_logs FROM payment_app_role.
  // Qualquer tentativa de modificar a tabela deve ser rejeitada pelo banco.
  //
  // Propósito: garantir que a garantia de ADR-018 está ativa na infra real,
  // não apenas documentada. Esse é o único teste que usa `restrictedDb`.

  describe('imutabilidade via RBAC (ADR-018)', () => {
    it('DELETE via payment_app_role falha com permission denied', async () => {
      // Insere uma linha como admin para ter algo a deletar
      const resourceId = `pay-del-${Date.now()}`
      await repo.save(makeEntry({ resourceId }))

      // Tenta deletar como usuário restrito — deve falhar
      await expect(
        restrictedDb('audit_logs').where({ resource_id: resourceId }).delete(),
      ).rejects.toThrow(/permission denied/i)
    })

    it('UPDATE via payment_app_role falha com permission denied', async () => {
      const resourceId = `pay-upd-${Date.now()}`
      await repo.save(makeEntry({ resourceId }))

      await expect(
        restrictedDb('audit_logs')
          .where({ resource_id: resourceId })
          .update({ action: 'payment.refunded' }),
      ).rejects.toThrow(/permission denied/i)
    })

    it('INSERT via payment_app_role funciona (GRANT INSERT está ativo)', async () => {
      // Valida que o GRANT INSERT está correto — a aplicação precisa conseguir inserir
      await expect(
        restrictedDb('audit_logs').insert({
          id:            '00000000-0000-4000-8000-000000000099',
          actor_id:      'worker-1',
          actor_type:    'worker',
          action:        'payment.created',
          resource_type: 'Payment',
          resource_id:   `pay-rbac-insert-${Date.now()}`,
        }),
      ).resolves.toBeDefined()
    })

    it('SELECT via payment_app_role funciona (GRANT SELECT está ativo)', async () => {
      const resourceId = `pay-sel-${Date.now()}`
      await repo.save(makeEntry({ resourceId }))

      const rows = await restrictedDb('audit_logs').where({ resource_id: resourceId })
      expect(rows.length).toBe(1)
    })
  })
})
