import { Pool } from 'pg';
import { config } from '../config';

const isInternalRailway = config.databaseUrl.includes('.railway.internal');
const sslConfig = (isInternalRailway || config.databaseUrl.includes('sslmode=disable'))
  ? false as const
  : { rejectUnauthorized: false };

export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: sslConfig,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err: Error) => {
  console.error(`[${new Date().toISOString()}] [ERROR] Unexpected PostgreSQL pool error:`, err.message);
});
