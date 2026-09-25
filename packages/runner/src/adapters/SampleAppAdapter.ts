/**
 * SampleAppAdapter — implements TargetAdapter against the local sample-app
 * PostgreSQL and Redis services directly (no HTTP hop needed for CLI / Vitest).
 */
import { Queue } from 'bullmq';
import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import type { Customer, Mode, TargetAdapter, TraceEvent, TraceEventKind } from '@delete-proof/shared';

const { Pool } = pg;

function getPool(): pg.Pool {
  return new Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgresql://deleteproof:deleteproof@localhost:5432/deleteproof',
    max: 5,
  });
}

function getRedis() {
  const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  return { host: url.hostname, port: Number(url.port || 6379) };
}

/** Same hash as worker and API */
function lockKey(customerId: string): bigint {
  let h = 5381n;
  for (const ch of customerId) {
    h = ((h << 5n) + h + BigInt(ch.charCodeAt(0))) & 0x7fffffffffffffffn;
  }
  return h;
}

const seqCounters = new Map<string, number>();

function nextSeq(runId: string): number {
  const n = (seqCounters.get(runId) ?? 0) + 1;
  seqCounters.set(runId, n);
  return n;
}

async function emitTrace(
  pool: pg.Pool,
  runId: string,
  kind: TraceEventKind,
  message: string,
  data?: Record<string, unknown>,
): Promise<void> {
  const seq = nextSeq(runId);
  await pool.query(
    `INSERT INTO trace_events (run_id, seq, kind, message, data)
     VALUES ($1, $2, $3, $4, $5)`,
    [runId, seq, kind, message, data ? JSON.stringify(data) : null],
  );
}

export class SampleAppAdapter implements TargetAdapter {
  private pools = new Map<string, pg.Pool>();

  private pool(runId: string): pg.Pool {
    if (!this.pools.has(runId)) this.pools.set(runId, getPool());
    return this.pools.get(runId)!;
  }

