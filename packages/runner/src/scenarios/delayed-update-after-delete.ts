/**
 * delayed-update-after-delete
 *
 * Vulnerable: hold worker.before_write → delete → release → upsert resurrects.
 * Fixed (delete-first): arm job_received → delete holds lock at before_commit →
 *   release worker → assert Lock wait → commit tombstone → blocked_by_tombstone.
 */
import type { Mode, RunResult } from '@delete-proof/shared';
import type { SampleAppAdapter } from '../adapters/SampleAppAdapter.js';
import { EvidenceRecorder } from '../evidence/EvidenceRecorder.js';
import { resurrectionVerdict, runFixedDeleteFirstOrdering, withRun } from './helpers.js';

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

    if (mode === 'fixed') {
      await adapter.armJobReceivedBarrier(runId);
    }

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
      await runFixedDeleteFirstOrdering(adapter, runId, customer.id, rec);
    }

    const final = await adapter.readCustomer(customer.id);
    const { safetyOutcome, verdict } = resurrectionVerdict(mode, final !== null);
    return {
      safetyOutcome,
      verdict,
      customerId: customer.id,
      finalCustomerState: final,
      customerStateKind: final ? 'present' : 'absent',
    };
  });
}
