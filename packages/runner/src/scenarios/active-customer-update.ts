/**
 * active-customer-update — no deletion; sync must succeed.
 */
import type { Mode, RunResult } from '@delete-proof/shared';
import type { SampleAppAdapter } from '../adapters/SampleAppAdapter.js';
import { EvidenceRecorder } from '../evidence/EvidenceRecorder.js';
import { withRun } from './helpers.js';

export async function runActiveCustomerUpdate(
  adapter: SampleAppAdapter,
  mode: Mode,
): Promise<RunResult> {
  const rec = new EvidenceRecorder('active-customer-update', mode);

  return withRun(adapter, rec, async () => {
    const runId = rec.runId;
    const customer = await adapter.createCustomer(runId, {
      email: `active-${runId}@synthetic.example`,
      name: 'Active User',
    });

    await adapter.enqueueSync(runId, customer.id, {
      mode,
      profilePatch: { plan: 'pro', updatedBy: 'active-customer-update' },
      jobId: `${runId}-sync`,
      email: customer.email,
      name: customer.name,
    });

    // Both modes hit worker.before_write when no tombstone (fixed) / always (vulnerable)
    await adapter.waitForBarrierAck(runId, 'worker.before_write');
    await adapter.releaseBarrier(runId, 'worker.before_write');
    await adapter.waitForTraceKind(runId, ['worker_write_committed']);

    const final = await adapter.readCustomer(customer.id);
    if (final !== null && (final.profile as Record<string, unknown>)?.plan === 'pro') {
      return {
        safetyOutcome: 'invariant_held',
        verdict: 'Normal update succeeded — active customer profile updated correctly.',
        customerId: customer.id,
      };
    }
    if (final !== null) {
      return {
        safetyOutcome: 'invariant_held',
        verdict: 'Customer present after update (profile merge may differ by mode).',
        customerId: customer.id,
      };
    }
    return {
      safetyOutcome: 'invariant_violated',
      verdict: 'UNEXPECTED: Active customer was not present after normal update.',
      customerId: customer.id,
    };
  });
}