  async setup(runId: string): Promise<void> {
    const pool = this.pool(runId);
    // Ensure schema exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id UUID PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL,
        profile JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS tombstones (
        customer_id UUID PRIMARY KEY, deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(), run_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS barriers (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, released BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS job_completions (
        job_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, customer_id UUID NOT NULL,
        outcome TEXT NOT NULL, completed_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS trace_events (
        id BIGSERIAL PRIMARY KEY, run_id TEXT NOT NULL, seq INTEGER NOT NULL,
        ts TIMESTAMPTZ NOT NULL DEFAULT now(), kind TEXT NOT NULL,
        message TEXT NOT NULL, data JSONB
      );
      CREATE INDEX IF NOT EXISTS trace_events_run_id ON trace_events (run_id, seq);
    `);
    seqCounters.set(runId, 0);
  }

  async teardown(runId: string): Promise<void> {
    const pool = this.pool(runId);
    await pool.query(`DELETE FROM trace_events WHERE run_id = $1`, [runId]);
    await pool.query(`DELETE FROM job_completions WHERE run_id = $1`, [runId]);
    await pool.query(`DELETE FROM barriers WHERE run_id = $1`, [runId]);
    await pool.query(`DELETE FROM tombstones WHERE run_id = $1`, [runId]);
    seqCounters.delete(runId);
    await pool.end();
    this.pools.delete(runId);
  }

  async createCustomer(runId: string, opts: { email: string; name: string }): Promise<string> {
    const pool = this.pool(runId);
    const id = uuidv4();
    await pool.query(
      `INSERT INTO customers (id, email, name, profile, created_at, updated_at)
       VALUES ($1, $2, $3, '{}', now(), now())`,
      [id, opts.email, opts.name],
    );
    await emitTrace(pool, runId, 'customer_created', `Customer ${id} created`, { id, ...opts });
    return id;
  }

  async queueUpdateEvent(
    runId: string,
    customerId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const pool = this.pool(runId);
    const queue = new Queue('profile-updates', { connection: getRedis() });
    const jobId = uuidv4();
    await queue.add('profile-update', {
      runId,
      customerId,
      mode: payload.mode ?? 'vulnerable',
      profilePatch: payload.profilePatch ?? {},
      jobId,
      email: payload.email ?? 'synthetic@example.com',
      name: payload.name ?? 'Synthetic User',
    }, { jobId });
    await queue.close();
    await emitTrace(pool, runId, 'event_queued', `Update event queued for customer ${customerId}`, {
      customerId, jobId, runId,
    });
  }

  async raiseBarrier(runId: string, name: string): Promise<void> {
    const pool = this.pool(runId);
    await pool.query(
      `INSERT INTO barriers (id, run_id, released) VALUES ($1, $2, false)
       ON CONFLICT (id) DO UPDATE SET released = false`,
      [`${runId}:${name}`, runId],
    );
    await emitTrace(pool, runId, 'barrier_raised', `Barrier raised: ${name}`, { name });
  }

  async deleteCustomer(runId: string, customerId: string, mode: Mode): Promise<void> {
    const pool = this.pool(runId);
    if (mode === 'fixed') {
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
          customerId, mode,
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } else {
      await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
      await emitTrace(pool, runId, 'deletion_committed', `[VULNERABLE] Customer ${customerId} deleted (no tombstone)`, {
        customerId, mode,
      });
    }
  }

  async assertDeleted(runId: string, customerId: string): Promise<boolean> {
    const pool = this.pool(runId);
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM customers WHERE id = $1`,
      [customerId],
    );
    return parseInt(result.rows[0].count, 10) === 0;
  }

  async releaseBarrier(runId: string, name: string): Promise<void> {
    const pool = this.pool(runId);
    await pool.query(
      `UPDATE barriers SET released = true WHERE id = $1`,
      [`${runId}:${name}`],
    );
    await emitTrace(pool, runId, 'barrier_released', `Barrier released: ${name}`, { name });
  }

  async waitForWorker(runId: string, jobId: string, timeoutMs = 15_000): Promise<void> {
    const pool = this.pool(runId);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await pool.query<{ outcome: string }>(
        `SELECT outcome FROM job_completions WHERE job_id = $1 AND run_id = $2`,
        [jobId, runId],
      );
      if (result.rows.length > 0) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Worker did not complete job ${jobId} within ${timeoutMs}ms`);
  }

  async queryCustomer(_runId: string, customerId: string): Promise<Customer | null> {
    // Use a fresh pool for assertions (not run-specific to avoid closed pools)
    const pool = getPool();
    const result = await pool.query<{
      id: string; email: string; name: string; profile: Record<string, unknown>;
      created_at: Date; updated_at: Date;
    }>(
      `SELECT id, email, name, profile, created_at, updated_at FROM customers WHERE id = $1`,
      [customerId],
    );
    await pool.end();
    if (result.rows.length === 0) return null;
    const r = result.rows[0];
    return {
      id: r.id, email: r.email, name: r.name, profile: r.profile,
      createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
    };
  }

  onTrace(runId: string, cb: (event: TraceEvent) => void): () => void {
    const pool = this.pool(runId);
    let lastSeq = 0;
    let active = true;

    const poll = async () => {
      while (active) {
        const result = await pool.query<{
          seq: number; ts: Date; kind: TraceEventKind; message: string; data: unknown;
        }>(
          `SELECT seq, ts, kind, message, data FROM trace_events
           WHERE run_id = $1 AND seq > $2 ORDER BY seq ASC`,
          [runId, lastSeq],
        );
        for (const r of result.rows) {
          lastSeq = r.seq;
          cb({
            seq: r.seq,
            ts: r.ts.toISOString(),
            kind: r.kind,
            message: r.message,
            data: r.data as Record<string, unknown> | undefined,
          });
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    };

    poll().catch(() => undefined);
    return () => { active = false; };
  }
}
