#!/usr/bin/env tsx
/**
 * DeleteProof CLI
 *
 *   npm run dp -- list
 *   npm run dp -- run --scenario <id> --mode <vulnerable|fixed>
 *   npm run dp -- verify
 *   npm run dp -- compare
 *   npm run dp -- report [runId]
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Mode, RunResult, ScenarioId } from '@delete-proof/shared';
import { SampleAppAdapter } from './adapters/SampleAppAdapter.js';
import { loadEnv } from './env.js';
import { SCENARIOS, runScenario } from './scenarios/index.js';

loadEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = resolve(__dirname, '../../../evidence/runs');

function saveRun(result: RunResult): string {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const file = join(EVIDENCE_DIR, `${result.runId}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  return file;
}

function printRun(result: RunResult): void {
  const icon =
    result.safetyOutcome === 'invariant_held'
      ? '✅'
      : result.safetyOutcome === 'invariant_violated'
        ? '❌'
        : result.executionStatus === 'failed'
          ? '💥'
          : '⚠️';

  console.log(`\n${icon}  ${result.scenario} [${result.mode}]`);
  console.log(`   Run ID         : ${result.runId}`);
  console.log(`   Execution      : ${result.executionStatus}`);
  console.log(`   Safety outcome : ${result.safetyOutcome}`);
  console.log(`   Verdict        : ${result.verdict}`);
  console.log(`   Duration       : ${result.durationMs}ms`);
  if (result.codeRevision) {
    console.log(
      `   Revision       : ${result.codeRevision}${result.dirtyWorktree ? ' (dirty)' : ''}`,
    );
  }
  if (result.errors.length > 0) console.log(`   Errors         : ${result.errors.join('; ')}`);
  console.log('\n   Trace:');
  for (const [i, e] of result.trace.entries()) {
    console.log(
      `     [${String(i + 1).padStart(3)}] ${e.ts.slice(11, 23)}  ${e.kind.padEnd(32)} ${e.message}`,
    );
  }
  console.log(
    `\n   Final customer state: ${
      result.finalCustomerState ? JSON.stringify(result.finalCustomerState) : 'absent (null)'
    }`,
  );
}

function parseArgs(argv: string[]): {
  command: string;
  scenario?: string;
  mode?: string;
  positional: string[];
} {
  const [command, ...rest] = argv;
  let scenario: string | undefined;
  let mode: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--scenario') scenario = rest[++i];
    else if (a === '--mode') mode = rest[++i];
    else if (a.startsWith('--scenario=')) scenario = a.slice('--scenario='.length);
    else if (a.startsWith('--mode=')) mode = a.slice('--mode='.length);
    else positional.push(a);
  }
  return { command: command ?? '', scenario, mode, positional };
}

function expectedSafety(scenario: ScenarioId, mode: Mode): string {
  if (
    mode === 'vulnerable' &&
    (scenario === 'delayed-update-after-delete' ||
      scenario === 'duplicate-stale-delivery' ||
      scenario === 'concurrent-delete-update')
  ) {
    return 'invariant_violated';
  }
  return 'invariant_held';
}

void (async () => {
  const { command, scenario, mode, positional } = parseArgs(process.argv.slice(2));

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
      const scenarioId = (scenario ?? positional[0]) as ScenarioId | undefined;
      const runMode = (mode ?? positional[1]) as Mode | undefined;
      if (!scenarioId || !runMode) {
        console.error('Usage: dp run --scenario <id> --mode <vulnerable|fixed>');
        process.exit(1);
      }
      if (!SCENARIOS.some((s) => s.id === scenarioId)) {
        console.error(`Unknown scenario: ${scenarioId}`);
        process.exit(1);
      }
      if (runMode !== 'vulnerable' && runMode !== 'fixed') {
        console.error(`Invalid mode: ${runMode}`);
        process.exit(1);
      }

      console.log(`\nRunning scenario "${scenarioId}" in ${runMode} mode…`);
      const adapter = new SampleAppAdapter();
      const health = await adapter.health();
      if (!health.ok) {
        console.error('Services not ready:', health);
        process.exit(1);
      }
      const result = await runScenario(scenarioId, runMode, adapter);
      printRun(result);
      const file = saveRun(result);
      console.log(`\nEvidence saved → ${file}`);
      await adapter.close();
      process.exit(result.executionStatus === 'failed' ? 1 : 0);
      break;
    }

    case 'verify': {
      const adapter = new SampleAppAdapter();
      const health = await adapter.health();
      if (!health.ok) {
        console.error('Services not ready — start docker, migrate, api, and worker first.');
        console.error(health);
        process.exit(1);
      }

      const results: RunResult[] = [];
      let failed = false;
      for (const s of SCENARIOS) {
        for (const m of s.supportedModes) {
          console.log(`\n▶ verify ${s.id} [${m}]`);
          let result: RunResult;
          try {
            result = await runScenario(s.id, m, adapter);
          } catch (err) {
            failed = true;
            console.error(`   ✗ threw: ${err}`);
            continue;
          }
          printRun(result);
          saveRun(result);
          results.push(result);
          const expected = expectedSafety(s.id, m);
          if (result.executionStatus !== 'completed' || result.safetyOutcome !== expected) {
            failed = true;
            console.error(`   ✗ expected safetyOutcome=${expected}`);
          }
        }
      }

      console.log('\n══════════════════════════════════════════════════════════════');
      console.log('  VERIFICATION MATRIX');
      console.log('══════════════════════════════════════════════════════════════');
      for (const r of results) {
        const icon =
          r.safetyOutcome === 'invariant_held'
            ? '✅ held     '
            : r.safetyOutcome === 'invariant_violated'
              ? '❌ violated '
              : '⚠️  n/a      ';
        console.log(`  ${r.scenario.padEnd(32)} ${r.mode.padEnd(12)} ${icon}`);
      }
      console.log('══════════════════════════════════════════════════════════════\n');
      await adapter.close();
      process.exit(failed ? 1 : 0);
      break;
    }

    case 'compare': {
      const files = readdirSync(EVIDENCE_DIR).filter((f) => f.endsWith('.json'));
      const runs = files
        .map((f) => JSON.parse(readFileSync(join(EVIDENCE_DIR, f), 'utf8')) as RunResult)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

      const byScenario = new Map<string, { vulnerable?: RunResult; fixed?: RunResult }>();
      for (const r of runs) {
        const slot = byScenario.get(r.scenario) ?? {};
        if (r.mode === 'vulnerable' && !slot.vulnerable) slot.vulnerable = r;
        if (r.mode === 'fixed' && !slot.fixed) slot.fixed = r;
        byScenario.set(r.scenario, slot);
      }

      console.log('\nSide-by-side comparison (latest run per mode):\n');
      for (const [id, pair] of byScenario) {
        console.log(`  ${id}`);
        console.log(
          `    vulnerable: ${pair.vulnerable?.safetyOutcome ?? '—'} — ${pair.vulnerable?.verdict ?? 'no run'}`,
        );
        console.log(
          `    fixed     : ${pair.fixed?.safetyOutcome ?? '—'} — ${pair.fixed?.verdict ?? 'no run'}`,
        );
        console.log('');
      }
      break;
    }

    case 'report': {
      const runId = positional[0];
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

  npm run dp -- list
  npm run dp -- run --scenario <id> --mode <vulnerable|fixed>
  npm run dp -- verify
  npm run dp -- compare
  npm run dp -- report [runId]
`);
    }
  }
})();
