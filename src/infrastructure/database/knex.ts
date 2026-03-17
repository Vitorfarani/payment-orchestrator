import Knex from 'knex'
import knexConfig from './knexfile'

const env = process.env['NODE_ENV'] ?? 'development'
const config = knexConfig[env]

if (config === undefined) {
  throw new Error(`Knex config not found for environment: ${env}`)
}

export const db = Knex(config)
export default db
