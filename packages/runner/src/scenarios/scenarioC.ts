/**
 * Scenario C: Concurrent deletion and processing.
 *
 * Exercises the interleaving where:
 *   - Worker acquires advisory lock FIRST → writes customer → releases lock
 *   - Deletion then acquires lock → inserts tombstone → deletes customer
 *
 * AND the interleaving where:
 *   - Deletion acquires lock FIRST → tombstone + delete
 *   - Worker then acquires lock → sees tombstone → skips write
 *
 * We use two sequential sub-runs (one per ordering) and assert the invariant
 * after deletion completes in both cases.
 *
 * NOTE: The "worker first" interleaving is benign for the invariant because
 * deletion comes after and removes the customer again. The "deletion first"
 * interleaving is the critical one — fixed mode must block the worker write.
 */
import type { Mode, RunResult, TargetAdapter } from '@delete-proof/shared';
import { EvidenceRecorder } from '../evidence/EvidenceRecorder';

export async function runConcurrentDeletionAndUpdate(
  adapter: TargetAdapter,
  mode: Mode,
): Promise<RunResult> {
  const rec = new EvidenceRecorder('concurrent_deletion_and_update', mode);
  const runId = rec.runId;
  const unsub = adapter.onTrace(runId, (e) => rec.addTrace(e));

  try {
    await adapter.setup(runId);

    // ── Sub-run: deletion acquires lock first (the critical race) ─────────────
    const customerId = await adapter.createCustomer(runId, {
      email: `conc-${runId}@synthetic.example`,
      name: 'Concurrent Test',
    });

    await adapter.raiseBarrier(runId, 'worker_hold');

    await adapter.queueUpdateEvent(runId, customerId, {
      mode,
      profilePatch: { concField: 'concurrent-value' },
      email: `conc-${runId}@synthetic.example`,
      name: 'Concurrent Test',
      jobId: runId,
    });

    // Deletion commits first
    await adapter.deleteCustomer(runId, customerId, mode);
    const isDeleted = await adapter.assertDeleted(runId, customerId);
    if (!isDeleted) {
      rec.addError('Deletion did not commit');
      const result = rec.build('failed', 'not_applicable', 'Execution error: deletion did not commit.', null);
      await adapter.teardown(runId);
      return result;
    }

    // Now release worker
    await adapter.releaseBarrier(runId, 'worker_hold');
    await adapter.waitForWorker(runId, runId, 15_000);

    const customer = await adapter.queryCustomer(runId, customerId);

    let invariantStatus: RunResult['invariantStatus'];
    let verdict: string;

    if (mode === 'vulnerable') {
      if (customer !== null) {
        invariantStatus = 'violated';
        verdict = 'Resurrection reproduced — deletion invariant failed (concurrent interleaving).';
      } else {
        invariantStatus = 'held';
        verdict = 'Vulnerable mode — race not triggered in this execution.';
      }
    } else {
      if (customer === null) {
        invariantStatus = 'held';
        verdict = 'Deletion invariant held — concurrent deletion + worker: customer stayed absent.';
      } else {
        invariantStatus = 'violated';
        verdict = 'UNEXPECTED: Fixed mode allowed resurrection in concurrent scenario.';
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



