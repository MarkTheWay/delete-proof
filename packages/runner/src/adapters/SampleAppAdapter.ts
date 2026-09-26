/**
 * SampleAppAdapter — talks HTTP + Redis barriers/traces + read-only Postgres.
 * NEVER imports sample-app internals.
 */
import pg from 'pg';
import type {
  Customer,
  LockWaitState,
  Mode,
  TargetAdapter,
  Tombstone,
  TraceEvent,
  TraceEventKind,
} from '@delete-proof/shared';
import {
  armJobReceivedBarrier as redisArmJobReceived,
  cleanupRedisRun,
  closeRedis,
  getRedis,
  releaseBarrier as redisReleaseBarrier,
  traceKey,
  waitForBarrierAck as redisWaitForBarrierAck,
  waitForFirstBarrierAck as redisWaitForFirstBarrierAck,
} from '../barriers.js';
import { barrierTimeoutMs, databaseUrl, sampleAppBaseUrl } from '../env.js';

const { Pool } = pg;

export class SampleAppAdapter implements TargetAdapter {
  private readonly baseUrl: string;
  private readonly pool: pg.Pool;

  constructor(baseUrl = sampleAppBaseUrl()) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.pool = new Pool({ connectionString: databaseUrl(), max: 5 });
  }

  private async http<T>(
    path: string,
    init?: RequestInit & { expectJson?: boolean },
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`sample-app ${init?.method ?? 'GET'} ${path} → ${res.status}: ${body}`);
    }
    if (res.status === 204 || init?.expectJson === false) {
      return undefined as T;
    }
    return (await res.json()) as T;
  }

  async createCustomer(
    runId: string,
    opts: { email: string; name: string },
  ): Promise<Customer> {
    return this.http<Customer>('/customers', {
      method: 'POST',
      body: JSON.stringify({ runId, email: opts.email, name: opts.name }),
    });
  }

  async enqueueSync(
    runId: string,
    customerId: string,
    opts: {
      mode: Mode;
      profilePatch?: Record<string, unknown>;
      email?: string;
      name?: string;
      jobId?: string;
    },
  ): Promise<{ jobId: string }> {
    return this.http<{ jobId: string }>(`/customers/${customerId}/enqueue`, {
      method: 'POST',
      body: JSON.stringify({
        runId,
        mode: opts.mode,
        profilePatch: opts.profilePatch ?? {},
        email: opts.email,
        name: opts.name,
        jobId: opts.jobId,
      }),
    });
  }

  /**
   * Delete customer via HTTP.
   * Fixed mode blocks at api.before_commit — this method waits for the ack
   * and releases it unless `holdBeforeCommit` is true.
   */
  async deleteCustomer(
    runId: string,
    customerId: string,
    mode: Mode,
    opts?: { holdBeforeCommit?: boolean },
  ): Promise<void> {
    if (mode === 'fixed' && !opts?.holdBeforeCommit) {
      const pending = this.http<void>(`/customers/${customerId}`, {
        method: 'DELETE',
        body: JSON.stringify({ runId, mode }),
        expectJson: false,
      });
      await redisWaitForBarrierAck(runId, 'api.before_commit');
      await redisReleaseBarrier(runId, 'api.before_commit');
      await pending;
      return;
    }

    if (mode === 'fixed' && opts?.holdBeforeCommit) {
      throw new Error('Use startDeleteCustomer() when holdBeforeCommit is required');
    }

    await this.http<void>(`/customers/${customerId}`, {
      method: 'DELETE',
      body: JSON.stringify({ runId, mode }),
      expectJson: false,
    });
  }

  /**
   * Start a fixed-mode delete without releasing api.before_commit.
   * Caller must waitForBarrierAck + releaseBarrier, then await the promise.
   */
  startDeleteCustomer(
    runId: string,
    customerId: string,
    mode: Mode,
  ): Promise<void> {
    return this.http<void>(`/customers/${customerId}`, {
      method: 'DELETE',
      body: JSON.stringify({ runId, mode }),
      expectJson: false,
    });
  }

  async readCustomer(customerId: string): Promise<Customer | null> {
    const result = await this.pool.query(
      `SELECT id, email, name, profile, run_id, created_at, updated_at
       FROM customers WHERE id = $1`,
      [customerId],
    );
    if (result.rows.length === 0) return null;
    const r = result.rows[0];
    return {
      id: r.id,
      email: r.email,
      name: r.name,
      profile: r.profile,
      runId: r.run_id ?? undefined,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    };
  }

  async readTombstone(customerId: string): Promise<Tombstone | null> {
    const result = await this.pool.query(
      `SELECT customer_id, deleted_at, run_id FROM customer_tombstones WHERE customer_id = $1`,
      [customerId],
    );
    if (result.rows.length === 0) return null;
    const r = result.rows[0];
    return {
      customerId: r.customer_id,
      deletedAt: r.deleted_at.toISOString(),
      runId: r.run_id,
    };
  }

  async lockWaitState(runId: string): Promise<LockWaitState> {
    const result = await this.pool.query<{
      pid: number;
      application_name: string | null;
      wait_event_type: string | null;
      wait_event: string | null;
      state: string | null;
      query: string | null;
    }>(
      `SELECT pid, application_name, wait_event_type, wait_event, state, query
       FROM pg_stat_activity
       WHERE application_name LIKE $1
         AND wait_event_type = 'Lock'`,
      [`dp:${runId}:%`],
    );
    const backends = result.rows.map((r) => ({
      pid: r.pid,
      applicationName: r.application_name,
      waitEventType: r.wait_event_type,
      waitEvent: r.wait_event,
      state: r.state,
      query: r.query,
    }));
    return { waiting: backends.length > 0, backends };
  }

  async health(): Promise<{
    ok: boolean;
    api: string;
    postgres: string;
    redis: string;
    worker: string;
    testHooks: string;
  }> {
    let api = 'error';
    let postgres = 'error';
    let redis = 'error';
    let worker = 'error';
    let testHooks = 'error';

    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (res.ok) {
        const body = (await res.json()) as { ok?: boolean; service?: string; testHooks?: boolean };
        if (body.service === 'sample-app' && body.ok === true) {
          api = 'ok';
          testHooks = body.testHooks === true ? 'ok' : 'disabled';
        } else {
          api = 'error';
          testHooks = 'error';
        }
      }
    } catch {
      api = 'error';
    }
    try {
      await this.pool.query('SELECT 1');
      postgres = 'ok';
    } catch {
      postgres = 'error';
    }
    try {
      const r = getRedis();
      const pong = await r.ping();
      redis = pong === 'PONG' ? 'ok' : 'error';
      if (redis === 'ok') {
        const hb = await r.get('dp:worker:heartbeat');
        worker = hb ? 'ok' : 'error';
      }
    } catch {
      redis = 'error';
      worker = 'error';
    }

    const ok =
      api === 'ok' &&
      postgres === 'ok' &&
      redis === 'ok' &&
      worker === 'ok' &&
      testHooks === 'ok';
    return { ok, api, postgres, redis, worker, testHooks };
  }

  async cleanup(runId: string): Promise<void> {
    // Unblock barriers + drop Redis keys
    await cleanupRedisRun(runId);

    // Cancel backends tagged with this run
    try {
      await this.pool.query(
        `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
         WHERE application_name LIKE $1
           AND pid <> pg_backend_pid()`,
        [`dp:${runId}:%`],
      );
    } catch {
      /* ignore */
    }

    await this.pool.query(`DELETE FROM customers WHERE run_id = $1`, [runId]);
    await this.pool.query(`DELETE FROM customer_tombstones WHERE run_id = $1`, [runId]);
  }

  async waitForBarrierAck(runId: string, point: string, timeoutMs?: number): Promise<void> {
    await redisWaitForBarrierAck(runId, point, timeoutMs);
  }

  async waitForFirstBarrierAck(
    runId: string,
    points: string[],
    timeoutMs?: number,
  ): Promise<string> {
    return redisWaitForFirstBarrierAck(runId, points, timeoutMs);
  }

  async releaseBarrier(runId: string, point: string): Promise<void> {
    await redisReleaseBarrier(runId, point);
  }

  /** Opt-in: workers will pause at worker.job_received for this run. */
  async armJobReceivedBarrier(runId: string): Promise<void> {
    await redisArmJobReceived(runId);
  }

  async readTrace(runId: string): Promise<TraceEvent[]> {
    const rows = await getRedis().xrange(traceKey(runId), '-', '+');
    return rows.map(([id, flat]) => {
      const map: Record<string, string> = {};
      for (let i = 0; i < flat.length; i += 2) map[flat[i]] = flat[i + 1];
      let data: Record<string, unknown> | undefined;
      if (map.data) {
        try {
          data = JSON.parse(map.data) as Record<string, unknown>;
        } catch {
          /* ignore */
        }
      }
      return {
        id,
        ts: map.ts ?? new Date().toISOString(),
        kind: (map.kind ?? 'error') as TraceEventKind,
        actor: map.actor,
        message: map.message ?? '',
        data,
      };
    });
  }

  /**
   * Poll Redis trace until a matching kind appears (or timeout).
   */
  async waitForTraceKind(
    runId: string,
    kinds: TraceEventKind[],
    timeoutMs = barrierTimeoutMs(),
  ): Promise<TraceEvent> {
    const deadline = Date.now() + timeoutMs;
    const wanted = new Set(kinds);
    while (Date.now() < deadline) {
      const events = await this.readTrace(runId);
      const hit = [...events].reverse().find((e) => wanted.has(e.kind));
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Timed out waiting for trace kinds: ${kinds.join(', ')}`);
  }

  /**
   * Poll lock waits until observed or timeout. Runner never holds locks itself.
   */
  async waitForLockWait(runId: string, timeoutMs = 10_000): Promise<LockWaitState> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await this.lockWaitState(runId);
      if (state.waiting) return state;
      await new Promise((r) => setTimeout(r, 25));
    }
    return this.lockWaitState(runId);
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => undefined);
    await closeRedis();
  }
}
