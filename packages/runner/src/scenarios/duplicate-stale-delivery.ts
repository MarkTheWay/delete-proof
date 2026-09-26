/**
 * duplicate-stale-delivery — same pre-deletion sync delivered twice.
 *
 * Fixed mode: arm worker.job_received so BOTH jobs pause before the advisory
 * lock. Delete commits the tombstone, then both jobs are released and each
 * reports blocked_by_tombstone.
 */
import type { Mode, RunResult } from '@delete-proof/shared';
import type { SampleAppAdapter } from '../adapters/SampleAppAdapter.js';
import { EvidenceRecorder } from '../evidence/EvidenceRecorder.js';
import { resurrectionVerdict, withRun } from './helpers.js';

export async function runDuplicateStaleDelivery(
  adapter: SampleAppAdapter,
  mode: Mode,
): Promise<RunResult> {
  const rec = new EvidenceRecorder('duplicate-stale-delivery', mode);

  return withRun(adapter, rec, async () => {
    const runId = rec.runId;
    const customer = await adapter.createCustomer(runId, {
      email: `dup-${runId}@synthetic.example`,
      name: 'Duplicate Test',
    });

    if (mode === 'fixed') {
      await adapter.armJobReceivedBarrier(runId);
    }

    await adapter.enqueueSync(runId, customer.id, {
      mode,
      profilePatch: { dup: 1 },
      jobId: `${runId}-dup1`,
      email: customer.email,
      name: customer.name,
    });
    await adapter.enqueueSync(runId, customer.id, {
      mode,
      profilePatch: { dup: 2 },
      jobId: `${runId}-dup2`,
      email: customer.email,
      name: customer.name,
    });

    if (mode === 'vulnerable') {
      // Hold both at before_write (no lock), delete, then release both → resurrection.
      await adapter.waitForBarrierAck(runId, 'worker.before_write');
      await adapter.waitForBarrierAck(runId, 'worker.before_write');
      await adapter.deleteCustomer(runId, customer.id, mode);
      await adapter.releaseBarrier(runId, 'worker.before_write');
      await adapter.releaseBarrier(runId, 'worker.before_write');
      await adapter.waitForTraceKind(runId, ['worker_write_committed']);
    } else {
      // Wait for both job_received acks (consumed one-by-one).
      await adapter.waitForBarrierAck(runId, 'worker.job_received');
      await adapter.waitForBarrierAck(runId, 'worker.job_received');

      await adapter.deleteCustomer(runId, customer.id, mode);

      // Release both workers — each acquires lock, sees tombstone, skips write.
      await adapter.releaseBarrier(runId, 'worker.job_received');
      await adapter.releaseBarrier(runId, 'worker.job_received');

      // Expect two blocked_by_tombstone events (poll until count >= 2).
      const deadline = Date.now() + 15_000;
      let blocked = 0;
      while (Date.now() < deadline) {
        const trace = await adapter.readTrace(runId);
        blocked = trace.filter((e) => e.kind === 'worker_blocked_by_tombstone').length;
        if (blocked >= 2) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      if (blocked < 2) {
        throw new Error(
          `Expected both jobs blocked_by_tombstone, observed ${blocked}`,
        );
      }
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
