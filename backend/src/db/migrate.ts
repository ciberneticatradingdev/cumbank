import { pool } from './pool';
import { logger } from '../utils/logger';

const MIGRATIONS: string[] = [
  // Version 1: Initial schema
  `
  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS claim_rounds (
    id SERIAL PRIMARY KEY,
    tx_signature TEXT NOT NULL,
    amount_usdc NUMERIC(20, 6) NOT NULL,
    fee_account TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'completed',
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS snapshots (
    id SERIAL PRIMARY KEY,
    holder_count INTEGER NOT NULL,
    total_supply NUMERIC(30, 6) NOT NULL,
    token_mint TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS snapshot_holders (
    id SERIAL PRIMARY KEY,
    snapshot_id INTEGER REFERENCES snapshots(id),
    wallet TEXT NOT NULL,
    token_balance NUMERIC(30, 6) NOT NULL,
    percentage NUMERIC(10, 6) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS distributions (
    id SERIAL PRIMARY KEY,
    claim_round_id INTEGER REFERENCES claim_rounds(id),
    snapshot_id INTEGER REFERENCES snapshots(id),
    total_amount_usdc NUMERIC(20, 6) NOT NULL,
    holder_count INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS distribution_payments (
    id SERIAL PRIMARY KEY,
    distribution_id INTEGER REFERENCES distributions(id),
    wallet TEXT NOT NULL,
    amount_usdc NUMERIC(20, 6) NOT NULL,
    token_balance NUMERIC(30, 6) NOT NULL,
    percentage NUMERIC(10, 6) NOT NULL,
    tx_signature TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    sent_at TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS events (
    id SERIAL PRIMARY KEY,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    data JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_claim_rounds_created ON claim_rounds(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_snapshots_created ON snapshots(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_distributions_created ON distributions(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_distribution_payments_wallet ON distribution_payments(wallet);
  CREATE INDEX IF NOT EXISTS idx_distribution_payments_dist_id ON distribution_payments(distribution_id);
  CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
  `,
];

export async function runMigrations(): Promise<void> {
  logger.info('Running database migrations...');

  // Ensure schema_version table exists first
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  const result = await pool.query<{ version: number }>(
    'SELECT COALESCE(MAX(version), 0) as version FROM schema_version'
  );
  const currentVersion = result.rows[0].version;
  logger.info('Current schema version', { currentVersion });

  for (let i = currentVersion; i < MIGRATIONS.length; i++) {
    const version = i + 1;
    logger.info(`Applying migration v${version}...`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(MIGRATIONS[i]);
      await client.query('INSERT INTO schema_version (version) VALUES ($1)', [version]);
      await client.query('COMMIT');
      logger.info(`Migration v${version} applied successfully`);
    } catch (err) {
      await client.query('ROLLBACK');
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(`Migration v${version} failed`, { error: errorMessage });
      throw err;
    } finally {
      client.release();
    }
  }

  logger.info('All migrations complete', { version: MIGRATIONS.length });
}
