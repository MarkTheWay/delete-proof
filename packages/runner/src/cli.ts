#!/usr/bin/env tsx
/**
 * DeleteProof CLI
 *
 *   npm run dp -- list
 *   npm run dp -- run --scenario <id> --mode <vulnerable|fixed>
 *   npm run dp -- verify
 *   npm run dp -- compare
 *   npm run dp -- report [runId]
 *
 * Output uses Claude Code / git-diff style colors:
 *   green = held / fixed / blocked / absent
 *   red   = violated / vulnerable / delete / resurrection
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Mode, RunResult, ScenarioId, TraceEvent } from '@delete-proof/shared';
import { SampleAppAdapter } from './adapters/SampleAppAdapter.js';
import { loadEnv } from './env.js';
import { SCENARIOS, runScenario } from './scenarios/index.js';

loadEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = resolve(__dirname, '../../../evidence/runs');

// ─── Claude Code–style ANSI (git-diff red/green) ─────────────────────────────
const useColor =
  process.env.FORCE_COLOR !== '0' &&
  process.env.NO_COLOR == null &&
  (Boolean(process.stdout.isTTY) || process.env.FORCE_COLOR === '1');

const c = {
  reset: useColor ? '\x1b[0m' : '',
  bold: useColor ? '\x1b[1m' : '',
  dim: useColor ? '\x1b[2m' : '',
  red: useColor ? '\x1b[31m' : '',
  green: useColor ? '\x1b[32m' : '',
  yellow: useColor ? '\x1b[33m' : '',
  cyan: useColor ? '\x1b[36m' : '',
  // Claude Code–like soft tones
  redBright: useColor ? '\x1b[91m' : '',
  greenBright: useColor ? '\x1b[92m' : '',
};

function red(s: string): string {
  return `${c.red}${s}${c.reset}`;
}
function green(s: string): string {
  return `${c.green}${s}${c.reset}`;
}
function dim(s: string): string {
  return `${c.dim}${s}${c.reset}`;
}
function bold(s: string): string {
  return `${c.bold}${s}${c.reset}`;
}
function yellow(s: string): string {
  return `${c.yellow}${s}${c.reset}`;
}

function modeLabel(mode: Mode): string {
  return mode === 'vulnerable' ? red(bold('vulnerable')) : green(bold('fixed'));
}

function safetyLine(outcome: RunResult['safetyOutcome']): string {
  if (outcome === 'invariant_held') return green(bold('invariant_held'));
  if (outcome === 'invariant_violated') return red(bold('invariant_violated'));
  return yellow(String(outcome));
}

function verdictLine(result: RunResult): string {
  const v = result.verdict;
  if (result.safetyOutcome === 'invariant_violated') return red(bold(v));
  if (result.safetyOutcome === 'invariant_held') return green(bold(v));
  return yellow(v);
}

function diffLine(sign: '+' | '-' | ' ', text: string): string {
  if (sign === '+') return `${c.green}+ ${text}${c.reset}`;
  if (sign === '-') return `${c.red}- ${text}${c.reset}`;
  return `  ${text}`;
}

function colorKind(kind: string): string {
  if (kind.includes('blocked_by_tombstone') || kind.includes('skipped')) return green(kind);
  if (
    kind.includes('deletion') ||
    kind.includes('deleted') ||
    kind.includes('write_committed') ||
    kind.includes('write_attempted') ||
    kind.includes('violat')
  ) {
    return red(kind);
  }
  if (kind.includes('barrier')) return yellow(kind);
  if (kind.includes('created') || kind.includes('queued')) return green(kind);
  return dim(kind);
}

function colorMessage(kind: string, message: string): string {
  if (kind.includes('blocked_by_tombstone')) return green(message);
  if (message.includes('[VULNERABLE]') || message.includes('resurrect')) return red(message);
  if (message.includes('[FIXED]') && message.includes('tombstone')) return green(message);
  if (message.includes('[FIXED]')) return dim(message);
  if (kind.includes('deletion') || kind.includes('deleted')) return red(message);
  return message;
}

function saveRun(result: RunResult): string {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const file = join(EVIDENCE_DIR, `${result.runId}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  return file;
}

function printRun(result: RunResult): void {
  const held = result.safetyOutcome === 'invariant_held';
  const violated = result.safetyOutcome === 'invariant_violated';
  const failed = result.executionStatus === 'failed';

  const headerIcon = held ? green('●') : violated ? red('●') : failed ? yellow('●') : dim('○');
  const banner =
    held
      ? green('────────────────────────────────────────')
      : violated
        ? red('────────────────────────────────────────')
        : dim('────────────────────────────────────────');

  console.log(`\n${banner}`);
  console.log(`${headerIcon}  ${bold(result.scenario)}  [${modeLabel(result.mode)}]`);
  console.log(banner);

  console.log(`   ${dim('Run ID         :')} ${result.runId}`);
  console.log(`   ${dim('Execution      :')} ${result.executionStatus}`);
  console.log(`   ${dim('Safety outcome :')} ${safetyLine(result.safetyOutcome)}`);
  console.log(`   ${dim('Verdict        :')} ${verdictLine(result)}`);
  console.log(`   ${dim('Duration       :')} ${result.durationMs}ms`);
  if (result.codeRevision) {
    console.log(
      `   ${dim('Revision       :')} ${result.codeRevision}${result.dirtyWorktree ? ' (dirty)' : ''}`,
    );
  }
  if (result.errors.length > 0) {
    console.log(`   ${red('Errors         :')} ${red(result.errors.join('; '))}`);
  }

  console.log(`\n   ${bold('Trace')} ${dim('(git-diff style: − delete/resurrect  + safe/blocked)')}`);
  for (const [i, e] of result.trace.entries()) {
    printTraceEvent(i + 1, e);
  }

  console.log('');
  if (result.finalCustomerState) {
    console.log(
      diffLine(
        '-',
        `${bold('Final customer state:')} present ${dim('(resurrected / still there)')}`,
      ),
    );
    console.log(
      `${c.red}    ${JSON.stringify(result.finalCustomerState)}${c.reset}`,
    );
  } else {
    console.log(
      diffLine('+', `${bold('Final customer state:')} ${green('absent (null)')}`),
    );
  }
}

function printTraceEvent(n: number, e: TraceEvent): void {
  const kind = e.kind;
  let sign: '+' | '-' | ' ' = ' ';
  if (kind.includes('blocked_by_tombstone') || kind.includes('skipped')) sign = '+';
  else if (
    kind.includes('worker_write_committed') ||
    (kind.includes('worker_write_attempted') && (e.message ?? '').includes('VULNERABLE'))
  )
    sign = '-';
  else if (kind.includes('deletion') || kind.includes('deleted')) sign = '-';
  else if (kind.includes('customer_created')) sign = '+';

  const idx = dim(`[${String(n).padStart(3)}]`);
  const ts = dim(e.ts.slice(11, 23));
  const kindCol = colorKind(kind.padEnd(32));
  const msg = colorMessage(kind, e.message);

  if (sign === '+') {
    console.log(`     ${c.green}+${c.reset} ${idx} ${ts}  ${kindCol} ${msg}`);
  } else if (sign === '-') {
    console.log(`     ${c.red}-${c.reset} ${idx} ${ts}  ${kindCol} ${msg}`);
  } else {
    console.log(`       ${idx} ${ts}  ${kindCol} ${msg}`);
  }
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
  // Help Windows terminals show ANSI when supported
  if (process.platform === 'win32' && useColor) {
    try {
      // Enable VT processing hint for older Windows consoles
      process.env.FORCE_COLOR ??= '1';
    } catch {
      /* ignore */
    }
  }

  const { command, scenario, mode, positional } = parseArgs(process.argv.slice(2));

  switch (command) {
    case 'list': {
      console.log(`\n${bold('Available DeleteProof scenarios')}\n`);
      for (const s of SCENARIOS) {
        console.log(`  ${cyanId(s.id)}`);
        console.log(`    ${s.title}`);
        console.log(`    ${dim(s.description)}`);
        console.log(`    Modes: ${s.supportedModes.map((m) => (m === 'fixed' ? green(m) : red(m))).join(', ')}\n`);
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

      console.log(
        `\n${dim('Running')} ${bold(scenarioId)} ${dim('in')} ${modeLabel(runMode)} ${dim('mode…')}`,
      );
      const adapter = new SampleAppAdapter();
      const health = await adapter.health();
      if (!health.ok) {
        console.error(red('Services not ready:'), health);
        process.exit(1);
      }
      const result = await runScenario(scenarioId, runMode, adapter);
      printRun(result);
      const file = saveRun(result);
      console.log(`\n${dim('Evidence saved →')} ${file}`);
      await adapter.close();
      process.exit(result.executionStatus === 'failed' ? 1 : 0);
      break;
    }

    case 'verify': {
      const adapter = new SampleAppAdapter();
      const health = await adapter.health();
      if (!health.ok) {
        console.error(red('Services not ready — start docker, migrate, api, and worker first.'));
        console.error(health);
        process.exit(1);
      }

      const results: RunResult[] = [];
      let failed = false;
      for (const s of SCENARIOS) {
        for (const m of s.supportedModes) {
          console.log(`\n${dim('▶ verify')} ${s.id} [${modeLabel(m)}]`);
          let result: RunResult;
          try {
            result = await runScenario(s.id, m, adapter);
          } catch (err) {
            failed = true;
            console.error(red(`   ✗ threw: ${err}`));
            continue;
          }
          printRun(result);
          saveRun(result);
          results.push(result);
          const expected = expectedSafety(s.id, m);
          if (result.executionStatus !== 'completed' || result.safetyOutcome !== expected) {
            failed = true;
            console.error(red(`   ✗ expected safetyOutcome=${expected}`));
          }
        }
      }

      console.log(`\n${bold('══════════════════════════════════════════════════════════════')}`);
      console.log(`  ${bold('VERIFICATION MATRIX')}`);
      console.log(`${bold('══════════════════════════════════════════════════════════════')}`);
      for (const r of results) {
        const outcome =
          r.safetyOutcome === 'invariant_held'
            ? green('✓ held    ')
            : r.safetyOutcome === 'invariant_violated'
              ? red('✗ violated')
              : yellow('? n/a     ');
        const modeCol = r.mode === 'fixed' ? green(r.mode.padEnd(12)) : red(r.mode.padEnd(12));
        console.log(`  ${r.scenario.padEnd(32)} ${modeCol} ${outcome}`);
      }
      console.log(`${bold('══════════════════════════════════════════════════════════════')}\n`);
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

      console.log(`\n${bold('Side-by-side comparison')} ${dim('(latest run per mode)')}\n`);
      for (const [id, pair] of byScenario) {
        console.log(`  ${bold(id)}`);
        console.log(
          diffLine(
            '-',
            `vulnerable: ${pair.vulnerable?.safetyOutcome ?? '—'} — ${pair.vulnerable?.verdict ?? 'no run'}`,
          ),
        );
        console.log(
          diffLine(
            '+',
            `fixed     : ${pair.fixed?.safetyOutcome ?? '—'} — ${pair.fixed?.verdict ?? 'no run'}`,
          ),
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
          console.log(`\n${dim('Saved runs in')} ${EVIDENCE_DIR}:\n`);
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
${bold('DeleteProof CLI')}

  npm run dp -- list
  npm run dp -- run --scenario <id> --mode <vulnerable|fixed>
  npm run dp -- verify
  npm run dp -- compare
  npm run dp -- report [runId]

${dim('Tip: run inside Windows Terminal / VS Code for full red/green colors.')}
`);
    }
  }
})();

function cyanId(s: string): string {
  return `${c.cyan}${s}${c.reset}`;
}
