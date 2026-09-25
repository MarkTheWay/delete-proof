import Fastify from 'fastify';
import { getPool } from '../db/pool';
import { emitTrace, getTrace } from '../db/trace';
import {
  createCustomer,
  getCustomer,
  deleteCustomer,
} from './customers';
import type { Mode } from '@delete-proof/shared';

const app = Fastify({ logger: false });

// ─── Health ──────────────────────────────────────────────────────────────────
app.get('/health', async () => ({ ok: true }));

app.get('/readiness', async (req, reply) => {
  const pool = getPool();
  try {
    await pool.query('SELECT 1');
    return reply.send({ postgres: 'ok', status: 'ready' });
  } catch {
    return reply.code(503).send({ postgres: 'error', status: 'not_ready' });
  }
});

// ─── Customers ───────────────────────────────────────────────────────────────
app.post<{ Body: { runId: string; email: string; name: string } }>(
  '/customers',
  async (req, reply) => {
    const { runId, email, name } = req.body;
    const customer = await createCustomer(runId, { email, name });
    return reply.code(201).send(customer);
  },
);

app.get<{ Params: { id: string } }>(
  '/customers/:id',
  async (req, reply) => {
    const customer = await getCustomer(req.params.id);
    if (!customer) return reply.code(404).send({ error: 'not_found' });
    return customer;
  },
);

app.delete<{ Params: { id: string }; Body: { runId: string; mode: Mode } }>(
  '/customers/:id',
  async (req, reply) => {
    const { runId, mode } = req.body;
    await deleteCustomer(runId, req.params.id, mode);
    return reply.code(204).send();
  },
);

// ─── Barriers ────────────────────────────────────────────────────────────────
app.post<{ Body: { runId: string; name: string } }>(
  '/barriers',
  async (req, reply) => {
    const { runId, name } = req.body;
    const pool = getPool();
    await pool.query(
      `INSERT INTO barriers (id, run_id, released) VALUES ($1, $2, false)
       ON CONFLICT (id) DO UPDATE SET released = false`,
      [`${runId}:${name}`, runId],
    );
    await emitTrace(pool, runId, 'barrier_raised', `Barrier raised: ${name}`, { name });
    return reply.code(201).send({ raised: true });
  },
);

app.patch<{ Params: { name: string }; Body: { runId: string } }>(
  '/barriers/:name/release',
  async (req, reply) => {
    const { runId } = req.body;
    const pool = getPool();
    await pool.query(
      `UPDATE barriers SET released = true WHERE id = $1`,
      [`${runId}:${req.params.name}`],
    );
    await emitTrace(pool, runId, 'barrier_released', `Barrier released: ${req.params.name}`, { name: req.params.name });
    return reply.send({ released: true });
  },
);

// ─── Trace ───────────────────────────────────────────────────────────────────
app.get<{ Params: { runId: string } }>(
  '/runs/:runId/trace',
  async (req) => {
    const pool = getPool();
    return getTrace(pool, req.params.runId);
  },
);

// ─── Cleanup (per-run teardown) ───────────────────────────────────────────────
app.delete<{ Params: { runId: string } }>(
  '/runs/:runId',
  async (req, reply) => {
    const pool = getPool();
    const { runId } = req.params;
    await pool.query(`DELETE FROM trace_events WHERE run_id = $1`, [runId]);
    await pool.query(`DELETE FROM job_completions WHERE run_id = $1`, [runId]);
    await pool.query(`DELETE FROM barriers WHERE run_id = $1`, [runId]);
    await pool.query(`DELETE FROM tombstones WHERE run_id = $1`, [runId]);
    // customers created for this run are identified by the trace
    return reply.code(204).send();
  },
);

// ─── Startup ─────────────────────────────────────────────────────────────────
void (async () => {
  const port = Number(process.env.RUNNER_PORT ?? 3001);
  try {
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`DeleteProof API listening on :${port}`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();



