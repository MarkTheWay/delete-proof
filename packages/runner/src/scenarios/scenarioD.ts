/**
 * Scenario D: Normal active-customer update.
 *
 * A customer exists and has NOT been deleted. A queued update event
 * should succeed and be visible in the database.
 * Applies to FIXED mode (same behaviour expected in vulnerable mode).
 */
import type { Mode, RunResult, TargetAdapter } from '@delete-proof/shared';
import { EvidenceRecorder } from '../evidence/EvidenceRecorder';

export async function runNormalActiveUpdate(
  adapter: TargetAdapter,
  mode: Mode,
): Promise<RunResult> {
  const rec = new EvidenceRecorder('normal_active_update', mode);
  const runId = rec.runId;
  const unsub = adapter.onTrace(runId, (e) => rec.addTrace(e));

  try {
    await adapter.setup(runId);

    const customerId = await adapter.createCustomer(runId, {
      email: `active-${runId}@synthetic.example`,
      name: 'Active User',
    });

    // Do NOT raise a barrier — let the worker process normally
    await adapter.queueUpdateEvent(runId, customerId, {
      mode,
      profilePatch: { plan: 'pro', updatedBy: 'scenario-d' },
      email: `active-${runId}@synthetic.example`,
      name: 'Active User',
      jobId: runId,
    });

    // Wait for worker with no deletion in between
    await adapter.waitForWorker(runId, runId, 15_000);

    const customer = await adapter.queryCustomer(runId, customerId);

    let invariantStatus: RunResult['invariantStatus'];
    let verdict: string;

    if (customer !== null && customer.profile && (customer.profile as Record<string, unknown>)['plan'] === 'pro') {
      invariantStatus = 'held';
      verdict = 'Normal update succeeded — active customer profile updated correctly.';
    } else if (customer !== null) {
      invariantStatus = 'held';
      verdict = 'Customer present after update (profile merge may differ by mode).';
    } else {
      invariantStatus = 'violated';
      verdict = 'UNEXPECTED: Active customer was not present after normal update.';
      rec.addError(verdict);
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



