/**
 * unrelated-customer-update — delete A; B's sync must still succeed.
 */
import type { Mode, RunResult } from '@delete-proof/shared';
import type { SampleAppAdapter } from '../adapters/SampleAppAdapter.js';
import { EvidenceRecorder } from '../evidence/EvidenceRecorder.js';
import { withRun } from './helpers.js';

export async function runUnrelatedCustomerUpdate(
  adapter: SampleAppAdapter,
  mode: Mode,
): Promise<RunResult> {
  const rec = new EvidenceRecorder('unrelated-customer-update', mode);

  return withRun(adapter, rec, async () => {
    const runId = rec.runId;
    const customerA = await adapter.createCustomer(runId, {
      email: `a-${runId}@synthetic.example`,
      name: 'Customer A',
    });
    const customerB = await adapter.createCustomer(runId, {
      email: `b-${runId}@synthetic.example`,
      name: 'Customer B',
    });

    await adapter.enqueueSync(runId, customerB.id, {
      mode,
      profilePatch: { feature: 'unrelated-update' },
      jobId: `${runId}-b`,
      email: customerB.email,
      name: customerB.name,
    });

    await adapter.waitForBarrierAck(runId, 'worker.before_write');
    await adapter.deleteCustomer(runId, customerA.id, mode);
    await adapter.releaseBarrier(runId, 'worker.before_write');
    await adapter.waitForTraceKind(runId, ['worker_write_committed']);

    const b = await adapter.readCustomer(customerB.id);
    const a = await adapter.readCustomer(customerA.id);

    if (mode === 'fixed' && a !== null) {
      return {
        safetyOutcome: 'invariant_violated',
        verdict: 'UNEXPECTED: Customer A still present after fixed delete.',
        customerId: customerB.id,
      };
    }

    if (b !== null) {
      return {
        safetyOutcome: 'invariant_held',
        verdict:
          'Unrelated customer update succeeded — Customer A deletion did not affect Customer B.',
        customerId: customerB.id,
      };
    }
    return {
      safetyOutcome: 'invariant_violated',
      verdict: 'UNEXPECTED: Customer B was absent after Customer A deletion.',
      customerId: customerB.id,
    };
  });
}
