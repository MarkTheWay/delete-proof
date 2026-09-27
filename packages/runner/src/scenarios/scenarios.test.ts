/**
 * Integration tests — require live Postgres, Redis, sample-app API + worker.
 * Label: Implemented; pass only when services are up (not verified in offline CI).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { VULNERABLE_RESURRECTION_VERDICT } from '@delete-proof/shared';
import { SampleAppAdapter } from '../adapters/SampleAppAdapter.js';
import { loadEnv } from '../env.js';
import { runDelayedUpdateAfterDelete } from './delayed-update-after-delete.js';
import { runDuplicateStaleDelivery } from './duplicate-stale-delivery.js';
import { runConcurrentDeleteUpdate } from './concurrent-delete-update.js';
import { runActiveCustomerUpdate } from './active-customer-update.js';
import { runUnrelatedCustomerUpdate } from './unrelated-customer-update.js';

loadEnv();

let adapter: SampleAppAdapter;

beforeAll(async () => {
  adapter = new SampleAppAdapter();
  const h = await adapter.health();
  if (!h.ok) {
    throw new Error(
      `Services not ready for integration tests: ${JSON.stringify(h)}. ` +
        'Start docker compose, migrate, start:api, and start:worker.',
    );
  }
});

describe('delayed-update-after-delete', () => {
  it('vulnerable: resurrects (invariant violated)', async () => {
    const result = await runDelayedUpdateAfterDelete(adapter, 'vulnerable');
    expect(result.executionStatus).toBe('completed');
    expect(result.safetyOutcome).toBe('invariant_violated');
    expect(result.finalCustomerState).not.toBeNull();
    expect(result.verdict).toBe(VULNERABLE_RESURRECTION_VERDICT);
  });

  it('fixed: customer stays absent', async () => {
    const result = await runDelayedUpdateAfterDelete(adapter, 'fixed');
    expect(result.executionStatus).toBe('completed');
    expect(result.safetyOutcome).toBe('invariant_held');
    expect(result.finalCustomerState).toBeNull();
    expect(result.customerStateKind).toBe('absent');
    expect(result.trace.some((e) => e.kind === 'lock_wait_observed')).toBe(true);
    expect(result.trace.some((e) => e.kind === 'worker_blocked_by_tombstone')).toBe(true);
  });
});

describe('duplicate-stale-delivery', () => {
  it('fixed: both deliveries leave customer absent', async () => {
    const result = await runDuplicateStaleDelivery(adapter, 'fixed');
    expect(result.executionStatus).toBe('completed');
    expect(result.safetyOutcome).toBe('invariant_held');
    expect(result.finalCustomerState).toBeNull();
  });
});

describe('concurrent-delete-update', () => {
  it('fixed: both orderings keep invariant', async () => {
    const result = await runConcurrentDeleteUpdate(adapter, 'fixed');
    expect(result.executionStatus).toBe('completed');
    expect(result.safetyOutcome).toBe('invariant_held');
    expect(result.customerStateKind).toBe('absent');
    const lockWaits = result.trace.filter((e) => e.kind === 'lock_wait_observed');
    expect(lockWaits.length).toBeGreaterThanOrEqual(2);
  });
});

describe('active-customer-update', () => {
  it('fixed: update succeeds', async () => {
    const result = await runActiveCustomerUpdate(adapter, 'fixed');
    expect(result.executionStatus).toBe('completed');
    expect(result.safetyOutcome).toBe('invariant_held');
    expect(result.finalCustomerState).not.toBeNull();
    expect(result.finalCustomerState?.profile.plan).toBe('pro');
  });
});

describe('unrelated-customer-update', () => {
  it('fixed: B unaffected by A deletion', async () => {
    const result = await runUnrelatedCustomerUpdate(adapter, 'fixed');
    expect(result.executionStatus).toBe('completed');
    expect(result.safetyOutcome).toBe('invariant_held');
    expect(result.finalCustomerState).not.toBeNull();
    expect(result.finalCustomerState?.profile.feature).toBe('unrelated-update');
  });
});
