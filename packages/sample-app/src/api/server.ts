/**
 * Fastify sample-app API.
 * Endpoints the runner adapter uses: create, enqueue, delete, health, heartbeat.
 */
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Mode } from '@delete-proof/shared';
import { loadEnv, sampleAppPort, testHooksEnabled } from '../config.js';
import { getPool } from '../db/pool.js';
import { deleteCustomerVulnerable } from '../modes/vulnerable.js';
import { deleteCustomerFixed } from '../modes/fixed.js';
import { getSyncQueue } from '../queue.js';
import { emitTrace } from '../trace.js';

loadEnv();

const app = Fastify({ logger: false });
const startedAt = Date.now();

app.get('/health', async () => ({
  ok: true,
  service: 'sample-app',
  testHooks: testHooksEnabled(),
}));

app.get('/heartbeat', async () => ({
  ok: true,
  uptimeMs: Date.now() - startedAt,
  ts: new Date().toISOString(),
}));

app.get('/readiness', async (_req, reply) => {
  try {
    await getPool().query('SELECT 1');
    return reply.send({ postgres: 'ok', status: 'ready' });
  } catch {
    return reply.code(503).send({ postgres: 'error', status: 'not_ready' });
  }
});

app.post<{
  Body: { runId: string; email: string; name: string };
}>('/customers', async (req, reply) => {
  const { runId, email, name } = req.body ?? {};
  if (!runId || !email || !name) {
    return reply.code(400).send({ error: 'runId, email, name required' });
  }
  const id = randomUUID();
  const pool = getPool();
  await pool.query(
    `INSERT INTO customers (id, email, name, profile, run_id, created_at, updated_at)
     VALUES ($1, $2, $3, '{}'::jsonb, $4, now(), now())`,
    [id, email, name, runId],
  );
  await emitTrace(runId, 'customer_created', `Customer ${id} created`, { id, email }, 'api');
  const row = await pool.query(
    `SELECT id, email, name, profile, run_id, created_at, updated_at FROM customers WHERE id = $1`,
    [id],
  );
  const r = row.rows[0];
  return reply.code(201).send({
    id: r.id,
    email: r.email,
    name: r.name,
    profile: r.profile,
    runId: r.run_id,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  });
});

app.get<{ Params: { id: string } }>('/customers/:id', async (req, reply) => {
  const result = await getPool().query(
    `SELECT id, email, name, profile, run_id, created_at, updated_at FROM customers WHERE id = $1`,
    [req.params.id],
  );
  if (result.rows.length === 0) return reply.code(404).send({ error: 'not_found' });
  const r = result.rows[0];
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    profile: r.profile,
    runId: r.run_id,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
});

app.post<{
  Params: { id: string };
  Body: {
    runId: string;
    mode: Mode;
    profilePatch?: Record<string, unknown>;
    email?: string;
    name?: string;
    jobId?: string;
  };
}>('/customers/:id/enqueue', async (req, reply) => {
  const { runId, mode, profilePatch, email, name, jobId } = req.body ?? {};
  if (!runId || !mode) {
    return reply.code(400).send({ error: 'runId and mode required' });
  }
  const customerId = req.params.id;
  const id = jobId ?? randomUUID();

  // Prefer live row email/name when present
  const existing = await getPool().query(
    `SELECT email, name FROM customers WHERE id = $1`,
    [customerId],
  );
  const rowEmail = existing.rows[0]?.email ?? email ?? 'synthetic@example.com';
  const rowName = existing.rows[0]?.name ?? name ?? 'Synthetic User';

  const queue = getSyncQueue();
  await queue.add(
    'profile-sync',
    {
      runId,
      customerId,
      mode,
      profilePatch: profilePatch ?? {},
      jobId: id,
      email: rowEmail,
      name: rowName,
    },
    { jobId: id, removeOnComplete: 100, removeOnFail: 100 },
  );

  await emitTrace(
    runId,
    'event_queued',
    `Sync job queued for customer ${customerId}`,
    { customerId, jobId: id, mode },
    'api',
  );

  return reply.code(202).send({ jobId: id });
});

app.delete<{
  Params: { id: string };
  Body: { runId: string; mode: Mode };
}>('/customers/:id', async (req, reply) => {
  const { runId, mode } = req.body ?? {};
  if (!runId || !mode) {
    return reply.code(400).send({ error: 'runId and mode required' });
  }
  const customerId = req.params.id;
  const pool = getPool();
  const client = await pool.connect();
  try {
    if (mode === 'fixed') {
      await deleteCustomerFixed(client, runId, customerId);
    } else {
      await deleteCustomerVulnerable(client, runId, customerId);
    }
    return reply.code(204).send();
  } finally {
    client.release();
  }
});

app.get<{ Params: { id: string } }>('/tombstones/:id', async (req, reply) => {
  const result = await getPool().query(
    `SELECT customer_id, deleted_at, run_id FROM customer_tombstones WHERE customer_id = $1`,
    [req.params.id],
  );
  if (result.rows.length === 0) return reply.code(404).send({ error: 'not_found' });
  const r = result.rows[0];
  return {
    customerId: r.customer_id,
    deletedAt: r.deleted_at.toISOString(),
    runId: r.run_id,
  };
});

void (async () => {
  const port = sampleAppPort();
  try {
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`DeleteProof sample-app API listening on :${port} (hooks=${testHooksEnabled()})`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
