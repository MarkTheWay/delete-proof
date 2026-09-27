#!/usr/bin/env tsx
/**
 * DeleteProof MCP server (stdio) — MCP protocol compliant.
 * Tools: list_scenarios, run_scenario, get_run_trace, compare_runs, list_runs, export_report
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
const SERVER_INFO = { name: 'delete-proof', version: '0.1.0' };
const PROTOCOL_VERSION = '2024-11-05';

type JsonRpcId = number | string | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

function loadRun(runId: string): RunResult | null {
  try {
    return JSON.parse(readFileSync(join(EVIDENCE_DIR, `${runId}.json`), 'utf8')) as RunResult;
  } catch {
    return null;
  }
}

const TOOLS = [
  {
    name: 'list_scenarios',
    description: 'List DeleteProof scenarios and supported modes',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'run_scenario',
    description: 'Run a scenario in vulnerable or fixed mode and save evidence',
    inputSchema: {
      type: 'object',
      properties: {
        scenario: { type: 'string', description: 'Scenario id' },
        mode: { type: 'string', enum: ['vulnerable', 'fixed'] },
      },
      required: ['scenario', 'mode'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_run_trace',
    description: 'Fetch the trace for a saved evidence runId',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string' } },
      required: ['runId'],
      additionalProperties: false,
    },
  },
  {
    name: 'compare_runs',
    description: 'Compare two saved runs (safetyOutcome / verdict)',
    inputSchema: {
      type: 'object',
      properties: {
        runId1: { type: 'string' },
        runId2: { type: 'string' },
      },
      required: ['runId1', 'runId2'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_runs',
    description: 'List saved evidence run IDs',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'export_report',
    description: 'Export full evidence JSON for a runId',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string' } },
      required: ['runId'],
      additionalProperties: false,
    },
  },
] as const;

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case 'list_scenarios':
      return { scenarios: SCENARIOS };

    case 'run_scenario': {
      const scenario = String(args.scenario ?? '');
      const mode = String(args.mode ?? '');
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
          customerStateKind: result.customerStateKind,
          verdict: result.verdict,
          durationMs: result.durationMs,
        };
      } finally {
        await adapter.close();
      }
    }

    case 'get_run_trace': {
      const run = loadRun(String(args.runId ?? ''));
      if (!run) throw new Error(`Run not found: ${args.runId}`);
      return { runId: run.runId, trace: run.trace, errors: run.errors };
    }

    case 'compare_runs': {
      const r1 = loadRun(String(args.runId1 ?? ''));
      const r2 = loadRun(String(args.runId2 ?? ''));
      if (!r1) throw new Error(`Run not found: ${args.runId1}`);
      if (!r2) throw new Error(`Run not found: ${args.runId2}`);
      return {
        run1: {
          runId: r1.runId,
          mode: r1.mode,
          safetyOutcome: r1.safetyOutcome,
          customerStateKind: r1.customerStateKind,
          verdict: r1.verdict,
        },
        run2: {
          runId: r2.runId,
          mode: r2.mode,
          safetyOutcome: r2.safetyOutcome,
          customerStateKind: r2.customerStateKind,
          verdict: r2.verdict,
        },
        sameScenario: r1.scenario === r2.scenario,
      };
    }

    case 'list_runs': {
      try {
        const runs = readdirSync(EVIDENCE_DIR)
          .filter((f) => f.endsWith('.json'))
          .map((f) => f.replace(/\.json$/, ''));
        return { runs };
      } catch {
        return { runs: [] };
      }
    }

    case 'export_report': {
      const run = loadRun(String(args.runId ?? ''));
      if (!run) throw new Error(`Run not found: ${args.runId}`);
      return { report: JSON.stringify(run, null, 2) };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function send(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendResult(id: JsonRpcId | undefined, result: unknown): void {
  if (id === undefined) return;
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id: JsonRpcId | undefined, code: number, message: string): void {
  if (id === undefined) return;
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleMessage(msg: JsonRpcRequest): Promise<void> {
  const { method, params = {}, id } = msg;

  try {
    switch (method) {
      case 'initialize':
        sendResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
        return;

      case 'notifications/initialized':
      case 'initialized':
        return;

      case 'ping':
        sendResult(id, {});
        return;

      case 'tools/list':
        sendResult(id, { tools: TOOLS });
        return;

      case 'tools/call': {
        const name = String(params.name ?? '');
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        const result = await callTool(name, args);
        sendResult(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        });
        return;
      }

      // Backward-compatible aliases (pre-MCP custom methods)
      case 'list_scenarios':
      case 'run_scenario':
      case 'get_run_trace':
      case 'compare_runs':
      case 'list_runs':
      case 'export_report': {
        const result = await callTool(method, params);
        sendResult(id, result);
        return;
      }

      default:
        sendError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    sendError(id, -32000, String(err));
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
    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(line) as JsonRpcRequest;
    } catch {
      continue;
    }
    void handleMessage(msg);
  }
});

process.stderr.write('[DeleteProof MCP] Ready on stdio (tools/list + tools/call).\n');
