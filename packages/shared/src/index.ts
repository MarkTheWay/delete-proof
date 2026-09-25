// ─── Customer Domain ─────────────────────────────────────────────────────────

export interface Customer {
  id: string;          // immutable UUID – never reused after deletion
  email: string;
  name: string;
  profile: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Tombstone {
  customerId: string;
  deletedAt: string;
}

// ─── Evidence / Trace ────────────────────────────────────────────────────────

export type TraceEventKind =
  | 'customer_created'
  | 'event_queued'
  | 'barrier_raised'
  | 'customer_deleted'
  | 'deletion_committed'
  | 'barrier_released'
  | 'worker_processing'
  | 'worker_blocked_by_tombstone'
  | 'worker_write_attempted'
  | 'worker_write_skipped'
  | 'db_assertion'
  | 'invariant_result'
  | 'error';

export interface TraceEvent {
  seq: number;
  ts: string;           // ISO-8601
  kind: TraceEventKind;
  message: string;
  data?: Record<string, unknown>;
}

export type ScenarioId =
  | 'delayed_update_after_deletion'
  | 'duplicate_stale_delivery'
  | 'concurrent_deletion_and_update'
  | 'normal_active_update'
  | 'unrelated_customer_update'
  | 'worker_restart_durability';

export type Mode = 'vulnerable' | 'fixed';

export type ExecutionStatus = 'running' | 'completed' | 'failed';
export type InvariantStatus = 'held' | 'violated' | 'not_applicable' | 'pending';

export interface RunResult {
  runId: string;
  scenario: ScenarioId;
  mode: Mode;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  executionStatus: ExecutionStatus;
  invariantStatus: InvariantStatus;
  /** Human-readable verdict, e.g. "Resurrection reproduced — deletion invariant failed." */
  verdict: string;
  trace: TraceEvent[];
  finalCustomerState: Customer | null;
  errors: string[];
  codeRevision?: string;
  dirtyWorktree?: boolean;
}

// ─── Adapter interface ───────────────────────────────────────────────────────

export interface TargetAdapter {
  /** Migrate / reset schema for a fresh run */
  setup(runId: string): Promise<void>;
  /** Remove all data created for this run */
  teardown(runId: string): Promise<void>;
  /** Create a synthetic customer, return its ID */
  createCustomer(runId: string, opts: { email: string; name: string }): Promise<string>;
  /** Queue a profile-update event (pre-deletion) */
  queueUpdateEvent(runId: string, customerId: string, payload: Record<string, unknown>): Promise<void>;
  /** Block worker processing at a named barrier */
  raiseBarrier(runId: string, name: string): Promise<void>;
  /** Delete the customer (API path) */
  deleteCustomer(runId: string, customerId: string, mode: Mode): Promise<void>;
  /** Confirm deletion committed in DB */
  assertDeleted(runId: string, customerId: string): Promise<boolean>;
  /** Release named barrier */
  releaseBarrier(runId: string, name: string): Promise<void>;
  /** Wait until the queued event has been processed (acknowledged or skipped) */
  waitForWorker(runId: string, jobId: string, timeoutMs?: number): Promise<void>;
  /** Query the current customer state */
  queryCustomer(runId: string, customerId: string): Promise<Customer | null>;
  /** Subscribe to trace events emitted by the sample app */
  onTrace(runId: string, cb: (event: TraceEvent) => void): () => void;
}
