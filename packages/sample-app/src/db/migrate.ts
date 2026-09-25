/**
 * Schema migrations for DeleteProof sample app.
 *
 * Tables:
 *   customers         – live customer records
 *   tombstones        – immutable deletion markers (the repair mechanism)
 *   customer_lock_key – advisory lock namespace (BigInt hash of customer ID)
 *   barriers          – cross-process synchronisation for scenario runners
 *   job_completions   – worker acknowledgement records for scenario coordination
 */
import { getPool, closePool } from './pool';

const DDL = /* sql */ `
-- customers: live records
CREATE TABLE IF NOT EXISTS customers (
  id          UUID PRIMARY KEY,
  email       TEXT NOT NULL,
  name        TEXT NOT NULL,
  profile     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- tombstones: immutable deletion markers – the core repair mechanism
-- Once a row exists here the customer MUST NOT be recreated.
CREATE TABLE IF NOT EXISTS tombstones (
  customer_id UUID PRIMARY KEY,
  deleted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  run_id      TEXT NOT NULL
);

-- barriers: cross-process synchronisation for test scenarios
-- A barrier row with released=false pauses the worker.
CREATE TABLE IF NOT EXISTS barriers (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL,
  released   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- job_completions: the worker writes here when it finishes a job
-- (regardless of whether it wrote the customer record)
CREATE TABLE IF NOT EXISTS job_completions (
  job_id         TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL,
  customer_id    UUID NOT NULL,
  outcome        TEXT NOT NULL,  -- 'written' | 'skipped_tombstone' | 'error'
  completed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- trace_events: ordered log shared between API, worker, and scenarios
CREATE TABLE IF NOT EXISTS trace_events (
  id          BIGSERIAL PRIMARY KEY,
  run_id      TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind        TEXT NOT NULL,
  message     TEXT NOT NULL,
  data        JSONB
);
CREATE INDEX IF NOT EXISTS trace_events_run_id ON trace_events (run_id, seq);
`;

async function migrate(): Promise<void> {
  const pool = getPool();
  console.log('Running schema migrations…');
  await pool.query(DDL);
  console.log('Migrations complete.');
  await closePool();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});



