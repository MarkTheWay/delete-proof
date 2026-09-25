/**
 * Redis barriers — active only when DELETEPROOF_TEST_HOOKS=1.
 *
 * Participant side:
 *   LPUSH dp:{runId}:ack:{point}
 *   BLPOP dp:{runId}:release:{point}
 * On timeout: caller should ROLLBACK and emit barrier_timeout.
 *
 * IMPORTANT: each atBarrier() uses a dedicated Redis connection. A shared
 * client would serialize concurrent workers because BLPOP occupies the
 * connection until it returns.
 */
import Redis from 'ioredis';
import { barrierTimeoutMs, redisUrl, testHooksEnabled } from './config.js';
import { emitTrace } from './trace.js';

export function ackKey(runId: string, point: string): string {
  return `dp:${runId}:ack:${point}`;
}

export function releaseKey(runId: string, point: string): string {
  return `dp:${runId}:release:${point}`;
}

export class BarrierTimeoutError extends Error {
  readonly point: string;
  constructor(point: string, timeoutMs: number) {
    super(`Barrier timeout at ${point} after ${timeoutMs}ms`);
    this.name = 'BarrierTimeoutError';
    this.point = point;
  }
}

function freshRedis(): Redis {
  return new Redis(redisUrl(), {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  });
}

/**
 * Signal arrival at a barrier point, then block until the runner releases it.
 * No-op when DELETEPROOF_TEST_HOOKS is not set.
 *
 * `worker.job_received` is opt-in: the runner must SET `dp:{runId}:arm:worker.job_received`
 * before enqueue, otherwise the barrier is skipped (so other scenarios are not blocked).
 */
export async function atBarrier(
  runId: string,
  point: string,
  actor: string,
): Promise<void> {
  if (!testHooksEnabled()) return;

  const r = freshRedis();
  try {
    if (point === 'worker.job_received') {
      const armed = await r.exists(`dp:${runId}:arm:worker.job_received`);
      if (!armed) return;
    }

    const timeoutMs = barrierTimeoutMs();
    const ack = ackKey(runId, point);
    const rel = releaseKey(runId, point);

    await emitTrace(runId, 'barrier_ack', `Barrier ack: ${point}`, { point }, actor);
    await r.lpush(ack, JSON.stringify({ runId, point, actor, ts: new Date().toISOString() }));

    // BLPOP timeout is in seconds (integer). Use ceil so we never undershoot.
    const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
    const result = await r.blpop(rel, timeoutSec);
    if (!result) {
      await emitTrace(
        runId,
        'barrier_timeout',
        `Barrier timeout: ${point}`,
        { point, timeoutMs },
        actor,
      );
      throw new BarrierTimeoutError(point, timeoutMs);
    }
    await emitTrace(runId, 'barrier_released', `Barrier released: ${point}`, { point }, actor);
  } finally {
    r.disconnect();
  }
}

export async function closeBarrierRedis(): Promise<void> {
  // No shared client to close — each atBarrier owns its connection.
}
