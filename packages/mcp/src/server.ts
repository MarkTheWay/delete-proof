#!/usr/bin/env tsx
/**
 * Thin DeleteProof MCP adapter (stdio JSON-RPC).
 * Registered in .bob/mcp.json — no unrestricted shell/SQL tools.
 */
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Mode, RunResult, ScenarioId } from '@delete-proof/shared';
import { SampleAppAdapter } from '../../runner/src/adapters/SampleAppAdapter.js';
import { loadEnv } from '../../runner/src/env.js';
import { SCENARIOS, runScenario } from '../../runner/src/scenarios/index.js';

loadEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = resolve(__dirname, '../../../evidence/runs');
mkdirSync(EVIDENCE_DIR, { recursive: true });

const VALID_SCENARIOS = new Set(SCENARIOS.map((s) => s.id));
const VALID_MODES = new Set(['vulnerable', 'fixed']);

function loadRun(runId: string): RunResult | null {
  try {
    return JSON.parse(readFileSync(join(EVIDENCE_DIR, `${runId}.json`), 'utf8')) as RunResult;
  } catch {
    return null;
  }
}

async function handleCall(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'list_scenarios':
      return SCENARIOS;

    case 'run_scenario': {
      const scenario = String(params.scenario ?? '');
      const mode = String(params.mode ?? '');
      if (!VALID_SCENARIOS.has(scenario as ScenarioId)) {
        throw new Error(`Invalid scenario: ${scenario}`);
      }
      if (!VALID_MODES.has(mode)) {
        throw new Error(`Invalid mode: ${mode}`);
      }
      const adapter = new SampleAppAdapter();
      try {
        const result = await runScenario(scenario as ScenarioId, mode as Mode, adapter);
        writeFileSync(join(EVIDENCE_DIR, `${result.runId}.json`), JSON.stringify(result, null, 2));
        return {
          runId: result.runId,
          scenario: result.scenario,
          mode: result.mode,
          executionStatus: result.executionStatus,
          safetyOutcome: result.safetyOutcome,
          verdict: result.verdict,
          durationMs: result.durationMs,
        };
      } finally {
        await adapter.close();
      }
    }

    case 'get_run_trace': {
      const run = loadRun(String(params.runId ?? ''));
      if (!run) throw new Error(`Run not found: ${params.runId}`);
      return { runId: run.runId, trace: run.trace, errors: run.errors };
    }

    case 'compare_runs': {
      const r1 = loadRun(String(params.runId1 ?? ''));
      const r2 = loadRun(String(params.runId2 ?? ''));
      if (!r1) throw new Error(`Run not found: ${params.runId1}`);
      if (!r2) throw new Error(`Run not found: ${params.runId2}`);
      return {
        run1: {
          runId: r1.runId,
          mode: r1.mode,
          safetyOutcome: r1.safetyOutcome,
          verdict: r1.verdict,
        },
        run2: {
          runId: r2.runId,
          mode: r2.mode,
          safetyOutcome: r2.safetyOutcome,
          verdict: r2.verdict,
        },
        sameScenario: r1.scenario === r2.scenario,
      };
    }

    case 'export_report': {
      const run = loadRun(String(params.runId ?? ''));
      if (!run) throw new Error(`Run not found: ${params.runId}`);
      return { report: JSON.stringify(run, null, 2) };
    }

    case 'list_runs': {
      try {
        return readdirSync(EVIDENCE_DIR)
          .filter((f) => f.endsWith('.json'))
          .map((f) => f.replace(/\.json$/, ''));
      } catch {
        return [];
      }
    }

    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buf += chunk;
  const lines = buf.split('\n');
  buf = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    void (async () => {
      let msg: { id?: number | string; method: string; params?: Record<string, unknown> };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        return;
      }
      try {
        const result = await handleCall(msg.method, msg.params ?? {});
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
      } catch (err) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32000, message: String(err) },
          }) + '\n',
        );
      }
    })();
  }
});

process.stderr.write('[DeleteProof MCP] Ready on stdio.\n');
