/**
 * Redis stream trace — active only when DELETEPROOF_TEST_HOOKS=1.
 * XADD to dp:{runId}:trace
 */
import { Redis } from 'ioredis';
import type { TraceEvent, TraceEventKind } from '@delete-proof/shared';
import { redisUrl, testHooksEnabled } from './config.js';

let _redis: Redis | null = null;

function redis(): Redis {
  if (!_redis) {
    _redis = new Redis(redisUrl(), { maxRetriesPerRequest: null, lazyConnect: false });
  }
  return _redis;
}

export function traceKey(runId: string): string {
  return `dp:${runId}:trace`;
}

export async function emitTrace(
  runId: string,
  kind: TraceEventKind,
  message: string,
  data?: Record<string, unknown>,
  actor?: string,
): Promise<void> {
  if (!testHooksEnabled()) return;
  const ts = new Date().toISOString();
  const fields: string[] = ['ts', ts, 'kind', kind, 'message', message];
  if (actor) fields.push('actor', actor);
  if (data) fields.push('data', JSON.stringify(data));
  await redis().xadd(traceKey(runId), '*', ...fields);
}

export async function readTrace(runId: string): Promise<TraceEvent[]> {
  if (!testHooksEnabled()) return [];
  const rows = await redis().xrange(traceKey(runId), '-', '+');
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

export async function closeTraceRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit().catch(() => undefined);
    _redis = null;
  }
}
