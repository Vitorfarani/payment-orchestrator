import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('audit_logs', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
    t.timestamp('occurred_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    t.text('actor_id').notNullable()
    t.text('actor_type').notNullable()
    t.specificType('actor_ip', 'INET')            // INET: tipo nativo PostgreSQL para IPs
    t.text('action').notNullable()                // ex: 'payment.created', 'split_rule.updated'
    t.text('resource_type').notNullable()         // ex: 'Payment', 'SplitRule'
    t.text('resource_id').notNullable()
    t.text('request_id')
    t.text('trace_id')
    t.jsonb('previous_state')
    t.jsonb('new_state')
    t.jsonb('metadata')
  })

  await knex.raw(`
    ALTER TABLE audit_logs
      ADD CONSTRAINT audit_logs_actor_type_check
        CHECK (actor_type IN ('user','merchant','system','worker'))
  `)

  // Índices para queries de auditoria por recurso e por ator
  await knex.raw('CREATE INDEX idx_audit_logs_resource ON audit_logs (resource_type, resource_id)')
  await knex.raw('CREATE INDEX idx_audit_logs_actor ON audit_logs (actor_id, occurred_at)')
  await knex.raw('CREATE INDEX idx_audit_logs_occurred_at ON audit_logs (occurred_at)')

  // ── Imutabilidade via RBAC (ADR-018) ─────────────────────────────────────────
  // Cria role se não existir (idempotente — migration pode rodar em ambientes
  // onde a role já foi criada manualmente)
  await knex.raw(`
    DO $$ BEGIN
      CREATE ROLE payment_app_role;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `)

  // Concede apenas leitura e inserção — a aplicação nunca altera ou exclui logs
  await knex.raw('GRANT SELECT, INSERT ON audit_logs TO payment_app_role')

  // REVOKE explícito: mesmo que no futuro alguém tente fazer GRANT UPDATE/DELETE
  // para PUBLIC, esta declaração torna a intenção clara no schema
  await knex.raw('REVOKE UPDATE, DELETE ON audit_logs FROM payment_app_role')
}

export async function down(knex: Knex): Promise<void> {
  // Reverte grants antes de dropar a tabela
  await knex.raw('REVOKE ALL ON audit_logs FROM payment_app_role')
  await knex.schema.dropTableIfExists('audit_logs')
  // Não dropa a role — pode estar sendo usada por outras tabelas futuras
}
