/**
 * Runner HTTP API — exposes scenario execution to the React dashboard.
 * Reuses the same SampleAppAdapter and scenario runner as the CLI.
 */
import Fastify from 'fastify';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Mode, RunResult, ScenarioId } from '@delete-proof/shared';
import { SCENARIOS, runScenario } from './scenarios/index';
import { SampleAppAdapter } from './adapters/SampleAppAdapter';
import pg from 'pg';

// Load env
import { resolve } from 'path';
const envPath = resolve(__dirname, '../../../.env');
try {
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) process.env[m[1]] ??= m[2].trim();
  }
} catch { /* ok */ }

const EVIDENCE_DIR = resolve(__dirname, '../../../evidence/runs');
mkdirSync(EVIDENCE_DIR, { recursive: true });

const app = Fastify({ logger: false });

// CORS for dashboard dev server
app.addHook('onSend', async (req, reply) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Headers', 'content-type');
  reply.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
});
app.options('*', async (_req, reply) => reply.code(204).send());

// ─── Readiness ────────────────────────────────────────────────────────────────
app.get('/readiness', async (_req, reply) => {
  const results: Record<string, string> = {};
  try {
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL ?? 'postgresql://deleteproof:deleteproof@localhost:5432/deleteproof',
    });
    await pool.query('SELECT 1');
    await pool.end();
    results.postgres = 'ok';
  } catch { results.postgres = 'error'; }

  try {
    const { default: Redis } = await import('ioredis');
    const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
    const r = new Redis({ host: url.hostname, port: Number(url.port || 6379), lazyConnect: true });
    await r.connect();
    await r.ping();
    await r.disconnect();
    results.redis = 'ok';
  } catch { results.redis = 'error'; }

  const allOk = Object.values(results).every((v) => v === 'ok');
  return reply.code(allOk ? 200 : 503).send({ ...results, status: allOk ? 'ready' : 'not_ready' });
});

// ─── Scenarios ────────────────────────────────────────────────────────────────
app.get('/scenarios', async () => SCENARIOS);

// ─── Runs ─────────────────────────────────────────────────────────────────────
app.get('/runs', async () => {
  try {
    const files = readdirSync(EVIDENCE_DIR).filter((f) => f.endsWith('.json'));
    return files
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(EVIDENCE_DIR, f), 'utf8')) as RunResult;
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a: RunResult, b: RunResult) => b.startedAt.localeCompare(a.startedAt));
  } catch { return []; }
});

app.post<{ Body: { scenario: ScenarioId; mode: Mode } }>(
  '/runs',
  async (req, reply) => {
    const { scenario, mode } = req.body;
    if (!scenario || !mode) return reply.code(400).send({ error: 'scenario and mode are required' });
    const adapter = new SampleAppAdapter();
    const result = await runScenario(scenario, mode, adapter);
    const file = join(EVIDENCE_DIR, `${result.runId}.json`);
    writeFileSync(file, JSON.stringify(result, null, 2));
    return result;
  },
);

app.get<{ Params: { runId: string } }>(
  '/runs/:runId',
  async (req, reply) => {
    try {
      const file = join(EVIDENCE_DIR, `${req.params.runId}.json`);
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return reply.code(404).send({ error: 'run not found' });
    }
  },
);

app.get<{ Params: { runId: string } }>(
  '/runs/:runId/download',
  async (req, reply) => {
    try {
      const file = join(EVIDENCE_DIR, `${req.params.runId}.json`);
      const content = readFileSync(file, 'utf8');
      reply.header('Content-Disposition', `attachment; filename="run-${req.params.runId}.json"`);
      reply.header('Content-Type', 'application/json');
      return reply.send(content);
    } catch {
      return reply.code(404).send({ error: 'run not found' });
    }
  },
);

// ─── Startup ─────────────────────────────────────────────────────────────────
void (async () => {
  const port = Number(process.env.RUNNER_PORT ?? 3001);
  try {
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`DeleteProof Runner API listening on :${port}`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();



