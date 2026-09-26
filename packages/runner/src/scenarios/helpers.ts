/**
 * Scenario helpers shared across runs.
 */
import type {
  Customer,
  CustomerStateKind,
  Mode,
  RunResult,
  SafetyOutcome,
  TraceEvent,
} from '@delete-proof/shared';
import { VULNERABLE_RESURRECTION_VERDICT } from '@delete-proof/shared';
import type { SampleAppAdapter } from '../adapters/SampleAppAdapter.js';
import { EvidenceRecorder } from '../evidence/EvidenceRecorder.js';

export type ScenarioBodyResult = {
  safetyOutcome: SafetyOutcome;
  verdict: string;
  customerId?: string;
  /** Snapshot taken before cleanup — preferred over a post-cleanup re-read. */
  finalCustomerState?: Customer | null;
  customerStateKind?: CustomerStateKind;
  /** When set, merged with runner observations (lock waits, assertions). */
  traceOverride?: Awaited<ReturnType<SampleAppAdapter['readTrace']>>;
  /** Extra cleanup runIds (e.g. concurrent sub-runs). */
  extraCleanupIds?: string[];
};

export async function withRun(
  adapter: SampleAppAdapter,
  rec: EvidenceRecorder,
  body: () => Promise<ScenarioBodyResult>,
): Promise<RunResult> {
  const runId = rec.runId;
  const extraCleanup: string[] = [];
  try {
    const out = await body();
    if (out.extraCleanupIds) extraCleanup.push(...out.extraCleanupIds);

    const serviceTrace =
      out.traceOverride ?? (await adapter.readTrace(runId));
    rec.mergeServiceTrace(serviceTrace);

    let finalCustomerState: Customer | null;
    let customerStateKind: CustomerStateKind;

    if (out.customerStateKind) {
      customerStateKind = out.customerStateKind;
      finalCustomerState =
        out.finalCustomerState !== undefined
          ? out.finalCustomerState
          : out.customerId
            ? await adapter.readCustomer(out.customerId)
            : null;
    } else if (out.finalCustomerState !== undefined) {
      finalCustomerState = out.finalCustomerState;
      customerStateKind = finalCustomerState ? 'present' : 'absent';
    } else if (out.customerId) {
      finalCustomerState = await adapter.readCustomer(out.customerId);
      customerStateKind = finalCustomerState ? 'present' : 'absent';
    } else {
      finalCustomerState = null;
      customerStateKind = 'unknown';
    }

    const tombstonePresent = out.customerId
      ? (await adapter.readTombstone(out.customerId)) !== null
      : undefined;

    const result = rec.build(
      'completed',
      out.safetyOutcome,
      out.verdict,
      finalCustomerState,
      tombstonePresent,
      customerStateKind,
    );
    return result;
  } catch (err) {
    rec.addError(String(err));
    try {
      rec.mergeServiceTrace(await adapter.readTrace(runId));
    } catch {
      /* ignore */
    }
    return rec.build(
      'failed',
      'not_evaluated',
      `Execution error: ${err}`,
      null,
      undefined,
      'unknown',
    );
  } finally {
    for (const id of [...new Set([runId, ...extraCleanup])]) {
      try {
        await adapter.cleanup(id);
      } catch {
        /* ignore */
      }
    }
  }
}

export function mergeTraces(a: TraceEvent[], b: TraceEvent[]): TraceEvent[] {
  return [...a, ...b].sort((x, y) => x.ts.localeCompare(y.ts));
}

export function resurrectionVerdict(mode: Mode, customerPresent: boolean): {
  safetyOutcome: SafetyOutcome;
  verdict: string;
} {
  if (mode === 'vulnerable') {
    if (customerPresent) {
      return {
        safetyOutcome: 'invariant_violated',
        verdict: VULNERABLE_RESURRECTION_VERDICT,
      };
    }
    return {
      safetyOutcome: 'invariant_held',
      verdict: 'Vulnerable mode — customer absent (resurrection did not occur in this run).',
    };
  }
  if (customerPresent) {
    return {
      safetyOutcome: 'invariant_violated',
      verdict: 'UNEXPECTED: Fixed mode resurrected customer — invariant violated.',
    };
  }
  return {
    safetyOutcome: 'invariant_held',
    verdict: 'Deletion invariant held — customer stayed absent after stale event.',
  };
}

/** Release worker.before_write if an ack is already waiting / arrives soon. */
export async function releaseWorkerWriteIfAcked(
  adapter: SampleAppAdapter,
  runId: string,
  timeoutMs = 2_000,
): Promise<boolean> {
  try {
    await adapter.waitForBarrierAck(runId, 'worker.before_write', timeoutMs);
    await adapter.releaseBarrier(runId, 'worker.before_write');
    return true;
  } catch {
    return false;
  }
}

/**
 * Fixed-mode delete-first choreography (caller must armJobReceived + enqueue first):
 * hold worker at job_received (before lock) → delete reaches before_commit →
 * release worker → assert Lock wait → release delete → tombstone blocks write.
 */
export async function runFixedDeleteFirstOrdering(
  adapter: SampleAppAdapter,
  runId: string,
  customerId: string,
  rec: EvidenceRecorder,
): Promise<void> {
  const deleteP = adapter.startDeleteCustomer(runId, customerId, 'fixed');

  // Worker must be parked before lock so delete can win the advisory lock.
  await adapter.waitForBarrierAck(runId, 'worker.job_received');
  await adapter.waitForBarrierAck(runId, 'api.before_commit');

  await adapter.releaseBarrier(runId, 'worker.job_received');

  const lockState = await adapter.waitForLockWait(runId, 8_000);
  if (!lockState.waiting) {
    throw new Error(
      'Expected worker to Lock-wait while delete held api.before_commit (delete-first)',
    );
  }
  rec.addTrace({
    ts: new Date().toISOString(),
    kind: 'lock_wait_observed',
    message: 'Worker backend waiting on Lock while delete held before_commit (delete-first)',
    data: { backends: lockState.backends, ordering: 'delete-first' },
  });

  await adapter.releaseBarrier(runId, 'api.before_commit');
  await deleteP;

  await adapter.waitForTraceKind(
    runId,
    ['worker_blocked_by_tombstone', 'worker_write_committed'],
    15_000,
  );
}

/**
 * Fixed-mode worker-first choreography:
 * hold worker at before_write (lock held) → start delete → assert Lock wait →
 * release worker → delete commits → (worker may write then lose to delete, or block).
 */
export async function runFixedWorkerFirstOrdering(
  adapter: SampleAppAdapter,
  runId: string,
  customerId: string,
  rec: EvidenceRecorder,
): Promise<void> {
  await adapter.waitForBarrierAck(runId, 'worker.before_write');

  const deleteP = adapter.startDeleteCustomer(runId, customerId, 'fixed');
  const lockState = await adapter.waitForLockWait(runId, 8_000);
  if (!lockState.waiting) {
    throw new Error(
      'Expected delete backend to wait on Lock while worker held before_write (worker-first)',
    );
  }
  rec.addTrace({
    ts: new Date().toISOString(),
    kind: 'lock_wait_observed',
    message: 'Delete backend waiting on Lock while worker held before_write (worker-first)',
    data: { backends: lockState.backends, ordering: 'worker-first' },
  });

  await adapter.releaseBarrier(runId, 'worker.before_write');
  await adapter.waitForBarrierAck(runId, 'api.before_commit');
  await adapter.releaseBarrier(runId, 'api.before_commit');
  await deleteP;
}
