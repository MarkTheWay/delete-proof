/** Shared DeleteProof types — no sample-app imports. */

export interface Customer {
  id: string;
  email: string;
  name: string;
  profile: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  runId?: string;
}

export interface Tombstone {
  customerId: string;
  deletedAt: string;
  runId: string;
}

export type Mode = 'vulnerable' | 'fixed';

export type ScenarioId =
  | 'delayed-update-after-delete'
  | 'duplicate-stale-delivery'
  | 'concurrent-delete-update'
  | 'active-customer-update'
  | 'unrelated-customer-update';

export type TraceEventKind =
  | 'customer_created'
  | 'event_queued'
  | 'barrier_ack'
  | 'barrier_released'
  | 'barrier_timeout'
  | 'customer_deleted'
  | 'deletion_committed'
  | 'worker_processing'
  | 'worker_blocked_by_tombstone'
  | 'worker_write_attempted'
  | 'worker_write_committed'
  | 'lock_wait_observed'
  | 'db_assertion'
  | 'invariant_result'
  | 'error'
  | 'cleanup';

export interface TraceEvent {
  id?: string;
  ts: string;
  kind: TraceEventKind;
  actor?: string;
  message: string;
  data?: Record<string, unknown>;
}

export type ExecutionStatus = 'running' | 'completed' | 'failed';
export type SafetyOutcome = 'invariant_held' | 'invariant_violated' | 'not_evaluated';

/** Whether finalCustomerState was actually observed (vs failed/unknown). */
export type CustomerStateKind = 'present' | 'absent' | 'unknown';

export interface RunResult {
  runId: string;
  scenario: ScenarioId;
  mode: Mode;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  executionStatus: ExecutionStatus;
  /** Separated from executionStatus — did the deletion invariant hold? */
  safetyOutcome: SafetyOutcome;
  /** Human-readable verdict */
  verdict: string;
  trace: TraceEvent[];
  finalCustomerState: Customer | null;
  /**
   * Distinguishes observed absence from “never read / failed before assert”.
   * `null` finalCustomerState + `absent` = deleted; + `unknown` = not observed.
   */
  customerStateKind?: CustomerStateKind;
  tombstonePresent?: boolean;
  errors: string[];
  codeRevision?: string;
  dirtyWorktree?: boolean;
}

export interface LockWaitState {
  waiting: boolean;
  backends: Array<{
    pid: number;
    applicationName: string | null;
    waitEventType: string | null;
    waitEvent: string | null;
    state: string | null;
    query: string | null;
  }>;
}

export interface TargetAdapter {
  createCustomer(
    runId: string,
    opts: { email: string; name: string },
  ): Promise<Customer>;
  enqueueSync(
    runId: string,
    customerId: string,
    opts: {
      mode: Mode;
      profilePatch?: Record<string, unknown>;
      email?: string;
      name?: string;
      jobId?: string;
    },
  ): Promise<{ jobId: string }>;
  deleteCustomer(runId: string, customerId: string, mode: Mode): Promise<void>;
  readCustomer(customerId: string): Promise<Customer | null>;
  readTombstone(customerId: string): Promise<Tombstone | null>;
  lockWaitState(runId: string): Promise<LockWaitState>;
  health(): Promise<{
    ok: boolean;
    api: string;
    postgres: string;
    redis: string;
    worker?: string;
    testHooks?: string;
  }>;
  cleanup(runId: string): Promise<void>;
  /** Redis barrier: wait until sample-app/worker LPUSH ack for point */
  waitForBarrierAck(runId: string, point: string, timeoutMs?: number): Promise<void>;
  /** Redis barrier: LPUSH release so the waiter can leave BLPOP */
  releaseBarrier(runId: string, point: string): Promise<void>;
  readTrace(runId: string): Promise<TraceEvent[]>;
}

/** Exact vulnerable-mode violation string required by DoD */
export const VULNERABLE_RESURRECTION_VERDICT =
  'Resurrection reproduced — deletion invariant failed.';
