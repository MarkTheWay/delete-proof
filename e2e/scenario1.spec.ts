/**
 * E2E: scenario 1 (delayed-update-after-delete) in both modes via runner HTTP API.
 * Requires: docker up, migrate, start:api, start:worker, start:runner.
 */
import { test, expect } from '@playwright/test';

const VULNERABLE_VERDICT = 'Resurrection reproduced — deletion invariant failed.';

test.describe('scenario 1 — delayed-update-after-delete', () => {
  test.beforeAll(async ({ request }) => {
    const ready = await request.get('/readiness');
    expect(ready.ok(), 'Runner readiness failed — start infrastructure + apps').toBeTruthy();
    const body = await ready.json();
    expect(body.status).toBe('ready');
  });

  test('vulnerable mode resurrects customer', async ({ request }) => {
    const res = await request.post('/runs', {
      data: { scenario: 'delayed-update-after-delete', mode: 'vulnerable' },
      timeout: 120_000,
    });
    expect(res.ok()).toBeTruthy();
    const run = await res.json();
    expect(run.executionStatus).toBe('completed');
    expect(run.safetyOutcome).toBe('invariant_violated');
    expect(run.verdict).toBe(VULNERABLE_VERDICT);
    expect(run.finalCustomerState).not.toBeNull();
  });

  test('fixed mode keeps customer absent', async ({ request }) => {
    const res = await request.post('/runs', {
      data: { scenario: 'delayed-update-after-delete', mode: 'fixed' },
      timeout: 120_000,
    });
    expect(res.ok()).toBeTruthy();
    const run = await res.json();
    expect(run.executionStatus).toBe('completed');
    expect(run.safetyOutcome).toBe('invariant_held');
    expect(run.finalCustomerState).toBeNull();
  });
});
