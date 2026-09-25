/**
 * BullMQ worker — processes profile-sync jobs in vulnerable or fixed mode.
 */
import { Worker } from 'bullmq';
import { loadEnv, QUEUE_NAME, testHooksEnabled } from '../config.js';
import { getPool } from '../db/pool.js';
import { processSyncVulnerable } from '../modes/vulnerable.js';
import { processSyncFixed } from '../modes/fixed.js';
import { connectionOpts, type SyncJobPayload } from '../queue.js';
import { emitTrace } from '../trace.js';
import { BarrierTimeoutError } from '../barriers.js';

loadEnv();

const worker = new Worker<SyncJobPayload>(
  QUEUE_NAME,
  async (job) => {
    const { runId, customerId, mode, profilePatch, jobId, email, name } = job.data;
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
        // Vulnerable path: no advisory lock / no transaction wrapping the write
        // (plain connection statements — demo fixture ghost-write).
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
  await worker.close();
  process.exit(0);
}

process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
