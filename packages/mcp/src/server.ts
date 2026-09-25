#!/usr/bin/env tsx
/**
 * DeleteProof MCP Adapter (stdio transport)
 *
 * Exposes the scenario runner to IBM Bob via the MCP protocol.
 * Reuses the existing SampleAppAdapter and runScenario function.
 *
 * Tools exposed:
 *   list_scenarios   — list available scenarios
 *   run_scenario     — run a named scenario in vulnerable|fixed mode
 *   get_run_trace    — retrieve trace for a completed run
 *   compare_runs     — compare two runs side by side
 *   export_report    — export run evidence as JSON string
 *
 * Security: all inputs are validated; execution is restricted to the
 *   synthetic demo environment. No unrestricted shell or SQL tools.
 *
 * Usage (in .bob/mcp.json):
 *   { "command": "npx", "args": ["tsx", "packages/mcp/src/server.ts"] }
 */
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import type { Mode, RunResult, ScenarioId } from '@delete-proof/shared';
import { SCENARIOS, runScenario } from '../runner/src/scenarios/index';
import { SampleAppAdapter } from '../runner/src/adapters/SampleAppAdapter';

// Load env
const envPath = resolve(__dirname, '../../.env');
try {
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) process.env[m[1]] ??= m[2].trim();
  }
} catch { /* ok */ }

const EVIDENCE_DIR = resolve(__dirname, '../../evidence/runs');
mkdirSync(EVIDENCE_DIR, { recursive: true });

function loadRun(runId: string): RunResult | null {
  try {
    return JSON.parse(readFileSync(join(EVIDENCE_DIR, `${runId}.json`), 'utf8'));
  } catch { return null; }
}

function listRuns(): RunResult[] {
  try {
    return readdirSync(EVIDENCE_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try { return JSON.parse(readFileSync(join(EVIDENCE_DIR, f), 'utf8')); } catch { return null; }
      })
      .filter(Boolean)
      .sort((a: RunResult, b: RunResult) => b.startedAt.localeCompare(a.startedAt));
  } catch { return []; }
}

// ─── MCP stdio protocol (minimal implementation) ─────────────────────────────
// Reads JSON-RPC 2.0 messages from stdin, writes responses to stdout.

const VALID_SCENARIOS = new Set(SCENARIOS.map((s) => s.id));
const VALID_MODES = new Set<string>(['vulnerable', 'fixed']);

async function handleCall(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'list_scenarios': {
      return SCENARIOS.map((s) => ({
        id: s.id,
        title: s.title,
        description: s.description,
        supportedModes: s.supportedModes,
      }));
    }

    case 'run_scenario': {
      const { scenario, mode } = params as { scenario: string; mode: string };
      if (!VALID_SCENARIOS.has(scenario as ScenarioId)) {
        throw new Error(`Invalid scenario: ${scenario}. Valid: ${[...VALID_SCENARIOS].join(', ')}`);
      }
      if (!VALID_MODES.has(mode)) {
        throw new Error(`Invalid mode: ${mode}. Use 'vulnerable' or 'fixed'`);
      }
      const adapter = new SampleAppAdapter();
      const result = await runScenario(scenario as ScenarioId, mode as Mode, adapter);
      writeFileSync(join(EVIDENCE_DIR, `${result.runId}.json`), JSON.stringify(result, null, 2));
      return {
        runId: result.runId,
        scenario: result.scenario,
        mode: result.mode,
        executionStatus: result.executionStatus,
        invariantStatus: result.invariantStatus,
        verdict: result.verdict,
        durationMs: result.durationMs,
        traceCount: result.trace.length,
      };
    }

    case 'get_run_trace': {
      const { runId } = params as { runId: string };
      const run = loadRun(runId);
      if (!run) throw new Error(`Run not found: ${runId}`);
      return { runId: run.runId, trace: run.trace, errors: run.errors };
    }

    case 'compare_runs': {
      const { runId1, runId2 } = params as { runId1: string; runId2: string };
      const r1 = loadRun(runId1);
      const r2 = loadRun(runId2);
      if (!r1) throw new Error(`Run not found: ${runId1}`);
      if (!r2) throw new Error(`Run not found: ${runId2}`);
      return {
        run1: { runId: r1.runId, mode: r1.mode, invariantStatus: r1.invariantStatus, verdict: r1.verdict, finalCustomerState: r1.finalCustomerState },
        run2: { runId: r2.runId, mode: r2.mode, invariantStatus: r2.invariantStatus, verdict: r2.verdict, finalCustomerState: r2.finalCustomerState },
        sameScenario: r1.scenario === r2.scenario,
      };
    }

    case 'export_report': {
      const { runId } = params as { runId: string };
      const run = loadRun(runId);
      if (!run) throw new Error(`Run not found: ${runId}`);
      return { report: JSON.stringify(run, null, 2) };
    }

    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

// ─── stdio JSON-RPC loop ─────────────────────────────────────────────────────
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
        msg = JSON.parse(line);
      } catch {
        return;
      }
      try {
        const result = await handleCall(msg.method, msg.params ?? {});
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
      } catch (err) {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          error: { code: -32000, message: String(err) },
        }) + '\n');
      }
    })();
  }
});

process.stderr.write('[DeleteProof MCP] Ready. Listening on stdio.\n');
