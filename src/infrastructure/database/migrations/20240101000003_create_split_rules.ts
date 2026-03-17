import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('split_rules', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
    t.uuid('seller_id').notNullable().references('id').inTable('sellers')

    // commission_rate: armazenado como DECIMAL(5,4) — exceção documentada ao ADR-001.
    // Taxa é um ratio (0.0150 = 1.5%), não valor monetário. Alternativa seria
    // basis_points BIGINT (150 = 1.5%), mas DECIMAL é mais legível aqui.
    t.decimal('commission_rate', 5, 4)
    t.bigInteger('flat_fee_cents')
    t.boolean('active').notNullable().defaultTo(true)

    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })

  await knex.raw(`
    ALTER TABLE split_rules
      ADD CONSTRAINT split_rules_commission_rate_check
        CHECK (commission_rate >= 0.0 AND commission_rate <= 1.0),
      ADD CONSTRAINT split_rules_flat_fee_cents_check
        CHECK (flat_fee_cents >= 0),
      ADD CONSTRAINT split_rules_at_least_one_check
        CHECK (commission_rate IS NOT NULL OR flat_fee_cents IS NOT NULL)
  `)

  // Índice composto na FK — cobre lookup "active split rule for seller"
  await knex.raw('CREATE INDEX idx_split_rules_seller_active ON split_rules (seller_id, active)')

  await knex.raw(`
    CREATE TRIGGER trg_split_rules_updated_at
      BEFORE UPDATE ON split_rules
      FOR EACH ROW EXECUTE FUNCTION set_updated_at()
  `)
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TRIGGER IF EXISTS trg_split_rules_updated_at ON split_rules')
  await knex.schema.dropTableIfExists('split_rules')
}
