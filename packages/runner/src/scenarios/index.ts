import type { Mode, RunResult, ScenarioId, TargetAdapter } from '@delete-proof/shared';
import { runDelayedUpdateAfterDeletion } from './scenarioA';
import { runDuplicateStaleDelivery } from './scenarioB';
import { runConcurrentDeletionAndUpdate } from './scenarioC';
import { runNormalActiveUpdate } from './scenarioD';
import { runUnrelatedCustomerUpdate } from './scenarioE';

export interface ScenarioMeta {
  id: ScenarioId;
  title: string;
  description: string;
  supportedModes: Mode[];
}

export const SCENARIOS: ScenarioMeta[] = [
  {
    id: 'delayed_update_after_deletion',
    title: 'A: Delayed update after deletion',
    description: 'Stale event queued before deletion; worker held at barrier, then released after delete commits.',
    supportedModes: ['vulnerable', 'fixed'],
  },
  {
    id: 'duplicate_stale_delivery',
    title: 'B: Duplicate stale delivery',
    description: 'Same pre-deletion event delivered twice. Fixed mode must block both deliveries.',
    supportedModes: ['fixed', 'vulnerable'],
  },
  {
    id: 'concurrent_deletion_and_update',
    title: 'C: Concurrent deletion and processing',
    description: 'Deletion-first interleaving. Fixed mode ensures the worker sees the tombstone.',
    supportedModes: ['vulnerable', 'fixed'],
  },
  {
    id: 'normal_active_update',
    title: 'D: Normal active-customer update',
    description: 'Customer is not deleted. Update event must succeed.',
    supportedModes: ['vulnerable', 'fixed'],
  },
  {
    id: 'unrelated_customer_update',
    title: 'E: Unrelated customer update',
    description: 'Customer A deleted; Customer B update must not be affected.',
    supportedModes: ['vulnerable', 'fixed'],
  },
];

export async function runScenario(
  id: ScenarioId,
  mode: Mode,
  adapter: TargetAdapter,
): Promise<RunResult> {
  switch (id) {
    case 'delayed_update_after_deletion':
      return runDelayedUpdateAfterDeletion(adapter, mode);
    case 'duplicate_stale_delivery':
      return runDuplicateStaleDelivery(adapter, mode);
    case 'concurrent_deletion_and_update':
      return runConcurrentDeletionAndUpdate(adapter, mode);
    case 'normal_active_update':
      return runNormalActiveUpdate(adapter, mode);
    case 'unrelated_customer_update':
      return runUnrelatedCustomerUpdate(adapter, mode);
    default:
      throw new Error(`Unknown scenario: ${id}`);
  }
}



