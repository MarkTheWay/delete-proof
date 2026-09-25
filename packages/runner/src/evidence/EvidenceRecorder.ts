/**
 * Evidence recorder — builds a RunResult as the scenario executes.
 */
import { execSync } from 'child_process';
import type { ExecutionStatus, InvariantStatus, Mode, RunResult, ScenarioId, TraceEvent } from '@delete-proof/shared';
import { v4 as uuidv4 } from 'uuid';

export class EvidenceRecorder {
  readonly runId: string;
  private startedAt: string;
  private trace: TraceEvent[] = [];
  private errors: string[] = [];

  constructor(
    readonly scenario: ScenarioId,
    readonly mode: Mode,
  ) {
    this.runId = uuidv4();
    this.startedAt = new Date().toISOString();
  }

  addTrace(event: TraceEvent): void {
    this.trace.push(event);
  }

  addError(msg: string): void {
    this.errors.push(msg);
  }

  build(
    executionStatus: ExecutionStatus,
    invariantStatus: InvariantStatus,
    verdict: string,
    finalCustomerState: RunResult['finalCustomerState'],
  ): RunResult {
    const completedAt = new Date().toISOString();
    const durationMs =
      new Date(completedAt).getTime() - new Date(this.startedAt).getTime();

    let codeRevision: string | undefined;
    let dirtyWorktree: boolean | undefined;
    try {
      codeRevision = execSync('git rev-parse --short HEAD', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
      const status = execSync('git status --porcelain', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
      dirtyWorktree = status.length > 0;
    } catch {
      // git not available or no commits yet
    }

    return {
      runId: this.runId,
      scenario: this.scenario,
      mode: this.mode,
      startedAt: this.startedAt,
      completedAt,
      durationMs,
      executionStatus,
      invariantStatus,
      verdict,
      trace: this.trace,
      finalCustomerState,
      errors: this.errors,
      codeRevision,
      dirtyWorktree,
    };
  }
}
