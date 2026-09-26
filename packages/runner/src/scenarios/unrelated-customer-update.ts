/**
 * unrelated-customer-update — delete A; B's sync must still succeed with patch.
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
    const bProfile = (b?.profile ?? {}) as Record<string, unknown>;

    rec.addTrace({
      ts: new Date().toISOString(),
      kind: 'db_assertion',
      message: 'Assert A absent, B present with feature=unrelated-update',
      data: {
        expected: {
          aPresent: false,
          bPresent: true,
          bFeature: 'unrelated-update',
        },
        actual: {
          aPresent: a !== null,
          bPresent: b !== null,
          bFeature: bProfile.feature ?? null,
        },
      },
    });

    if (a !== null) {
      return {
        safetyOutcome: 'invariant_violated',
        verdict: 'UNEXPECTED: Customer A still present after delete.',
        customerId: customerB.id,
        finalCustomerState: b,
        customerStateKind: b ? 'present' : 'absent',
      };
    }

    if (b === null) {
      return {
        safetyOutcome: 'invariant_violated',
        verdict: 'UNEXPECTED: Customer B was absent after Customer A deletion.',
        customerId: customerB.id,
        finalCustomerState: null,
        customerStateKind: 'absent',
      };
    }

    if (bProfile.feature !== 'unrelated-update') {
      return {
        safetyOutcome: 'invariant_violated',
        verdict: `UNEXPECTED: Customer B update did not apply (feature=${String(bProfile.feature)}).`,
        customerId: customerB.id,
        finalCustomerState: b,
        customerStateKind: 'present',
      };
    }

    return {
      safetyOutcome: 'invariant_held',
      verdict:
        'Unrelated customer update succeeded — Customer A deletion did not affect Customer B.',
      customerId: customerB.id,
      finalCustomerState: b,
      customerStateKind: 'present',
    };
  });
}
