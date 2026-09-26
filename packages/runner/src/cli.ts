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
 * Selected-diff coloring (Claude Code style):
 *   green background = held / blocked / absent
 *   red background   = violated / delete / resurrection
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
const VERSION = '0.1.0';

// ─── ANSI ────────────────────────────────────────────────────────────────────
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
  white: useColor ? '\x1b[37m' : '',
  // brand accent (cool cyan — not purple)
  brand: useColor ? '\x1b[38;2;94;210;220m' : '',
  brandDim: useColor ? '\x1b[38;2;60;130;140m' : '',
  // Claude Code selected diffs
  addBg: useColor ? '\x1b[48;2;12;42;18m' : '',
  addFg: useColor ? '\x1b[38;2;120;220;140m' : '',
  delBg: useColor ? '\x1b[48;2;52;14;14m' : '',
  delFg: useColor ? '\x1b[38;2;248;130;130m' : '',
};

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function termWidth(): number {
  return Math.max(48, Math.min(100, process.stdout.columns ?? 80));
}

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
function brand(s: string): string {
  return `${c.brand}${s}${c.reset}`;
}

/** Full-width selected line — background fills like Claude Code diffs */
function selectedLine(sign: '+' | '-', body: string): string {
  const prefix = sign === '+' ? '+ ' : '- ';
  const plain = prefix + stripAnsi(body);
  const width = termWidth();
  const padded =
    plain.length >= width ? plain.slice(0, width) : plain + ' '.repeat(width - plain.length);
  if (!useColor) return padded;
  const style = sign === '+' ? `${c.addBg}${c.addFg}` : `${c.delBg}${c.delFg}`;
  return `${style}${padded}${c.reset}`;
}

function rule(ch = '─', color?: (s: string) => string): string {
  const line = ch.repeat(termWidth());
  return color ? color(line) : dim(line);
}

function kv(label: string, value: string): void {
  console.log(`  ${dim(label.padEnd(16))} ${value}`);
}

