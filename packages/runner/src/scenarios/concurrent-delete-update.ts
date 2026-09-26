/**
 * concurrent-delete-update — both advisory-lock orderings (forced, not raced).
 */
import type { Mode, RunResult } from '@delete-proof/shared';
import type { SampleAppAdapter } from '../adapters/SampleAppAdapter.js';
import { EvidenceRecorder } from '../evidence/EvidenceRecorder.js';
import {
  resurrectionVerdict,
  runFixedDeleteFirstOrdering,
  runFixedWorkerFirstOrdering,
  withRun,
} from './helpers.js';

async function runDeleteFirst(
  adapter: SampleAppAdapter,
  runId: string,
  mode: Mode,
  rec: EvidenceRecorder,
): Promise<string> {
  const customer = await adapter.createCustomer(runId, {
    email: `conc-df-${runId}@synthetic.example`,
    name: 'Concurrent Delete-First',
  });

  if (mode === 'fixed') {
    await adapter.armJobReceivedBarrier(runId);
  }

  await adapter.enqueueSync(runId, customer.id, {
    mode,
    profilePatch: { ordering: 'delete-first' },
    jobId: `${runId}-df`,
    email: customer.email,
    name: customer.name,
  });

  if (mode === 'vulnerable') {
    await adapter.waitForBarrierAck(runId, 'worker.before_write');
    await adapter.deleteCustomer(runId, customer.id, mode);
    await adapter.releaseBarrier(runId, 'worker.before_write');
    await adapter.waitForTraceKind(runId, ['worker_write_committed']);
    return customer.id;
  }

  await runFixedDeleteFirstOrdering(adapter, runId, customer.id, rec);
  return customer.id;
}

async function runWorkerFirst(
  adapter: SampleAppAdapter,
  runId: string,
  mode: Mode,
  rec: EvidenceRecorder,
): Promise<string> {
  const customer = await adapter.createCustomer(runId, {
    email: `conc-wf-${runId}@synthetic.example`,
    name: 'Concurrent Worker-First',
  });

  await adapter.enqueueSync(runId, customer.id, {
    mode,
    profilePatch: { ordering: 'worker-first' },
    jobId: `${runId}-wf`,
    email: customer.email,
    name: customer.name,
  });

  if (mode === 'vulnerable') {
    await adapter.waitForBarrierAck(runId, 'worker.before_write');
    await adapter.deleteCustomer(runId, customer.id, mode);
    await adapter.releaseBarrier(runId, 'worker.before_write');
    await adapter.waitForTraceKind(runId, ['worker_write_committed']);
    return customer.id;
  }

  await runFixedWorkerFirstOrdering(adapter, runId, customer.id, rec);
  return customer.id;
}

export async function runConcurrentDeleteUpdate(
  adapter: SampleAppAdapter,
  mode: Mode,
): Promise<RunResult> {
  const rec = new EvidenceRecorder('concurrent-delete-update', mode);

  return withRun(adapter, rec, async () => {
    const runId = rec.runId;
    const subA = `${runId}-a`;
    const subB = `${runId}-b`;

    const idA = await runDeleteFirst(adapter, subA, mode, rec);
    const idB = await runWorkerFirst(adapter, subB, mode, rec);

    const finalA = await adapter.readCustomer(idA);
    const finalB = await adapter.readCustomer(idB);

    const traceA = await adapter.readTrace(subA);
    const traceB = await adapter.readTrace(subB);
    const merged = [...traceA, ...traceB].sort((a, b) => a.ts.localeCompare(b.ts));

    const present = finalA !== null || finalB !== null;
    const { safetyOutcome, verdict } = resurrectionVerdict(mode, present);

    return {
      safetyOutcome,
      verdict: `${verdict} (both orderings exercised)`,
      customerId: idB,
      // Snapshot BEFORE cleanup of sub-runs (cleanup runs in withRun finally).
      finalCustomerState: finalB,
      customerStateKind: finalB ? 'present' : 'absent',
      traceOverride: merged,
      extraCleanupIds: [subA, subB],
    };
  });
}
