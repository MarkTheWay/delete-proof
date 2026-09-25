/**
 * Scenario A: Delayed update after deletion.
 *
 * Steps:
 *  1. Create customer C.
 *  2. Queue profile-update event for C.
 *  3. Raise barrier "worker_hold" — worker pauses before writing.
 *  4. Delete C (confirm committed).
 *  5. Release barrier — worker resumes.
 *  6. Wait for worker to complete.
 *  7. Assert: customer absent (fixed) / present (vulnerable — invariant violated).
 *
 * VULNERABLE expected: customer resurrected → "Resurrection reproduced — deletion invariant failed."
 * FIXED expected:      customer absent      → "Deletion invariant held."
 */
import type { Mode, RunResult, TargetAdapter } from '@delete-proof/shared';
import { EvidenceRecorder } from '../evidence/EvidenceRecorder';

export async function runDelayedUpdateAfterDeletion(
  adapter: TargetAdapter,
  mode: Mode,
): Promise<RunResult> {
  const rec = new EvidenceRecorder('delayed_update_after_deletion', mode);
  const runId = rec.runId;

  // Subscribe to trace
  const unsub = adapter.onTrace(runId, (e) => rec.addTrace(e));

  try {
    await adapter.setup(runId);

    // 1. Create customer
    const customerId = await adapter.createCustomer(runId, {
      email: `test-${runId}@synthetic.example`,
      name: 'Synthetic User',
    });

    // 2. Raise barrier before queuing so worker blocks immediately
    await adapter.raiseBarrier(runId, 'worker_hold');

    // 3. Queue stale update event
    const jobId = runId; // reuse runId so waitForWorker can find it
    await adapter.queueUpdateEvent(runId, customerId, {
      mode,
      profilePatch: { staleField: 'stale-value' },
      email: `test-${runId}@synthetic.example`,
      name: 'Synthetic User',
      jobId: runId,
    });

    // 4. Delete customer
    await adapter.deleteCustomer(runId, customerId, mode);
    const isDeleted = await adapter.assertDeleted(runId, customerId);
    if (!isDeleted) {
      rec.addError('Deletion did not commit — aborting scenario');
      const result = rec.build('failed', 'not_applicable', 'Execution error: deletion did not commit.', null);
      await adapter.teardown(runId);
      return result;
    }

    // 5. Release barrier — worker resumes
    await adapter.releaseBarrier(runId, 'worker_hold');

    // 6. Wait for worker
    await adapter.waitForWorker(runId, jobId);

    // 7. Assert final state
    const customer = await adapter.queryCustomer(runId, customerId);

    let invariantStatus: RunResult['invariantStatus'];
    let verdict: string;

    if (mode === 'vulnerable') {
      if (customer !== null) {
        invariantStatus = 'violated';
        verdict = 'Resurrection reproduced — deletion invariant failed.';
      } else {
        invariantStatus = 'held';
        verdict = 'Vulnerable mode — customer absent (resurrection did not occur in this run).';
      }
    } else {
      if (customer === null) {
        invariantStatus = 'held';
        verdict = 'Deletion invariant held — customer stayed absent after stale event.';
      } else {
        invariantStatus = 'violated';
        verdict = 'UNEXPECTED: Fixed mode resurrected customer — invariant violated.';
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



