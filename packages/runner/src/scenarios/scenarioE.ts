/**
 * Scenario E: Unrelated customer update.
 *
 * Customer A is deleted. Customer B's update must not be affected.
 * Verifies that tombstone checks are customer-scoped.
 */
import type { Mode, RunResult, TargetAdapter } from '@delete-proof/shared';
import { EvidenceRecorder } from '../evidence/EvidenceRecorder';

export async function runUnrelatedCustomerUpdate(
  adapter: TargetAdapter,
  mode: Mode,
): Promise<RunResult> {
  const rec = new EvidenceRecorder('unrelated_customer_update', mode);
  const runId = rec.runId;
  const unsub = adapter.onTrace(runId, (e) => rec.addTrace(e));

  try {
    await adapter.setup(runId);

    // Customer A — to be deleted
    const customerA = await adapter.createCustomer(runId, {
      email: `a-${runId}@synthetic.example`,
      name: 'Customer A',
    });

    // Customer B — must remain unaffected
    const customerB = await adapter.createCustomer(runId, {
      email: `b-${runId}@synthetic.example`,
      name: 'Customer B',
    });

    // Raise barrier for Customer B's update
    await adapter.raiseBarrier(runId, 'worker_hold');

    // Queue update for Customer B
    const jobBId = `${runId}-b`;
    await adapter.queueUpdateEvent(runId, customerB, {
      mode,
      profilePatch: { feature: 'unrelated-update' },
      email: `b-${runId}@synthetic.example`,
      name: 'Customer B',
      jobId: jobBId,
    });

    // Delete Customer A only
    await adapter.deleteCustomer(runId, customerA, mode);
    const aDeleted = await adapter.assertDeleted(runId, customerA);
    if (!aDeleted) {
      rec.addError('Customer A deletion did not commit');
      const result = rec.build('failed', 'not_applicable', 'Execution error: deletion of A failed.', null);
      await adapter.teardown(runId);
      return result;
    }

    // Release barrier — Customer B's worker runs
    await adapter.releaseBarrier(runId, 'worker_hold');
    await adapter.waitForWorker(runId, jobBId, 15_000);

    const customerBState = await adapter.queryCustomer(runId, customerB);

    let invariantStatus: RunResult['invariantStatus'];
    let verdict: string;

    if (customerBState !== null) {
      invariantStatus = 'held';
      verdict = 'Unrelated customer update succeeded — Customer A deletion did not affect Customer B.';
    } else {
      invariantStatus = 'violated';
      verdict = 'UNEXPECTED: Customer B was absent after Customer A deletion.';
      rec.addError(verdict);
    }

    unsub();
    const result = rec.build('completed', invariantStatus, verdict, customerBState);
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



