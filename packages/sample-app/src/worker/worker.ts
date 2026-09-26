/**
 * BullMQ worker — processes profile-sync jobs in vulnerable or fixed mode.
 */
import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { loadEnv, QUEUE_NAME, redisUrl, testHooksEnabled } from '../config.js';
import { getPool } from '../db/pool.js';
import { processSyncVulnerable } from '../modes/vulnerable.js';
import { processSyncFixed } from '../modes/fixed.js';
import { connectionOpts, type SyncJobPayload } from '../queue.js';
import { emitTrace } from '../trace.js';
import { BarrierTimeoutError } from '../barriers.js';

loadEnv();

const heartbeatRedis = new Redis(redisUrl(), { maxRetriesPerRequest: null });

async function beat(): Promise<void> {
  try {
    await heartbeatRedis.set('dp:worker:heartbeat', String(Date.now()), 'EX', 20);
  } catch {
    /* ignore */
  }
}
void beat();
const heartbeatTimer = setInterval(() => {
  void beat();
}, 5_000);

const worker = new Worker<SyncJobPayload>(
  QUEUE_NAME,
  async (job) => {
    const { runId, customerId, mode, profilePatch, jobId, email, name } = job.data;
    if (mode !== 'vulnerable' && mode !== 'fixed') {
      throw new Error(`Invalid mode in job: ${String(mode)}`);
    }
    const pool = getPool();
    const client = await pool.connect();
    try {
      if (mode === 'fixed') {
        await processSyncFixed(client, runId, customerId, {
          email,
          name,
          profilePatch: profilePatch ?? {},
          jobId: jobId ?? String(job.id),
        });
      } else {
        await processSyncVulnerable(client, runId, customerId, {
          email,
          name,
          profilePatch: profilePatch ?? {},
          jobId: jobId ?? String(job.id),
        });
      }
    } catch (err) {
      if (err instanceof BarrierTimeoutError) {
        await emitTrace(
          runId,
          'error',
          `Worker barrier timeout at ${err.point}`,
          { point: err.point, jobId },
          'worker',
        );
      }
      throw err;
    } finally {
      client.release();
    }
  },
  { connection: connectionOpts(), concurrency: 8 },
);

worker.on('completed', (job) => {
  console.log(`[worker] Job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`[worker] Job ${job?.id} failed:`, err.message);
});

console.log(`[worker] DeleteProof worker started (hooks=${testHooksEnabled()})`);

async function shutdown(): Promise<void> {
  clearInterval(heartbeatTimer);
  await worker.close();
  heartbeatRedis.disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => {
  void shutdown();
});
process.on('SIGINT', () => {
  void shutdown();
});
