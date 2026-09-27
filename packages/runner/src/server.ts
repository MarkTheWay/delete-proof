/**
 * Runner HTTP API — consumed by the React dashboard (real API only).
 */
import Fastify from 'fastify';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Mode, RunResult, ScenarioId } from '@delete-proof/shared';
import { SampleAppAdapter } from './adapters/SampleAppAdapter.js';
import { loadEnv } from './env.js';
import { SCENARIOS, runScenario } from './scenarios/index.js';

loadEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = resolve(__dirname, '../../../evidence/runs');
mkdirSync(EVIDENCE_DIR, { recursive: true });

const app = Fastify({ logger: false });

app.addHook('onSend', async (_req, reply) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Headers', 'content-type');
  reply.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
});
app.options('/*', async (_req, reply) => reply.code(204).send());

app.get('/health', async () => ({ ok: true, service: 'runner' }));

app.get('/readiness', async (_req, reply) => {
  const adapter = new SampleAppAdapter();
  try {
    const h = await adapter.health();
    return reply.code(h.ok ? 200 : 503).send({
      postgres: h.postgres,
      redis: h.redis,
      api: h.api,
      worker: h.worker,
      testHooks: h.testHooks,
      status: h.ok ? 'ready' : 'not_ready',
    });
  } finally {
    await adapter.close();
  }
});

app.get('/scenarios', async () => SCENARIOS);

app.get('/runs', async () => {
  try {
    const files = readdirSync(EVIDENCE_DIR).filter((f) => f.endsWith('.json'));
    return files
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(EVIDENCE_DIR, f), 'utf8')) as RunResult;
        } catch {
          return null;
        }
      })
      .filter((r): r is RunResult => r !== null)
      .sort((a: RunResult, b: RunResult) => b.startedAt.localeCompare(a.startedAt));
  } catch {
    return [];
  }
});

app.post<{ Body: { scenario: ScenarioId; mode: Mode } }>('/runs', async (req, reply) => {
  const { scenario, mode } = req.body ?? {};
  if (!scenario || !mode) {
    return reply.code(400).send({ error: 'scenario and mode are required' });
  }
  if (!SCENARIOS.some((s) => s.id === scenario)) {
    return reply.code(400).send({ error: `unknown scenario: ${scenario}` });
  }
  if (mode !== 'vulnerable' && mode !== 'fixed') {
    return reply.code(400).send({ error: 'mode must be vulnerable or fixed' });
  }
  const adapter = new SampleAppAdapter();
  try {
    const result = await runScenario(scenario, mode, adapter);
    writeFileSync(join(EVIDENCE_DIR, `${result.runId}.json`), JSON.stringify(result, null, 2));
    return result;
  } finally {
    await adapter.close();
  }
});

app.get<{ Params: { runId: string } }>('/runs/:runId', async (req, reply) => {
  try {
    return JSON.parse(readFileSync(join(EVIDENCE_DIR, `${req.params.runId}.json`), 'utf8'));
  } catch {
    return reply.code(404).send({ error: 'run not found' });
  }
});

app.get<{ Params: { runId: string } }>('/runs/:runId/download', async (req, reply) => {
  try {
    const content = readFileSync(join(EVIDENCE_DIR, `${req.params.runId}.json`), 'utf8');
    reply.header('Content-Disposition', `attachment; filename="run-${req.params.runId}.json"`);
    reply.header('Content-Type', 'application/json');
    return reply.send(content);
  } catch {
    return reply.code(404).send({ error: 'run not found' });
  }
});

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
