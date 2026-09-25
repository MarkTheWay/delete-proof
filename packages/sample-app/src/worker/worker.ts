/**
 * BullMQ worker — processes profile-update events.
 *
 * VULNERABLE mode: performs a naive upsert without checking tombstones.
 *   If a stale event arrives after deletion, the customer is recreated.
 *
 * FIXED mode: acquires the same advisory lock as the deletion path inside a
 *   transaction, then checks for a tombstone before writing.
 *   Because the lock is exclusive and transactional, there is no TOCTOU gap:
 *   whichever side (deletion or worker) acquires the lock first wins, and
 *   the other side sees the committed state before proceeding.
 */
import { Worker, type Job } from 'bullmq';
import { getPool } from '../db/pool';
import { emitTrace } from '../db/trace';

export interface ProfileUpdatePayload {
  runId: string;
  customerId: string;
  mode: 'vulnerable' | 'fixed';
  profilePatch: Record<string, unknown>;
  jobId: string;
  // Synthetic customer data (used for vulnerable upsert)
  email: string;
  name: string;
}

/** Deterministic BigInt hash of a UUID string for pg_advisory_xact_lock */
function lockKey(customerId: string): bigint {
  let h = 5381n;
  for (const ch of customerId) {
    h = ((h << 5n) + h + BigInt(ch.charCodeAt(0))) & 0x7fffffffffffffffn;
  }
  return h;
}

async function waitForBarrier(runId: string, jobId: string): Promise<void> {
  const pool = getPool();
  const barrierId = `${runId}:worker_hold`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ released: boolean }>(
      `SELECT released FROM barriers WHERE id = $1`,
      [barrierId],
    );
    if (result.rows.length === 0 || result.rows[0].released) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Barrier wait timeout for job ${jobId}`);
}

async function processVulnerable(job: Job<ProfileUpdatePayload>): Promise<void> {
  const pool = getPool();
  const { runId, customerId, profilePatch, jobId, email, name } = job.data;

  await emitTrace(pool, runId, 'worker_processing', `[VULNERABLE] Worker processing job ${jobId}`, { jobId, customerId });

  // Block at barrier until runner releases it (after deletion)
  await waitForBarrier(runId, jobId);

  await emitTrace(pool, runId, 'worker_write_attempted', `[VULNERABLE] Worker upsert for customer ${customerId}`, { customerId });

  // THE VULNERABLE WRITE: upsert ignores tombstones / deletion
  await pool.query(
    `INSERT INTO customers (id, email, name, profile, created_at, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, now(), now())
     ON CONFLICT (id) DO UPDATE
       SET profile = customers.profile || $4::jsonb,
           updated_at = now()`,
    [customerId, email, name, JSON.stringify(profilePatch)],
  );

  await pool.query(
    `INSERT INTO job_completions (job_id, run_id, customer_id, outcome)
     VALUES ($1, $2, $3, 'written')
     ON CONFLICT (job_id) DO NOTHING`,
    [jobId, runId, customerId],
  );

  await emitTrace(pool, runId, 'db_assertion', `[VULNERABLE] Upsert committed — customer may have been resurrected`, { customerId });
}

async function processFixed(job: Job<ProfileUpdatePayload>): Promise<void> {
  const pool = getPool();
  const { runId, customerId, profilePatch, jobId, email, name } = job.data;

  await emitTrace(pool, runId, 'worker_processing', `[FIXED] Worker processing job ${jobId}`, { jobId, customerId });

  // Block at barrier until runner releases it (after deletion)
  await waitForBarrier(runId, jobId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Acquire the same advisory lock as the deletion path — blocks if deletion
    // is still in progress; sees committed tombstone once lock is granted
    await client.query(`SELECT pg_advisory_xact_lock($1)`, [lockKey(customerId).toString()]);

    const tombstone = await client.query(
      `SELECT customer_id FROM tombstones WHERE customer_id = $1`,
      [customerId],
    );

    if (tombstone.rows.length > 0) {
      await client.query('COMMIT');
      await pool.query(
        `INSERT INTO job_completions (job_id, run_id, customer_id, outcome)
         VALUES ($1, $2, $3, 'skipped_tombstone')
         ON CONFLICT (job_id) DO NOTHING`,
        [jobId, runId, customerId],
      );
      await emitTrace(pool, runId, 'worker_blocked_by_tombstone',
        `[FIXED] Tombstone found — write skipped for customer ${customerId}`, { customerId, jobId });
    } else {
      await client.query(
        `INSERT INTO customers (id, email, name, profile, created_at, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, now(), now())
         ON CONFLICT (id) DO UPDATE
           SET profile = customers.profile || $4::jsonb,
               updated_at = now()`,
        [customerId, email, name, JSON.stringify(profilePatch)],
      );
      await client.query('COMMIT');
      await pool.query(
        `INSERT INTO job_completions (job_id, run_id, customer_id, outcome)
         VALUES ($1, $2, $3, 'written')
         ON CONFLICT (job_id) DO NOTHING`,
        [jobId, runId, customerId],
      );
      await emitTrace(pool, runId, 'worker_write_attempted',
        `[FIXED] No tombstone — customer update committed for ${customerId}`, { customerId, jobId });
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ─── Worker startup ───────────────────────────────────────────────────────────
const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
const connection = { host: redisUrl.hostname, port: Number(redisUrl.port || 6379) };

const worker = new Worker<ProfileUpdatePayload>(
  'profile-updates',
  async (job) => {
    if (job.data.mode === 'fixed') {
      await processFixed(job);
    } else {
      await processVulnerable(job);
    }
  },
  { connection, concurrency: 5 },
);

worker.on('completed', (job) => {
  console.log(`[worker] Job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`[worker] Job ${job?.id} failed:`, err.message);
});

console.log('[worker] DeleteProof worker started');

process.on('SIGTERM', async () => {
  await worker.close();
  process.exit(0);
});



