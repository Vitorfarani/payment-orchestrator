import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('sellers', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
    t.text('name').notNullable()
    t.text('document').notNullable().unique()   // CNPJ ou CPF
    t.text('email').notNullable().unique()
    t.text('bank_account')                      // nullable — preenchido no onboarding completo
    t.text('settlement_schedule').notNullable().defaultTo('D+14')
    t.text('status').notNullable().defaultTo('ACTIVE')
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })

  // TEXT + CHECK em vez de ENUM: mais fácil de migrar (ADR-016)
  await knex.raw(`
    ALTER TABLE sellers
      ADD CONSTRAINT sellers_settlement_schedule_check
        CHECK (settlement_schedule IN ('D+1','D+2','D+14','D+30')),
      ADD CONSTRAINT sellers_status_check
        CHECK (status IN ('ACTIVE','SUSPENDED','PENDING'))
  `)

  // Knex não expõe JSONB via builder — altera a coluna diretamente
  await knex.raw(`
    ALTER TABLE sellers
      ALTER COLUMN bank_account TYPE JSONB USING bank_account::JSONB
  `)

  // Função reutilizada por todas as tabelas com updated_at
  await knex.raw(`
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `)

  await knex.raw(`
    CREATE TRIGGER trg_sellers_updated_at
      BEFORE UPDATE ON sellers
      FOR EACH ROW EXECUTE FUNCTION set_updated_at()
  `)
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TRIGGER IF EXISTS trg_sellers_updated_at ON sellers')
  await knex.schema.dropTableIfExists('sellers')
  await knex.raw('DROP FUNCTION IF EXISTS set_updated_at() CASCADE')
}
