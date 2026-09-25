import type { Mode, RunResult, ScenarioId } from '@delete-proof/shared';
import type { SampleAppAdapter } from '../adapters/SampleAppAdapter.js';
import { runDelayedUpdateAfterDelete } from './delayed-update-after-delete.js';
import { runDuplicateStaleDelivery } from './duplicate-stale-delivery.js';
import { runConcurrentDeleteUpdate } from './concurrent-delete-update.js';
import { runActiveCustomerUpdate } from './active-customer-update.js';
import { runUnrelatedCustomerUpdate } from './unrelated-customer-update.js';

export interface ScenarioMeta {
  id: ScenarioId;
  title: string;
  description: string;
  supportedModes: Mode[];
}

export const SCENARIOS: ScenarioMeta[] = [
  {
    id: 'delayed-update-after-delete',
    title: 'Delayed update after delete',
    description:
      'Stale sync queued before deletion; Redis barriers make the interleaving deterministic.',
    supportedModes: ['vulnerable', 'fixed'],
  },
  {
    id: 'duplicate-stale-delivery',
    title: 'Duplicate stale delivery',
    description: 'Same pre-deletion sync delivered twice. Fixed mode must block both.',
    supportedModes: ['vulnerable', 'fixed'],
  },
  {
    id: 'concurrent-delete-update',
    title: 'Concurrent delete + update',
    description: 'Exercises both advisory-lock orderings (delete-first and worker-first).',
    supportedModes: ['vulnerable', 'fixed'],
  },
  {
    id: 'active-customer-update',
    title: 'Active customer update',
    description: 'Customer is not deleted. Sync must succeed.',
    supportedModes: ['vulnerable', 'fixed'],
  },
  {
    id: 'unrelated-customer-update',
    title: 'Unrelated customer update',
    description: 'Customer A deleted; Customer B sync must not be affected.',
    supportedModes: ['vulnerable', 'fixed'],
  },
];

export async function runScenario(
  id: ScenarioId,
  mode: Mode,
  adapter: SampleAppAdapter,
): Promise<RunResult> {
  switch (id) {
    case 'delayed-update-after-delete':
      return runDelayedUpdateAfterDelete(adapter, mode);
    case 'duplicate-stale-delivery':
      return runDuplicateStaleDelivery(adapter, mode);
    case 'concurrent-delete-update':
      return runConcurrentDeleteUpdate(adapter, mode);
    case 'active-customer-update':
      return runActiveCustomerUpdate(adapter, mode);
    case 'unrelated-customer-update':
      return runUnrelatedCustomerUpdate(adapter, mode);
    default:
      throw new Error(`Unknown scenario: ${id}`);
  }
}
