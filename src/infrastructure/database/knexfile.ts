import type { Knex } from 'knex'
import path from 'path'

const migrationsDirectory = path.resolve(__dirname, 'migrations')
const seedsDirectory = path.resolve(__dirname, 'seeds')

const migrationsConfig: Knex.MigratorConfig = {
  directory: migrationsDirectory,
  extension: 'ts',
  loadExtensions: ['.ts'],
}

const seedsConfig: Knex.SeederConfig = {
  directory: seedsDirectory,
  extension: 'ts',
  loadExtensions: ['.ts'],
}

const databaseUrl =
  process.env['DATABASE_URL'] ??
  'postgresql://payment_user:payment_pass@localhost:5432/payment_orchestrator'

const poolMin = parseInt(process.env['DATABASE_POOL_MIN'] ?? '2', 10)
const poolMax = parseInt(process.env['DATABASE_POOL_MAX'] ?? '10', 10)

const knexConfig: Record<string, Knex.Config> = {
  development: {
    client: 'pg',
    connection: databaseUrl,
    pool: { min: poolMin, max: poolMax },
    migrations: migrationsConfig,
    seeds: seedsConfig,
  },
  test: {
    client: 'pg',
    connection: databaseUrl,
    pool: { min: 1, max: 5 },
    migrations: migrationsConfig,
    seeds: seedsConfig,
  },
  production: {
    client: 'pg',
    connection: {
      connectionString: databaseUrl,
      ssl: { rejectUnauthorized: true },
    },
    pool: { min: poolMin, max: poolMax },
    migrations: migrationsConfig,
  },
}

export default knexConfig
