/**
 * Scenario B: Duplicate stale delivery.
 *
 * Queue the same pre-deletion event TWICE. In fixed mode both deliveries
 * must leave the customer absent. In vulnerable mode, one or both will
 * resurrect the customer.
 */
import type { Mode, RunResult, TargetAdapter } from '@delete-proof/shared';
import { EvidenceRecorder } from '../evidence/EvidenceRecorder';
import { Queue } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';

export async function runDuplicateStaleDelivery(
  adapter: TargetAdapter,
  mode: Mode,
): Promise<RunResult> {
  const rec = new EvidenceRecorder('duplicate_stale_delivery', mode);
  const runId = rec.runId;
  const unsub = adapter.onTrace(runId, (e) => rec.addTrace(e));

  try {
    await adapter.setup(runId);

    const customerId = await adapter.createCustomer(runId, {
      email: `dup-${runId}@synthetic.example`,
      name: 'Duplicate Test',
    });

    // Raise barrier before both jobs
    await adapter.raiseBarrier(runId, 'worker_hold');

    // Queue first delivery
    const jobId1 = `${runId}-dup1`;
    const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
    const conn = { host: redisUrl.hostname, port: Number(redisUrl.port || 6379) };
    const queue = new Queue('profile-updates', { connection: conn });
    await queue.add('profile-update', {
      runId, customerId, mode,
      profilePatch: { dupField: 'dup-value' },
      jobId: jobId1,
      email: `dup-${runId}@synthetic.example`,
      name: 'Duplicate Test',
    }, { jobId: jobId1 });

    // Queue second delivery (duplicate)
    const jobId2 = `${runId}-dup2`;
    await queue.add('profile-update', {
      runId, customerId, mode,
      profilePatch: { dupField: 'dup-value-2' },
      jobId: jobId2,
      email: `dup-${runId}@synthetic.example`,
      name: 'Duplicate Test',
    }, { jobId: jobId2 });
    await queue.close();

    // Delete customer
    await adapter.deleteCustomer(runId, customerId, mode);
    const isDeleted = await adapter.assertDeleted(runId, customerId);
    if (!isDeleted) {
      rec.addError('Deletion did not commit');
      const result = rec.build('failed', 'not_applicable', 'Execution error: deletion did not commit.', null);
      await adapter.teardown(runId);
      return result;
    }

    // Release barrier — both workers resume
    await adapter.releaseBarrier(runId, 'worker_hold');

    // Wait for both jobs
    await adapter.waitForWorker(runId, jobId1, 20_000);
    await adapter.waitForWorker(runId, jobId2, 20_000);

    const customer = await adapter.queryCustomer(runId, customerId);

    let invariantStatus: RunResult['invariantStatus'];
    let verdict: string;

    if (mode === 'vulnerable') {
      if (customer !== null) {
        invariantStatus = 'violated';
        verdict = 'Resurrection reproduced — deletion invariant failed (duplicate stale delivery).';
      } else {
        invariantStatus = 'held';
        verdict = 'Vulnerable mode — no resurrection in this run (race not triggered).';
      }
    } else {
      if (customer === null) {
        invariantStatus = 'held';
        verdict = 'Deletion invariant held — duplicate stale deliveries both blocked by tombstone.';
      } else {
        invariantStatus = 'violated';
        verdict = 'UNEXPECTED: Fixed mode allowed resurrection on duplicate delivery.';
        rec.addError(verdict);
      }
    }

    unsub();
    const result = rec.build('completed', invariantStatus, verdict, customer);
    await adapter.teardown(runId);
    return result;
  } catch (err) {
    unsub();
    rec.addError(String(err));
    const result = rec.build('failed', 'not_applicable', `Execution error: ${err}`, null);
    try { await adapter.teardown(runId); } catch { /* ignore */ }
    return result;
  }
}



