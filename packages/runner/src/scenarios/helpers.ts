/**
 * Scenario helpers shared across runs.
 */
import type { Mode, RunResult, SafetyOutcome } from '@delete-proof/shared';
import { VULNERABLE_RESURRECTION_VERDICT } from '@delete-proof/shared';
import type { SampleAppAdapter } from '../adapters/SampleAppAdapter.js';
import { EvidenceRecorder } from '../evidence/EvidenceRecorder.js';

export async function withRun(
  adapter: SampleAppAdapter,
  rec: EvidenceRecorder,
  body: () => Promise<{
    safetyOutcome: SafetyOutcome;
    verdict: string;
    customerId?: string;
    /** When set, used instead of reading parent runId trace (e.g. concurrent sub-runs). */
    traceOverride?: Awaited<ReturnType<SampleAppAdapter['readTrace']>>;
  }>,
): Promise<RunResult> {
  const runId = rec.runId;
  try {
    const { safetyOutcome, verdict, customerId, traceOverride } = await body();
    const finalCustomerState = customerId
      ? await adapter.readCustomer(customerId)
      : null;
    const tombstonePresent = customerId
      ? (await adapter.readTombstone(customerId)) !== null
      : undefined;
    rec.setTrace(traceOverride ?? (await adapter.readTrace(runId)));
    const result = rec.build(
      'completed',
      safetyOutcome,
      verdict,
      finalCustomerState,
      tombstonePresent,
    );
    await adapter.cleanup(runId);
    return result;
  } catch (err) {
    rec.addError(String(err));
    try {
      rec.setTrace(await adapter.readTrace(runId));
    } catch {
      /* ignore */
    }
    const result = rec.build(
      'failed',
      'not_evaluated',
      `Execution error: ${err}`,
      null,
    );
    try {
      await adapter.cleanup(runId);
    } catch {
      /* ignore */
    }
    return result;
  }
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
