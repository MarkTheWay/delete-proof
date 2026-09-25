/**
 * DEMO FIXTURE — vulnerable mode.
 *
 * Delete: plain DELETE (no tombstone, no advisory lock).
 * Worker: INSERT … ON CONFLICT DO UPDATE (ignores deletion).
 *
 * Barriers (when DELETEPROOF_TEST_HOOKS=1) make the race deterministic;
 * they are not a repair.
 */
import type pg from 'pg';
import { atBarrier, BarrierTimeoutError } from '../barriers.js';
import { emitTrace } from '../trace.js';

export async function deleteCustomerVulnerable(
  client: pg.PoolClient,
  runId: string,
  customerId: string,
): Promise<void> {
  await client.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  await emitTrace(
    runId,
    'deletion_committed',
    `[VULNERABLE] Customer ${customerId} deleted (no tombstone)`,
    { customerId, mode: 'vulnerable' },
    'api',
  );
}

export async function processSyncVulnerable(
  client: pg.PoolClient,
  runId: string,
  customerId: string,
  opts: {
    email: string;
    name: string;
    profilePatch: Record<string, unknown>;
    jobId: string;
  },
): Promise<'written'> {
  await emitTrace(
    runId,
    'worker_processing',
    `[VULNERABLE] Worker processing job ${opts.jobId}`,
    { jobId: opts.jobId, customerId },
    'worker',
  );

  try {
    await atBarrier(runId, 'worker.job_received', 'worker');
  } catch (err) {
    if (err instanceof BarrierTimeoutError) throw err;
    throw err;
  }

  try {
    await atBarrier(runId, 'worker.before_write', 'worker');
  } catch (err) {
    if (err instanceof BarrierTimeoutError) {
      throw err;
    }
    throw err;
  }

  await emitTrace(
    runId,
    'worker_write_attempted',
    `[VULNERABLE] Worker upsert for customer ${customerId}`,
    { customerId, jobId: opts.jobId },
    'worker',
  );

  await client.query(
    `INSERT INTO customers (id, email, name, profile, run_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, now(), now())
     ON CONFLICT (id) DO UPDATE
       SET profile = customers.profile || EXCLUDED.profile,
           updated_at = now()`,
    [customerId, opts.email, opts.name, JSON.stringify(opts.profilePatch), runId],
  );

  await emitTrace(
    runId,
    'worker_write_committed',
    `[VULNERABLE] Upsert committed — customer may have been resurrected`,
    { customerId, jobId: opts.jobId },
    'worker',
  );

  return 'written';
}
