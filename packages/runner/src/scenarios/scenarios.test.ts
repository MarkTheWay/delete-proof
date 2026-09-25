/**
 * Integration test suite — DeleteProof verification matrix.
 *
 * Requires live PostgreSQL and Redis (docker-compose up -d).
 * Each test creates isolated fixtures with a unique run ID.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { SampleAppAdapter } from '../adapters/SampleAppAdapter';
import { runDelayedUpdateAfterDeletion } from '../scenarios/scenarioA';
import { runDuplicateStaleDelivery } from '../scenarios/scenarioB';
import { runConcurrentDeletionAndUpdate } from '../scenarios/scenarioC';
import { runNormalActiveUpdate } from '../scenarios/scenarioD';
import { runUnrelatedCustomerUpdate } from '../scenarios/scenarioE';

// Load env
import { readFileSync } from 'fs';
import { resolve } from 'path';
try {
  const lines = readFileSync(resolve(__dirname, '../../../../.env'), 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) process.env[m[1]] ??= m[2].trim();
  }
} catch { /* ok */ }

describe('Scenario A — Delayed update after deletion', () => {
  it('VULNERABLE: resurrects the customer (invariant violated)', async () => {
    const adapter = new SampleAppAdapter();
    const result = await runDelayedUpdateAfterDeletion(adapter, 'vulnerable');

    console.log(`\n[A/vulnerable] ${result.verdict}`);
    expect(result.executionStatus).toBe('completed');
    // In vulnerable mode, the stale event MUST resurrect the customer
    expect(result.invariantStatus).toBe('violated');
    expect(result.finalCustomerState).not.toBeNull();
    expect(result.verdict).toContain('Resurrection reproduced');
  });

  it('FIXED: customer stays absent (invariant held)', async () => {
    const adapter = new SampleAppAdapter();
    const result = await runDelayedUpdateAfterDeletion(adapter, 'fixed');

    console.log(`\n[A/fixed] ${result.verdict}`);
    expect(result.executionStatus).toBe('completed');
    expect(result.invariantStatus).toBe('held');
    expect(result.finalCustomerState).toBeNull();
  });
});

describe('Scenario B — Duplicate stale delivery', () => {
  it('FIXED: both deliveries blocked by tombstone', async () => {
    const adapter = new SampleAppAdapter();
    const result = await runDuplicateStaleDelivery(adapter, 'fixed');

    console.log(`\n[B/fixed] ${result.verdict}`);
    expect(result.executionStatus).toBe('completed');
    expect(result.invariantStatus).toBe('held');
    expect(result.finalCustomerState).toBeNull();
  });
});

describe('Scenario C — Concurrent deletion and processing', () => {
  it('FIXED: invariant holds after concurrent interleaving', async () => {
    const adapter = new SampleAppAdapter();
    const result = await runConcurrentDeletionAndUpdate(adapter, 'fixed');

    console.log(`\n[C/fixed] ${result.verdict}`);
    expect(result.executionStatus).toBe('completed');
    expect(result.invariantStatus).toBe('held');
    expect(result.finalCustomerState).toBeNull();
  });
});

describe('Scenario D — Normal active-customer update', () => {
  it('FIXED: update succeeds for active customer', async () => {
    const adapter = new SampleAppAdapter();
    const result = await runNormalActiveUpdate(adapter, 'fixed');

    console.log(`\n[D/fixed] ${result.verdict}`);
    expect(result.executionStatus).toBe('completed');
    expect(result.invariantStatus).toBe('held');
    expect(result.finalCustomerState).not.toBeNull();
  });
});

describe('Scenario E — Unrelated customer update', () => {
  it('FIXED: Customer A deletion does not affect Customer B', async () => {
    const adapter = new SampleAppAdapter();
    const result = await runUnrelatedCustomerUpdate(adapter, 'fixed');

    console.log(`\n[E/fixed] ${result.verdict}`);
    expect(result.executionStatus).toBe('completed');
    expect(result.invariantStatus).toBe('held');
    expect(result.finalCustomerState).not.toBeNull();
  });
});



