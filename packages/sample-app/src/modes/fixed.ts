/**
 * FIXED mode — transactional repair.
 *
 * Both delete and worker:
 *   READ COMMITTED
 *   SET LOCAL application_name = 'dp:{runId}:{actor}'
 *   first statement: pg_advisory_xact_lock(customer_lock_key(id))
 *
 * Delete:
 *   lock → INSERT tombstone ON CONFLICT DO NOTHING → DELETE
 *   → barrier api.before_commit → COMMIT
 *
 * Worker:
 *   lock → SELECT tombstone
 *   → if found: blocked_by_tombstone, COMMIT (no write)
 *   → else: barrier worker.before_write → upsert → COMMIT
 */
import type pg from 'pg';
import { atBarrier, BarrierTimeoutError } from '../barriers.js';
import { emitTrace } from '../trace.js';

async function beginTagged(
  client: pg.PoolClient,
  runId: string,
  actor: 'api' | 'worker',
): Promise<void> {
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  // SET LOCAL does not accept bind parameters — use set_config(..., is_local=true)
  await client.query(`SELECT set_config('application_name', $1, true)`, [
    `dp:${runId}:${actor}`,
  ]);
}

export async function deleteCustomerFixed(
  client: pg.PoolClient,
  runId: string,
  customerId: string,
): Promise<void> {
  try {
    await beginTagged(client, runId, 'api');
    await client.query(`SELECT pg_advisory_xact_lock(customer_lock_key($1::uuid))`, [customerId]);
    await client.query(
      `INSERT INTO customer_tombstones (customer_id, deleted_at, run_id)
       VALUES ($1, now(), $2)
       ON CONFLICT (customer_id) DO NOTHING`,
      [customerId, runId],
    );
    await client.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
    await emitTrace(
      runId,
      'customer_deleted',
      `[FIXED] Tombstone + delete prepared for ${customerId}`,
      { customerId, mode: 'fixed' },
      'api',
    );

    try {
      await atBarrier(runId, 'api.before_commit', 'api');
    } catch (err) {
      if (err instanceof BarrierTimeoutError) {
        await client.query('ROLLBACK');
        throw err;
      }
      throw err;
    }

    await client.query('COMMIT');
    await emitTrace(
      runId,
      'deletion_committed',
      `[FIXED] Customer ${customerId} deleted with tombstone`,
      { customerId, mode: 'fixed' },
      'api',
    );
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export async function processSyncFixed(
  client: pg.PoolClient,
  runId: string,
  customerId: string,
  opts: {
    email: string;
    name: string;
    profilePatch: Record<string, unknown>;
    jobId: string;
  },
): Promise<'written' | 'blocked_by_tombstone'> {
  await emitTrace(
    runId,
    'worker_processing',
    `[FIXED] Worker processing job ${opts.jobId}`,
    { jobId: opts.jobId, customerId },
    'worker',
  );

  // Hold before lock so multiple jobs can be paused before delete commits
  // (duplicate-stale-delivery). After release, each acquires the lock and
  // sees the tombstone.
  try {
    await atBarrier(runId, 'worker.job_received', 'worker');
  } catch (err) {
    if (err instanceof BarrierTimeoutError) throw err;
    throw err;
  }

  try {
    await beginTagged(client, runId, 'worker');
    await client.query(`SELECT pg_advisory_xact_lock(customer_lock_key($1::uuid))`, [customerId]);
    await emitTrace(
      runId,
      'worker_processing',
      `[FIXED] Lock acquired for ${customerId}`,
      { customerId, jobId: opts.jobId },
      'worker',
    );

    const tombstone = await client.query(
      `SELECT customer_id FROM customer_tombstones WHERE customer_id = $1`,
      [customerId],
    );

    if (tombstone.rows.length > 0) {
      await emitTrace(
        runId,
        'worker_blocked_by_tombstone',
        `[FIXED] Tombstone found — write skipped for customer ${customerId}`,
        { customerId, jobId: opts.jobId },
        'worker',
      );
      await client.query('COMMIT');
      return 'blocked_by_tombstone';
    }

    try {
      await atBarrier(runId, 'worker.before_write', 'worker');
    } catch (err) {
      if (err instanceof BarrierTimeoutError) {
        await client.query('ROLLBACK');
        throw err;
      }
      throw err;
    }

    await emitTrace(
      runId,
      'worker_write_attempted',
      `[FIXED] No tombstone — upserting customer ${customerId}`,
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

    await client.query('COMMIT');
    await emitTrace(
      runId,
      'worker_write_committed',
      `[FIXED] Customer update committed for ${customerId}`,
      { customerId, jobId: opts.jobId },
      'worker',
    );
    return 'written';
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }
}
