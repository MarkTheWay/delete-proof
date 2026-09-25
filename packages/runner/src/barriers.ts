/**
 * Runner-side Redis barrier control.
 * Does NOT hold DB locks — only coordinates via Redis lists.
 */
import Redis from 'ioredis';
import { barrierTimeoutMs, redisUrl } from './env.js';

let _redis: Redis | null = null;

export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(redisUrl(), { maxRetriesPerRequest: null });
  }
  return _redis;
}

export function ackKey(runId: string, point: string): string {
  return `dp:${runId}:ack:${point}`;
}

export function releaseKey(runId: string, point: string): string {
  return `dp:${runId}:release:${point}`;
}

export function traceKey(runId: string): string {
  return `dp:${runId}:trace`;
}

export async function waitForBarrierAck(
  runId: string,
  point: string,
  timeoutMs = barrierTimeoutMs(),
): Promise<void> {
  const r = getRedis();
  const key = ackKey(runId, point);
  const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
  const result = await r.blpop(key, timeoutSec);
  if (!result) {
    throw new Error(`Timed out waiting for barrier ack: ${point} (${timeoutMs}ms)`);
  }
}

/**
 * Poll ack list lengths (non-blocking) until one of the points has an ack,
 * then consume exactly that ack via BLPOP. Avoids racing two BLPOP waiters
 * that would steal each other's tokens.
 */
export async function waitForFirstBarrierAck(
  runId: string,
  points: string[],
  timeoutMs = barrierTimeoutMs(),
): Promise<string> {
  const r = getRedis();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const point of points) {
      const len = await r.llen(ackKey(runId, point));
      if (len > 0) {
        await waitForBarrierAck(runId, point, Math.max(1_000, deadline - Date.now()));
        return point;
      }
    }
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`Timed out waiting for any barrier ack among: ${points.join(', ')}`);
}

export async function releaseBarrier(runId: string, point: string): Promise<void> {
  const r = getRedis();
  await r.lpush(
    releaseKey(runId, point),
    JSON.stringify({ runId, point, ts: new Date().toISOString() }),
  );
}

/** Arm opt-in worker.job_received barrier for this run. */
export async function armJobReceivedBarrier(runId: string): Promise<void> {
  const r = getRedis();
  await r.set(`dp:${runId}:arm:worker.job_received`, '1', 'EX', 120);
}

/** Best-effort: push release tokens and delete run-scoped Redis keys. */
export async function cleanupRedisRun(runId: string): Promise<void> {
  const r = getRedis();
  const pattern = `dp:${runId}:*`;
  let cursor = '0';
  const keys: string[] = [];
  do {
    const [next, batch] = await r.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');

  // Unblock any waiters
  for (const point of ['api.before_commit', 'worker.before_write']) {
    await r.lpush(releaseKey(runId, point), 'cleanup');
  }

  if (keys.length > 0) {
    await r.del(...keys);
  }
}

export async function closeRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit().catch(() => undefined);
    _redis = null;
  }
}
