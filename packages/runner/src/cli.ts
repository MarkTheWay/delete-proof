#!/usr/bin/env tsx
/**
 * DeleteProof CLI
 *
 * Usage:
 *   dp list                          — list available scenarios
 *   dp run <scenario> <mode>         — run a scenario (mode: vulnerable|fixed)
 *   dp run-all                       — run all scenarios in both modes
 *   dp report <runId>                — print evidence for a saved run
 */
import { writeFileSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import type { Mode, RunResult, ScenarioId } from '@delete-proof/shared';
import { SCENARIOS, runScenario } from './scenarios/index';
import { SampleAppAdapter } from './adapters/SampleAppAdapter';

// Load env (workspace root .env)
const envPath = resolve(__dirname, '../../../.env');
try {
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) process.env[m[1]] ??= m[2].trim();
  }
} catch { /* .env may not exist */ }

const EVIDENCE_DIR = resolve(__dirname, '../../../evidence/runs');

function saveRun(result: RunResult): string {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const file = join(EVIDENCE_DIR, `${result.runId}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  return file;
}

function printRun(result: RunResult): void {
  const icon = result.invariantStatus === 'held' ? '✅'
    : result.invariantStatus === 'violated' ? '❌'
    : result.executionStatus === 'failed' ? '💥'
    : '⚠️';

  console.log(`\n${icon}  ${result.scenario} [${result.mode}]`);
  console.log(`   Run ID  : ${result.runId}`);
  console.log(`   Status  : ${result.executionStatus}`);
  console.log(`   Invariant: ${result.invariantStatus}`);
  console.log(`   Verdict : ${result.verdict}`);
  console.log(`   Duration: ${result.durationMs}ms`);
  if (result.codeRevision) console.log(`   Revision: ${result.codeRevision}${result.dirtyWorktree ? ' (dirty)' : ''}`);
  if (result.errors.length > 0) console.log(`   Errors  : ${result.errors.join('; ')}`);
  console.log('\n   Trace:');
  for (const e of result.trace) {
    console.log(`     [${e.seq.toString().padStart(3)}] ${e.ts.slice(11, 23)}  ${e.kind.padEnd(32)} ${e.message}`);
  }
  console.log(`\n   Final customer state: ${result.finalCustomerState ? JSON.stringify(result.finalCustomerState) : 'absent (null)'}`);
}

const [,, command, ...args] = process.argv;

void (async () => {
  switch (command) {
    case 'list': {
      console.log('\nAvailable DeleteProof scenarios:\n');
      for (const s of SCENARIOS) {
        console.log(`  ${s.id}`);
        console.log(`    ${s.title}`);
        console.log(`    ${s.description}`);
        console.log(`    Modes: ${s.supportedModes.join(', ')}\n`);
      }
      break;
    }

    case 'run': {
      const [scenarioId, mode] = args as [ScenarioId, Mode];
      if (!scenarioId || !mode) {
        console.error('Usage: dp run <scenarioId> <vulnerable|fixed>');
        process.exit(1);
      }
      console.log(`\nRunning scenario "${scenarioId}" in ${mode} mode…`);
      const adapter = new SampleAppAdapter();
      const result = await runScenario(scenarioId, mode, adapter);
      printRun(result);
      const file = saveRun(result);
      console.log(`\nEvidence saved → ${file}`);
      process.exit(result.executionStatus === 'failed' ? 1 : 0);
      break;
    }

    case 'run-all': {
      const adapter = new SampleAppAdapter();
      const results: RunResult[] = [];
      for (const s of SCENARIOS) {
        for (const m of s.supportedModes) {
          console.log(`\nRunning ${s.id} [${m}]…`);
          const result = await runScenario(s.id, m as Mode, adapter);
          printRun(result);
          saveRun(result);
          results.push(result);
        }
      }

      // Summary table
      console.log('\n══════════════════════════════════════════════════════════════');
      console.log('  VERIFICATION MATRIX');
      console.log('══════════════════════════════════════════════════════════════');
      console.log('  Scenario                         Mode         Invariant');
      console.log('  ─────────────────────────────────────────────────────────');
      for (const r of results) {
        const icon = r.invariantStatus === 'held' ? '✅ held    '
          : r.invariantStatus === 'violated' ? '❌ violated'
          : '⚠️  n/a     ';
        console.log(`  ${r.scenario.padEnd(33)} ${r.mode.padEnd(12)} ${icon}`);
      }
      console.log('══════════════════════════════════════════════════════════════\n');
      process.exit(results.some((r) => r.executionStatus === 'failed') ? 1 : 0);
      break;
    }

    case 'report': {
      const [runId] = args;
      if (!runId) {
        try {
          const files = readdirSync(EVIDENCE_DIR).filter((f) => f.endsWith('.json'));
          console.log(`\nSaved runs in ${EVIDENCE_DIR}:\n`);
          for (const f of files) console.log(`  ${f}`);
        } catch {
          console.log('No evidence runs found. Run a scenario first.');
        }
        break;
      }
      const file = join(EVIDENCE_DIR, `${runId}.json`);
      const result = JSON.parse(readFileSync(file, 'utf8')) as RunResult;
      printRun(result);
      break;
    }

    default: {
      console.log(`
DeleteProof CLI

  dp list                    List available scenarios
  dp run <scenario> <mode>   Run a scenario (mode: vulnerable|fixed)
  dp run-all                 Run all scenarios in both modes
  dp report [runId]          Print evidence for a saved run
`);
    }
  }
})();
