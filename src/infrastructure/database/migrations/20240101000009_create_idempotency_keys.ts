import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('idempotency_keys', (t) => {
    t.text('key').primary()                       // o próprio header x-idempotency-key como PK
    t.jsonb('response_body')                      // resposta cacheada — nullable antes de completar
    t.integer('status_code')                      // HTTP status cacheado
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    t.timestamp('expires_at', { useTz: true }).notNullable()  // TTL configurável via IDEMPOTENCY_TTL_SECONDS
  })

  // Índice para o cleanup job — deleta chaves expiradas periodicamente
  await knex.raw('CREATE INDEX idx_idempotency_keys_expires_at ON idempotency_keys (expires_at)')
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('idempotency_keys')
}
