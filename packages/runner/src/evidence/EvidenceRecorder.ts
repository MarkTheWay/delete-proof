/**
 * Evidence recorder — separates executionStatus from safetyOutcome.
 */
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type {
  CustomerStateKind,
  ExecutionStatus,
  Mode,
  RunResult,
  SafetyOutcome,
  ScenarioId,
  TraceEvent,
  Customer,
} from '@delete-proof/shared';

export class EvidenceRecorder {
  readonly runId: string;
  private startedAt: string;
  private trace: TraceEvent[] = [];
  private errors: string[] = [];

  constructor(
    readonly scenario: ScenarioId,
    readonly mode: Mode,
  ) {
    this.runId = randomUUID();
    this.startedAt = new Date().toISOString();
  }

  addTrace(event: TraceEvent): void {
    this.trace.push(event);
  }

  /** Merge Redis/service events with runner observations (lock waits, assertions). */
  mergeServiceTrace(events: TraceEvent[]): void {
    this.trace = [...this.trace, ...events].sort((a, b) => a.ts.localeCompare(b.ts));
  }

  addError(msg: string): void {
    this.errors.push(msg);
  }

  build(
    executionStatus: ExecutionStatus,
    safetyOutcome: SafetyOutcome,
    verdict: string,
    finalCustomerState: Customer | null,
    tombstonePresent?: boolean,
    customerStateKind: CustomerStateKind = finalCustomerState ? 'present' : 'absent',
  ): RunResult {
    const completedAt = new Date().toISOString();
    const durationMs =
      new Date(completedAt).getTime() - new Date(this.startedAt).getTime();

    let codeRevision: string | undefined;
    let dirtyWorktree: boolean | undefined;
    try {
      codeRevision = execSync('git rev-parse --short HEAD', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
      const status = execSync('git status --porcelain', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
      dirtyWorktree = status.length > 0;
    } catch {
      /* git unavailable */
    }

    return {
      runId: this.runId,
      scenario: this.scenario,
      mode: this.mode,
      startedAt: this.startedAt,
      completedAt,
      durationMs,
      executionStatus,
      safetyOutcome,
      verdict,
      trace: this.trace,
      finalCustomerState,
      customerStateKind,
      tombstonePresent,
      errors: this.errors,
      codeRevision,
      dirtyWorktree,
    };
  }
}