function badge(kind: 'ok' | 'bad' | 'warn' | 'info', text: string): string {
  if (kind === 'ok') return green(`● ${text}`);
  if (kind === 'bad') return red(`● ${text}`);
  if (kind === 'warn') return yellow(`● ${text}`);
  return dim(`○ ${text}`);
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

// ─── Logo ────────────────────────────────────────────────────────────────────
/**
 * Compact wordmark — fits ~64 cols. Wide terminals get the full block.
 */
const LOGO_FULL = [
  '  ____       _      _       ____                  __ ',
  ' |  _ \\  ___| | ___| |_ ___|  _ \\ _ __ ___   ___ / _|',
  ' | | | |/ _ \\ |/ _ \\ __/ _ \\ |_) | \'__/ _ \\ / _ \\ |_ ',
  ' | |_| |  __/ |  __/ ||  __/  __/| | | (_) | (_) |  _|',
  ' |____/ \\___|_|\\___|\\__\\___|_|   |_|  \\___/ \\___/|_| ',
];

const LOGO_COMPACT = [
  '  ┌─────────────────────────────────┐',
  '  │  D E L E T E · P R O O F         │',
  '  │  reproduce → repair → verify     │',
  '  └─────────────────────────────────┘',
];

function printLogo(opts?: { compact?: boolean }): void {
  const wide = termWidth() >= 64 && !opts?.compact;
  const lines = wide ? LOGO_FULL : LOGO_COMPACT;
  console.log('');
  for (const line of lines) {
    console.log(brand(line));
  }
  console.log(
    `  ${dim('ghost-write verifier')}  ${c.brandDim}v${VERSION}${c.reset}  ${dim('·')}  ${dim('IBM Bob hackathon')}`,
  );
  console.log(rule('─', brand));
}

function printSection(title: string, tone: 'ok' | 'bad' | 'neutral' = 'neutral'): void {
  const color = tone === 'ok' ? green : tone === 'bad' ? red : (s: string) => dim(s);
  console.log('');
  console.log(color(rule('─')));
  console.log(`  ${bold(title)}`);
  console.log(color(rule('─')));
}

// ─── Run output ──────────────────────────────────────────────────────────────
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
  const tone: 'ok' | 'bad' | 'neutral' = held ? 'ok' : violated || failed ? 'bad' : 'neutral';

  const status = held
    ? badge('ok', 'INVARIANT HELD')
    : violated
      ? badge('bad', 'INVARIANT VIOLATED')
      : failed
        ? badge('warn', 'EXECUTION FAILED')
        : badge('info', 'NOT EVALUATED');

  printSection(`${result.scenario}  ·  ${result.mode}`, tone);
  console.log(`  ${status}`);
  console.log('');
  kv('Run ID', result.runId);
  kv('Execution', result.executionStatus);
  kv('Safety', safetyLine(result.safetyOutcome));
  kv('Verdict', verdictLine(result));
  kv('Duration', `${result.durationMs} ms`);
  if (result.codeRevision) {
    kv('Revision', `${result.codeRevision}${result.dirtyWorktree ? dim(' (dirty)') : ''}`);
  }
  if (result.errors.length > 0) {
    kv('Errors', red(result.errors.join('; ')));
  }

  console.log('');
  console.log(`  ${bold('TRACE')}  ${dim('+ held / blocked     − delete / resurrect')}`);
  console.log(dim('  ' + '─'.repeat(Math.min(termWidth() - 2, 56))));

  for (const [i, e] of result.trace.entries()) {
    printTraceEvent(i + 1, e);
  }

  console.log('');
  console.log(`  ${bold('RESULT')}`);
  if (result.finalCustomerState) {
    console.log(selectedLine('-', 'Final customer state: present (resurrected)'));
    console.log(selectedLine('-', JSON.stringify(result.finalCustomerState)));
  } else {
    console.log(selectedLine('+', 'Final customer state: absent (null)'));
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

  const idx = String(n).padStart(3);
  const ts = e.ts.slice(11, 23);
  const body = `[${idx}] ${ts}  ${kind.padEnd(30)} ${e.message}`;

  if (sign === '+' || sign === '-') {
    console.log(selectedLine(sign, body));
  } else {
    console.log(`  ${dim(`[${idx}]`)} ${dim(ts)}  ${dim(kind.padEnd(30))} ${e.message}`);
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

function printHelp(): void {
  printLogo();
  console.log(`
  ${bold('USAGE')}
    npm run dp -- <command> [options]

  ${bold('COMMANDS')}
    ${brand('list')}                              List scenarios
    ${brand('run')}    --scenario <id> --mode <m> Run one scenario
    ${brand('verify')}                            Full 10-cell matrix
    ${brand('compare')}                           Latest vulnerable vs fixed
    ${brand('report')} [runId]                    Replay saved evidence

  ${bold('MODES')}
    ${red('vulnerable')}   Naive upsert — demonstrates resurrection
    ${green('fixed')}        Tombstone + advisory lock — holds invariant

  ${bold('DEMO')}
    npm run dp -- run --scenario delayed-update-after-delete --mode vulnerable
    npm run dp -- run --scenario delayed-update-after-delete --mode fixed

  ${dim('Tip: Windows Terminal or VS Code for full selected-line colors.')}
`);
}

// ─── Main ────────────────────────────────────────────────────────────────────
void (async () => {
  if (process.platform === 'win32' && useColor) {
    process.env.FORCE_COLOR ??= '1';
  }

  const { command, scenario, mode, positional } = parseArgs(process.argv.slice(2));

  switch (command) {
    case 'list': {
      printLogo();
      console.log(`\n  ${bold('SCENARIOS')}\n`);
      for (const s of SCENARIOS) {
        console.log(`  ${brand('▸')} ${bold(s.id)}`);
        console.log(`    ${s.title}`);
        console.log(`    ${dim(s.description)}`);
        console.log(
          `    ${dim('modes')}  ${s.supportedModes
            .map((m) => (m === 'fixed' ? green(m) : red(m)))
            .join(dim(' · '))}\n`,
        );
      }
      break;
    }

    case 'run': {
      const scenarioId = (scenario ?? positional[0]) as ScenarioId | undefined;
      const runMode = (mode ?? positional[1]) as Mode | undefined;
      if (!scenarioId || !runMode) {
        console.error(red('Usage: dp run --scenario <id> --mode <vulnerable|fixed>'));
        process.exit(1);
      }
      if (!SCENARIOS.some((s) => s.id === scenarioId)) {
        console.error(red(`Unknown scenario: ${scenarioId}`));
        process.exit(1);
      }
      if (runMode !== 'vulnerable' && runMode !== 'fixed') {
        console.error(red(`Invalid mode: ${runMode}`));
        process.exit(1);
      }

      printLogo({ compact: true });
      console.log(
        `\n  ${dim('running')}  ${bold(scenarioId)}  ${dim('·')}  ${modeLabel(runMode)}\n`,
      );

      const adapter = new SampleAppAdapter();
      const health = await adapter.health();
      if (!health.ok) {
        console.error(red('  Services not ready. Start docker, migrate, api, and worker first.'));
        console.error(`  ${dim(JSON.stringify(health))}`);
        process.exit(1);
      }

      const result = await runScenario(scenarioId, runMode, adapter);
      printRun(result);
      const file = saveRun(result);
      console.log('');
      console.log(rule('─'));
      console.log(`  ${dim('evidence')}  ${file}`);
      console.log('');
      await adapter.close();
      process.exit(result.executionStatus === 'failed' ? 1 : 0);
      break;
    }

    case 'verify': {
      printLogo({ compact: true });
      const adapter = new SampleAppAdapter();
      const health = await adapter.health();
      if (!health.ok) {
        console.error(red('  Services not ready — start docker, migrate, api, and worker first.'));
        console.error(`  ${dim(JSON.stringify(health))}`);
        process.exit(1);
      }

      const results: RunResult[] = [];
      let failed = false;
      for (const s of SCENARIOS) {
        for (const m of s.supportedModes) {
          console.log(`\n  ${dim('▶')} ${s.id}  [${modeLabel(m)}]`);
          let result: RunResult;
          try {
            result = await runScenario(s.id, m, adapter);
          } catch (err) {
            failed = true;
            console.error(red(`     threw: ${err}`));
            continue;
          }
          printRun(result);
          saveRun(result);
          results.push(result);
          const expected = expectedSafety(s.id, m);
          if (result.executionStatus !== 'completed' || result.safetyOutcome !== expected) {
            failed = true;
            console.error(red(`     expected safetyOutcome=${expected}`));
          }
        }
      }

      printSection('VERIFICATION MATRIX', failed ? 'bad' : 'ok');
      console.log(
        `  ${dim('scenario'.padEnd(32))} ${dim('mode'.padEnd(12))} ${dim('outcome')}`,
      );
      console.log(dim('  ' + '─'.repeat(Math.min(termWidth() - 2, 56))));
      for (const r of results) {
        const outcome =
          r.safetyOutcome === 'invariant_held'
            ? green('held')
            : r.safetyOutcome === 'invariant_violated'
              ? red('violated')
              : yellow('n/a');
        const modeCol = r.mode === 'fixed' ? green(r.mode.padEnd(12)) : red(r.mode.padEnd(12));
        console.log(`  ${r.scenario.padEnd(32)} ${modeCol} ${outcome}`);
      }
      console.log('');
      console.log(
        failed
          ? `  ${badge('bad', 'VERIFY FAILED')}`
          : `  ${badge('ok', 'VERIFY PASSED — 10/10 cells matched')}`,
      );
      console.log('');
      await adapter.close();
      process.exit(failed ? 1 : 0);
      break;
    }

    case 'compare': {
      printLogo({ compact: true });
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

      printSection('COMPARE  ·  latest per mode');
      for (const [id, pair] of byScenario) {
        console.log(`\n  ${bold(id)}`);
        console.log(
          selectedLine(
            '-',
            `vulnerable  ${pair.vulnerable?.safetyOutcome ?? '—'}  ·  ${pair.vulnerable?.verdict ?? 'no run'}`,
          ),
        );
        console.log(
          selectedLine(
            '+',
            `fixed       ${pair.fixed?.safetyOutcome ?? '—'}  ·  ${pair.fixed?.verdict ?? 'no run'}`,
          ),
        );
      }
      console.log('');
      break;
    }

    case 'report': {
      const runId = positional[0];
      if (!runId) {
        printLogo({ compact: true });
        try {
          const files = readdirSync(EVIDENCE_DIR).filter((f) => f.endsWith('.json'));
          console.log(`\n  ${bold('SAVED RUNS')}  ${dim(EVIDENCE_DIR)}\n`);
          for (const f of files) console.log(`  ${brand('▸')} ${f}`);
          console.log('');
        } catch {
          console.log(yellow('\n  No evidence runs found. Run a scenario first.\n'));
        }
        break;
      }
      printLogo({ compact: true });
      const file = join(EVIDENCE_DIR, `${runId}.json`);
      const result = JSON.parse(readFileSync(file, 'utf8')) as RunResult;
      printRun(result);
      console.log('');
      break;
    }

    default: {
      printHelp();
    }
  }
})();
