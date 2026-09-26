/**
 * active-customer-update — no deletion; sync must succeed with expected profile.
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

    await adapter.waitForBarrierAck(runId, 'worker.before_write');
    await adapter.releaseBarrier(runId, 'worker.before_write');
    await adapter.waitForTraceKind(runId, ['worker_write_committed']);

    const final = await adapter.readCustomer(customer.id);
    const profile = (final?.profile ?? {}) as Record<string, unknown>;
    const expectedPlan = 'pro';
    const expectedBy = 'active-customer-update';

    rec.addTrace({
      ts: new Date().toISOString(),
      kind: 'db_assertion',
      message: `Assert profile.plan=${expectedPlan} updatedBy=${expectedBy}`,
      data: {
        expected: { plan: expectedPlan, updatedBy: expectedBy, present: true },
        actual: {
          present: final !== null,
          plan: profile.plan ?? null,
          updatedBy: profile.updatedBy ?? null,
        },
      },
    });

    if (final === null) {
      return {
        safetyOutcome: 'invariant_violated',
        verdict: 'UNEXPECTED: Active customer was not present after normal update.',
        customerId: customer.id,
        finalCustomerState: null,
        customerStateKind: 'absent',
      };
    }

    if (profile.plan !== expectedPlan || profile.updatedBy !== expectedBy) {
      return {
        safetyOutcome: 'invariant_violated',
        verdict: `UNEXPECTED: Active update did not apply profile (plan=${String(profile.plan)}, updatedBy=${String(profile.updatedBy)}).`,
        customerId: customer.id,
        finalCustomerState: final,
        customerStateKind: 'present',
      };
    }

    return {
      safetyOutcome: 'invariant_held',
      verdict: 'Normal update succeeded — active customer profile updated correctly.',
      customerId: customer.id,
      finalCustomerState: final,
      customerStateKind: 'present',
    };
  });
}
