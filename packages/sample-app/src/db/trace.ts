/**
 * Trace helpers – write ordered trace events to the shared table.
 * Also used by the runner adapter to subscribe to run events.
 */
import type pg from 'pg';
import type { TraceEvent, TraceEventKind } from '@delete-proof/shared';

const counters = new Map<string, number>();

export async function emitTrace(
  client: pg.PoolClient | pg.Pool,
  runId: string,
  kind: TraceEventKind,
  message: string,
  data?: Record<string, unknown>,
): Promise<TraceEvent> {
  const seq = (counters.get(runId) ?? 0) + 1;
  counters.set(runId, seq);

  const result = await (client as pg.Pool).query<{ ts: Date }>(
    `INSERT INTO trace_events (run_id, seq, kind, message, data)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ts`,
    [runId, seq, kind, message, data ? JSON.stringify(data) : null],
  );

  return {
    seq,
    ts: result.rows[0].ts.toISOString(),
    kind,
    message,
    data,
  };
}

export async function getTrace(pool: pg.Pool, runId: string): Promise<TraceEvent[]> {
  const result = await pool.query<{
    seq: number; ts: Date; kind: TraceEventKind; message: string; data: unknown;
  }>(
    `SELECT seq, ts, kind, message, data
     FROM trace_events
     WHERE run_id = $1
     ORDER BY seq ASC`,
    [runId],
  );
  return result.rows.map((r) => ({
    seq: r.seq,
    ts: r.ts.toISOString(),
    kind: r.kind,
    message: r.message,
    data: r.data as Record<string, unknown> | undefined,
  }));
}

export function clearRunCounter(runId: string): void {
  counters.delete(runId);
}
