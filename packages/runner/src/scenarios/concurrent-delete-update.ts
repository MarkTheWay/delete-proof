/**
 * concurrent-delete-update — both advisory-lock orderings.
 */
import type { Mode, RunResult } from '@delete-proof/shared';
import type { SampleAppAdapter } from '../adapters/SampleAppAdapter.js';
import { EvidenceRecorder } from '../evidence/EvidenceRecorder.js';
import { resurrectionVerdict, withRun } from './helpers.js';

async function runDeleteFirst(
  adapter: SampleAppAdapter,
  runId: string,
  mode: Mode,
): Promise<string> {
  const customer = await adapter.createCustomer(runId, {
    email: `conc-df-${runId}@synthetic.example`,
    name: 'Concurrent Delete-First',
  });

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

  const deleteP = adapter.startDeleteCustomer(runId, customer.id, mode);
  const first = await adapter.waitForFirstBarrierAck(runId, [
    'api.before_commit',
    'worker.before_write',
  ]);
  if (first === 'worker.before_write') {
    await adapter.releaseBarrier(runId, 'worker.before_write');
    await adapter.waitForBarrierAck(runId, 'api.before_commit');
  }
  const lockState = await adapter.waitForLockWait(runId, 2_000);
  void lockState;
  await adapter.releaseBarrier(runId, 'api.before_commit');
  await deleteP;
  try {
    await adapter.waitForBarrierAck(runId, 'worker.before_write', 1_000);
    await adapter.releaseBarrier(runId, 'worker.before_write');
  } catch {
    /* ok */
  }
  await adapter.waitForTraceKind(
    runId,
    ['worker_blocked_by_tombstone', 'worker_write_committed'],
    15_000,
  );
  return customer.id;
}

async function runWorkerFirst(
  adapter: SampleAppAdapter,
  runId: string,
  mode: Mode,
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

  await adapter.waitForBarrierAck(runId, 'worker.before_write');

  if (mode === 'vulnerable') {
    await adapter.deleteCustomer(runId, customer.id, mode);
    await adapter.releaseBarrier(runId, 'worker.before_write');
    await adapter.waitForTraceKind(runId, ['worker_write_committed']);
    return customer.id;
  }

  const deleteP = adapter.startDeleteCustomer(runId, customer.id, mode);
  const lockState = await adapter.waitForLockWait(runId, 8_000);
  if (!lockState.waiting) {
    throw new Error('Expected delete backend to wait on Lock (worker-first ordering)');
  }
  await adapter.releaseBarrier(runId, 'worker.before_write');
  await adapter.waitForBarrierAck(runId, 'api.before_commit');
  await adapter.releaseBarrier(runId, 'api.before_commit');
  await deleteP;
  return customer.id;
}

export async function runConcurrentDeleteUpdate(
  adapter: SampleAppAdapter,
  mode: Mode,
): Promise<RunResult> {
  const rec = new EvidenceRecorder('concurrent-delete-update', mode);

  return withRun(adapter, rec, async () => {
    const runId = rec.runId;

    const idA = await runDeleteFirst(adapter, `${runId}-a`, mode);
    const idB = await runWorkerFirst(adapter, `${runId}-b`, mode);

    const finalA = await adapter.readCustomer(idA);
    const finalB = await adapter.readCustomer(idB);

    const traceA = await adapter.readTrace(`${runId}-a`);
    const traceB = await adapter.readTrace(`${runId}-b`);
    const merged = [...traceA, ...traceB].sort((a, b) => a.ts.localeCompare(b.ts));

    await adapter.cleanup(`${runId}-a`);
    await adapter.cleanup(`${runId}-b`);

    const present = finalA !== null || finalB !== null;
    const { safetyOutcome, verdict } = resurrectionVerdict(mode, present);
    return {
      safetyOutcome,
      verdict: `${verdict} (both orderings exercised)`,
      customerId: idB,
      traceOverride: merged,
    };
  });
}
