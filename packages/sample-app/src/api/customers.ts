/**
 * Customer service — API-layer operations.
 *
 * DELETION REPAIR EXPLANATION
 * ═══════════════════════════
 *
 * Invariant: After deletion commits, no async processing must recreate the customer.
 *
 * Vulnerable path (deleteCustomerVulnerable):
 *   Simply DELETE FROM customers WHERE id = $1. If a stale event is already
 *   being processed concurrently in the worker and reaches its upsert AFTER
 *   this DELETE commits, the customer row is recreated — the invariant is violated.
 *
 * Fixed path (deleteCustomerFixed):
 *   1. BEGIN transaction with READ COMMITTED isolation.
 *   2. Acquire pg_advisory_xact_lock(hashCustomerId(id)) — exclusive, released
 *      automatically when the transaction ends. Any concurrent worker transaction
 *      trying to acquire the same lock BLOCKS here.
 *   3. INSERT INTO tombstones (customer_id, …) — the durable deletion marker.
 *   4. DELETE FROM customers WHERE id = $1.
 *   5. COMMIT — tombstone and deletion are atomic.
 *
 * Worker (fixed mode):
 *   1. BEGIN transaction.
 *   2. Acquire pg_advisory_xact_lock(hashCustomerId(id)) — blocks until deletion
 *      releases it, ensuring it sees the committed tombstone.
 *   3. SELECT FROM tombstones WHERE customer_id = $1 — within the same snapshot
 *      that holds the lock; no TOCTOU gap.
 *   4. If tombstone found → skip write, COMMIT (no-op), ack job.
 *   5. If no tombstone → write customer, COMMIT.
 *
 * Both orderings are safe:
 *   • Deletion first: tombstone committed before worker acquires lock → worker sees
 *     tombstone → skips write.
 *   • Worker first: worker commits customer write → deletion acquires lock, inserts
 *     tombstone, deletes customer → customer removed again (fine for active case,
 *     but race is avoided by not allowing this in the demo — deletion comes after
 *     the barrier ensures the worker starts with a stale snapshot).
 */
import { v4 as uuidv4 } from 'uuid';
import type pg from 'pg';
import { getPool } from '../db/pool';
import { emitTrace } from '../db/trace';
import type { Customer, Mode } from '@delete-proof/shared';

/** Deterministic BigInt hash of a UUID string for pg_advisory_xact_lock */
function lockKey(customerId: string): bigint {
  // Use the lower 63 bits of a simple hash to stay within pg's bigint range
  let h = 5381n;
  for (const ch of customerId) {
    h = ((h << 5n) + h + BigInt(ch.charCodeAt(0))) & 0x7fffffffffffffffn;
  }
  return h;
}

export async function createCustomer(
  runId: string,
  opts: { email: string; name: string },
): Promise<Customer> {
  const pool = getPool();
  const id = uuidv4();
  const now = new Date().toISOString();
  await pool.query(
    `INSERT INTO customers (id, email, name, profile, created_at, updated_at)
     VALUES ($1, $2, $3, '{}', now(), now())`,
    [id, opts.email, opts.name],
  );
  await emitTrace(pool, runId, 'customer_created', `Customer ${id} created`, { id, email: opts.email });
  return { id, email: opts.email, name: opts.name, profile: {}, createdAt: now, updatedAt: now };
}

export async function getCustomer(customerId: string): Promise<Customer | null> {
  const pool = getPool();
  const result = await pool.query<{
    id: string; email: string; name: string; profile: Record<string, unknown>;
    created_at: Date; updated_at: Date;
  }>(
    `SELECT id, email, name, profile, created_at, updated_at FROM customers WHERE id = $1`,
    [customerId],
  );
  if (result.rows.length === 0) return null;
  const r = result.rows[0];
  return {
    id: r.id, email: r.email, name: r.name, profile: r.profile,
    createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
  };
}

/**
 * VULNERABLE deletion — just DELETE, no tombstone.
 * Demonstrates how a stale async event can resurrect the customer.
 */
export async function deleteCustomerVulnerable(runId: string, customerId: string): Promise<void> {
  const pool = getPool();
  await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  await emitTrace(pool, runId, 'deletion_committed', `[VULNERABLE] Customer ${customerId} deleted (no tombstone)`, {
    customerId, mode: 'vulnerable',
  });
}

/**
 * FIXED deletion — inserts tombstone + deletes customer in one transaction,
 * holding the advisory lock throughout so the worker cannot write concurrently.
 */
export async function deleteCustomerFixed(runId: string, customerId: string): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock($1)`, [lockKey(customerId).toString()]);
    await client.query(
      `INSERT INTO tombstones (customer_id, deleted_at, run_id) VALUES ($1, now(), $2)
       ON CONFLICT (customer_id) DO NOTHING`,
      [customerId, runId],
    );
    await client.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
    await client.query('COMMIT');
    await emitTrace(pool, runId, 'deletion_committed', `[FIXED] Customer ${customerId} deleted with tombstone`, {
      customerId, mode: 'fixed',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteCustomer(runId: string, customerId: string, mode: Mode): Promise<void> {
  if (mode === 'fixed') {
    return deleteCustomerFixed(runId, customerId);
  }
  return deleteCustomerVulnerable(runId, customerId);
}



