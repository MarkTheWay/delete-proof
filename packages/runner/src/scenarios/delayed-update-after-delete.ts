/**
 * delayed-update-after-delete
 *
 * Vulnerable: hold worker.before_write → delete → release → upsert resurrects.
 * Fixed: delete reaches api.before_commit (holds advisory lock); worker Lock-waits;
 *        release → commit tombstone → worker sees tombstone → blocked_by_tombstone.
 */
import type { Mode, RunResult } from '@delete-proof/shared';
import type { SampleAppAdapter } from '../adapters/SampleAppAdapter.js';
import { EvidenceRecorder } from '../evidence/EvidenceRecorder.js';
import { resurrectionVerdict, withRun } from './helpers.js';

export async function runDelayedUpdateAfterDelete(
  adapter: SampleAppAdapter,
  mode: Mode,
): Promise<RunResult> {
  const rec = new EvidenceRecorder('delayed-update-after-delete', mode);

  return withRun(adapter, rec, async () => {
    const runId = rec.runId;
    const customer = await adapter.createCustomer(runId, {
      email: `delayed-${runId}@synthetic.example`,
      name: 'Delayed User',
    });

    await adapter.enqueueSync(runId, customer.id, {
      mode,
      profilePatch: { staleField: 'stale-value' },
      email: customer.email,
      name: customer.name,
      jobId: `${runId}-sync`,
    });

    if (mode === 'vulnerable') {
      await adapter.waitForBarrierAck(runId, 'worker.before_write');
      await adapter.deleteCustomer(runId, customer.id, mode);
      const gone = (await adapter.readCustomer(customer.id)) === null;
      if (!gone) throw new Error('Deletion did not commit before worker release');
      await adapter.releaseBarrier(runId, 'worker.before_write');
      await adapter.waitForTraceKind(runId, ['worker_write_committed']);
    } else {
      const deleteP = adapter.startDeleteCustomer(runId, customer.id, mode);

      const raced = await adapter.waitForFirstBarrierAck(runId, [
        'api.before_commit',
        'worker.before_write',
      ]);

      if (raced === 'worker.before_write') {
        const lockState = await adapter.waitForLockWait(runId, 5_000);
        if (lockState.waiting) {
          rec.addTrace({
            ts: new Date().toISOString(),
            kind: 'lock_wait_observed',
            message: 'Delete backend waiting on Lock while worker held barrier',
            data: { backends: lockState.backends },
          });
        }
        await adapter.releaseBarrier(runId, 'worker.before_write');
        await adapter.waitForBarrierAck(runId, 'api.before_commit');
        await adapter.releaseBarrier(runId, 'api.before_commit');
      } else {
        // Prefer a quick lock-wait sample; do not block the critical path for long.
        const lockState = await adapter.waitForLockWait(runId, 2_000);
        if (lockState.waiting) {
          rec.addTrace({
            ts: new Date().toISOString(),
            kind: 'lock_wait_observed',
            message: 'Worker backend waiting on Lock while delete held before_commit',
            data: { backends: lockState.backends },
          });
        }
        await adapter.releaseBarrier(runId, 'api.before_commit');
      }

      await deleteP;

      // If worker checked tombstone before delete committed (should not with locks),
      // drain a before_write ack so it cannot hang the run.
      try {
        await adapter.waitForBarrierAck(runId, 'worker.before_write', 1_500);
        await adapter.releaseBarrier(runId, 'worker.before_write');
      } catch {
        /* expected when tombstone blocked the write */
      }

      await adapter.waitForTraceKind(
        runId,
        ['worker_blocked_by_tombstone', 'worker_write_committed'],
        15_000,
      );
    }

    const final = await adapter.readCustomer(customer.id);
    const { safetyOutcome, verdict } = resurrectionVerdict(mode, final !== null);
    return { safetyOutcome, verdict, customerId: customer.id };
  });
}
