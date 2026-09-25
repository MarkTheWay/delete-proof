/**
 * Schema for DeleteProof sample app.
 *
 * customers              – live customer records
 * customer_tombstones    – durable deletion markers (repair)
 * customer_lock_key(uuid) – wraps hashtextextended for advisory locks
 */
import { loadEnv } from '../config.js';
import { getPool, closePool } from './pool.js';

loadEnv();

const DDL = /* sql */ `
CREATE TABLE IF NOT EXISTS customers (
  id          UUID PRIMARY KEY,
  email       TEXT NOT NULL,
  name        TEXT NOT NULL,
  profile     JSONB NOT NULL DEFAULT '{}'::jsonb,
  run_id      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customer_tombstones (
  customer_id UUID PRIMARY KEY,
  deleted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  run_id      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS customers_run_id_idx ON customers (run_id);
CREATE INDEX IF NOT EXISTS customer_tombstones_run_id_idx ON customer_tombstones (run_id);

CREATE OR REPLACE FUNCTION customer_lock_key(id uuid)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT hashtextextended(id::text, 0);
$$;
`;

async function migrate(): Promise<void> {
  const pool = getPool();
  console.log('Running schema migrations…');
  await pool.query(DDL);
  // Drop legacy demo tables if present from earlier drafts
  await pool.query(`
    DROP TABLE IF EXISTS barriers;
    DROP TABLE IF EXISTS job_completions;
    DROP TABLE IF EXISTS trace_events;
    DROP TABLE IF EXISTS tombstones;
  `);
  console.log('Migrations complete.');
  await closePool();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
