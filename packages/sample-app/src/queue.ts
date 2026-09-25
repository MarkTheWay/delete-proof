import { Queue } from 'bullmq';
import { QUEUE_NAME, redisUrl } from './config.js';

export interface SyncJobPayload {
  runId: string;
  customerId: string;
  mode: 'vulnerable' | 'fixed';
  profilePatch: Record<string, unknown>;
  jobId: string;
  email: string;
  name: string;
}

function connectionOpts() {
  const url = new URL(redisUrl());
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    password: url.password || undefined,
  };
}

let _queue: Queue<SyncJobPayload> | null = null;

export function getSyncQueue(): Queue<SyncJobPayload> {
  if (!_queue) {
    _queue = new Queue<SyncJobPayload>(QUEUE_NAME, { connection: connectionOpts() });
  }
  return _queue;
}

export async function closeSyncQueue(): Promise<void> {
  if (_queue) {
    await _queue.close();
    _queue = null;
  }
}

export { connectionOpts };
