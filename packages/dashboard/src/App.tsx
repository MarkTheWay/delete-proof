import React, { useEffect, useState, useCallback } from 'react';

// ─── Types (inline to avoid shared package dep in dashboard) ─────────────────
interface TraceEvent {
  id?: string;
  ts: string;
  kind: string;
  message: string;
  data?: Record<string, unknown>;
}

interface RunResult {
  runId: string;
  scenario: string;
  mode: 'vulnerable' | 'fixed';
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  executionStatus: 'running' | 'completed' | 'failed';
  safetyOutcome?: 'invariant_held' | 'invariant_violated' | 'not_evaluated';
  invariantStatus?: 'held' | 'violated' | 'not_applicable' | 'pending';
  verdict: string;
  trace: TraceEvent[];
  finalCustomerState: unknown | null;
  customerStateKind?: 'present' | 'absent' | 'unknown';
  errors: string[];
  codeRevision?: string;
  dirtyWorktree?: boolean;
}

function safetyLabel(run: RunResult): string {
  if (run.safetyOutcome === 'invariant_held') return 'held';
  if (run.safetyOutcome === 'invariant_violated') return 'violated';
  if (run.safetyOutcome === 'not_evaluated') return 'not_evaluated';
  return run.invariantStatus ?? 'not_evaluated';
}

function resolveCustomerKind(run: RunResult): 'present' | 'absent' | 'unknown' {
  if (run.customerStateKind) return run.customerStateKind;
  if (run.executionStatus === 'failed' || run.safetyOutcome === 'not_evaluated') {
    return 'unknown';
  }
  return run.finalCustomerState ? 'present' : 'absent';
}

interface ScenarioMeta {
  id: string;
  title: string;
  description: string;
  supportedModes: string[];
}

interface Readiness {
  postgres: string;
  redis: string;
  api?: string;
  worker?: string;
  testHooks?: string;
  status: string;
}

const API = '/api';

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, init);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

// ─── Hooks ───────────────────────────────────────────────────────────────────
function useReadiness() {
  const [ready, setReady] = useState<Readiness | null>(null);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    try {
      const r = await apiFetch<Readiness>('/readiness');
      setReady(r);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    check();
    const id = setInterval(check, 5000);
    return () => clearInterval(id);
  }, [check]);

  return { ready, error, refetch: check };
}

function useRuns() {
  const [runs, setRuns] = useState<RunResult[]>([]);
  const [loading, setLoading] = useState(false);

  const fetch_ = useCallback(async () => {
    setLoading(true);
    try {
      setRuns(await apiFetch<RunResult[]>('/runs'));
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetch_(); }, [fetch_]);
  return { runs, loading, refetch: fetch_ };
}

// ─── Components ──────────────────────────────────────────────────────────────

function ServiceBadge({ name, status }: { name: string; status: string }) {
  const ok = status === 'ok';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '4px 10px', borderRadius: 20,
      border: `1px solid ${ok ? 'var(--green)' : 'var(--red)'}`,
      color: ok ? 'var(--green)' : 'var(--red)', fontSize: 12, marginRight: 8,
    }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: ok ? 'var(--green)' : 'var(--red)', display: 'inline-block' }} />
      {name}: {status}
    </span>
  );
}

function InvariantBadge({ status }: { status: string }) {
  const color = status === 'held' ? 'var(--green)'
    : status === 'violated' ? 'var(--red)'
    : 'var(--yellow)';
  const label = status === 'held' ? '✅ Invariant held'
    : status === 'violated' ? '❌ Invariant violated'
    : '⚠️ ' + status;
  return (
    <span style={{ color, fontWeight: 600, fontSize: 13 }}>{label}</span>
  );
}

function Timeline({ trace }: { trace: TraceEvent[] }) {
  if (!trace.length) return <p style={{ color: 'var(--muted)' }}>No trace events.</p>;
  return (
    <ol style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {trace.map((e, i) => (
        <li key={e.id ?? `${e.ts}-${e.kind}-${i}`} style={{
          display: 'flex', gap: 12, padding: '5px 0',
          borderBottom: '1px solid var(--border)', fontSize: 12,
        }}>
          <span style={{ color: 'var(--muted)', minWidth: 28, textAlign: 'right' }}>{i + 1}</span>
          <span style={{ color: 'var(--muted)', minWidth: 80 }}>{e.ts.slice(11, 23)}</span>
          <span style={{
            minWidth: 220, color: kindColor(e.kind),
            fontFamily: 'monospace', fontSize: 11,
          }}>{e.kind}</span>
          <span style={{ color: 'var(--text)' }}>{e.message}</span>
        </li>
      ))}
    </ol>
  );
}

function kindColor(kind: string): string {
  if (kind.includes('deleted') || kind.includes('tombstone') || kind.includes('blocked')) return 'var(--red)';
  if (kind.includes('created') || kind.includes('committed') || kind.includes('skipped')) return 'var(--green)';
  if (kind.includes('barrier')) return 'var(--yellow)';
  if (kind.includes('queued') || kind.includes('processing') || kind.includes('write')) return 'var(--purple)';
  return 'var(--muted)';
}

function CustomerState({
  state,
  kind,
  label,
}: {
  state: unknown;
  kind: 'present' | 'absent' | 'unknown';
  label: string;
}) {
  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>{label}</div>
      {kind === 'unknown' ? (
        <div style={{
          padding: '10px 14px', borderRadius: 6,
          background: '#1a1a0f', border: '1px solid var(--yellow)',
          color: 'var(--yellow)', fontWeight: 600,
        }}>unknown — not observed (execution failed or incomplete)</div>
      ) : kind === 'absent' ? (
        <div style={{
          padding: '10px 14px', borderRadius: 6,
          background: '#1a0f0f', border: '1px solid var(--red)',
          color: 'var(--red)', fontWeight: 600,
        }}>absent (null) — observed deleted</div>
      ) : (
        <pre style={{
          padding: '10px 14px', borderRadius: 6,
          background: '#0f1a0f', border: '1px solid var(--green)',
          color: 'var(--green)', fontSize: 11, overflowX: 'auto',
        }}>{JSON.stringify(state, null, 2)}</pre>
      )}
    </div>
  );
}

function RunCard({ run, onSelect, selected }: { run: RunResult; onSelect: () => void; selected: boolean }) {
  const isVulnerable = run.mode === 'vulnerable';
  return (
    <div
      onClick={onSelect}
      style={{
        padding: '12px 16px', borderRadius: 8, cursor: 'pointer',
        border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
        background: selected ? '#0d1f3a' : 'var(--surface)',
        marginBottom: 8,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{
          fontSize: 11, fontWeight: 700, letterSpacing: 0.5, padding: '2px 8px',
          borderRadius: 4, marginRight: 8,
          background: isVulnerable ? '#3a0f0f' : '#0f2a1a',
          color: isVulnerable ? 'var(--red)' : 'var(--green)',
          border: `1px solid ${isVulnerable ? 'var(--red)' : 'var(--green)'}`,
        }}>
          {run.mode.toUpperCase()}
        </span>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>{run.durationMs}ms</span>
      </div>
      <div style={{ fontSize: 12, marginTop: 4, color: 'var(--muted)' }}>{run.scenario}</div>
      <div style={{ fontSize: 12, marginTop: 4 }}><InvariantBadge status={safetyLabel(run)} /></div>
      <div style={{ fontSize: 11, marginTop: 4, color: 'var(--muted)', fontStyle: 'italic' }}>{run.verdict}</div>
    </div>
  );
}

function ComparisonPanel({ runs }: { runs: RunResult[] }) {
  const vuln = runs.find((r) => r.mode === 'vulnerable');
  const fixed = runs.find((r) => r.mode === 'fixed');
  if (!vuln && !fixed) return null;

  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 16, marginBottom: 16, color: 'var(--accent)' }}>Side-by-side Comparison</h2>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {[
          { run: vuln, label: '⚠️ VULNERABLE', bg: '#1a0f0f', border: 'var(--red)' },
          { run: fixed, label: '🛡 FIXED', bg: '#0f1a0f', border: 'var(--green)' },
        ].map(({ run, label, bg, border }) => (
          <div key={label} style={{ padding: 16, borderRadius: 8, background: bg, border: `1px solid ${border}` }}>
            <div style={{ fontWeight: 700, marginBottom: 8, fontSize: 13 }}>{label}</div>
            {run ? (
              <>
                <InvariantBadge status={safetyLabel(run)} />
                <p style={{ fontSize: 12, marginTop: 8, color: 'var(--muted)', fontStyle: 'italic' }}>{run.verdict}</p>
                <div style={{ marginTop: 12 }}>
                  <CustomerState
                    state={run.finalCustomerState}
                    kind={resolveCustomerKind(run)}
                    label="Final customer state"
                  />
                </div>
              </>
            ) : (
              <p style={{ color: 'var(--muted)', fontSize: 12 }}>No run recorded yet.</p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── Main App ────────────────────────────────────────────────────────────────
export default function App() {
  const { ready, error: readyError } = useReadiness();
  const { runs, loading: runsLoading, refetch: refetchRuns } = useRuns();
  const [scenarios, setScenarios] = useState<ScenarioMeta[]>([]);
      const [selectedScenario, setSelectedScenario] = useState('delayed-update-after-delete');
  const [selectedMode, setSelectedMode] = useState<'vulnerable' | 'fixed'>('vulnerable');
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<ScenarioMeta[]>('/scenarios').then(setScenarios).catch(() => undefined);
  }, []);

  const selectedRun = runs.find((r) => r.runId === selectedRunId) ?? null;

  // Auto-select latest run
  useEffect(() => {
    if (!selectedRunId && runs.length > 0) setSelectedRunId(runs[0].runId);
  }, [runs, selectedRunId]);

  async function handleRun() {
    setRunning(true);
    setRunError(null);
    try {
      const result = await apiFetch<RunResult>('/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: selectedScenario, mode: selectedMode }),
      });
      await refetchRuns();
      setSelectedRunId(result.runId);
    } catch (e) {
      setRunError(String(e));
    }
    setRunning(false);
  }

  const sameScenarioRuns = runs.filter((r) => r.scenario === (selectedRun?.scenario ?? selectedScenario));
  const beforeObserved = selectedRun
    ? selectedRun.trace.some((e) => e.kind === 'customer_created')
    : false;

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 20px' }}>
      {/* Header */}
      <header style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: -0.5 }}>
          🔐 DeleteProof
        </h1>
        <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 4 }}>
          IBM Bob Hackathon · Ghost-write bug demo · REPRODUCE → EXPLAIN → REPAIR → VERIFY
        </p>
      </header>

      {/* Service readiness */}
      <section style={{
        padding: '12px 16px', borderRadius: 8,
        background: 'var(--surface)', border: '1px solid var(--border)', marginBottom: 24,
      }}>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>INFRASTRUCTURE</div>
        {readyError ? (
          <span style={{ color: 'var(--red)', fontSize: 12 }}>⚠️ Runner API unreachable — start the server first</span>
        ) : ready ? (
          <>
            <ServiceBadge name="API" status={ready.api ?? 'unknown'} />
            <ServiceBadge name="PostgreSQL" status={ready.postgres} />
            <ServiceBadge name="Redis" status={ready.redis} />
            <ServiceBadge name="Worker" status={ready.worker ?? 'unknown'} />
            <ServiceBadge name="Test hooks" status={ready.testHooks ?? 'unknown'} />
          </>
        ) : (
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>Checking…</span>
        )}
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 24 }}>
        {/* Left panel — scenario selection + run history */}
        <div>
          {/* Run controls */}
          <section style={{
            padding: 16, borderRadius: 8,
            background: 'var(--surface)', border: '1px solid var(--border)', marginBottom: 16,
          }}>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>RUN SCENARIO</div>

            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 12, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Scenario</label>
              <select
                value={selectedScenario}
                onChange={(e) => setSelectedScenario(e.target.value)}
                style={{ width: '100%' }}
              >
                {scenarios.map((s) => (
                  <option key={s.id} value={s.id}>{s.title}</option>
                ))}
              </select>
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 12, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Mode</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {(['vulnerable', 'fixed'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setSelectedMode(m)}
                    style={{
                      flex: 1,
                      background: selectedMode === m ? (m === 'vulnerable' ? '#3a0f0f' : '#0f2a1a') : 'var(--surface)',
                      borderColor: selectedMode === m ? (m === 'vulnerable' ? 'var(--red)' : 'var(--green)') : 'var(--border)',
                      color: selectedMode === m ? (m === 'vulnerable' ? 'var(--red)' : 'var(--green)') : 'var(--muted)',
                      fontWeight: selectedMode === m ? 700 : 400,
                    }}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>

            {/* Central contrast callout */}
            <div style={{
              padding: '8px 12px', borderRadius: 6, marginBottom: 12, fontSize: 11, lineHeight: 1.8,
              background: selectedMode === 'vulnerable' ? '#2a0f0f' : '#0f2a15',
              border: `1px solid ${selectedMode === 'vulnerable' ? 'var(--red)' : 'var(--green)'}`,
            }}>
              {selectedMode === 'vulnerable' ? (
                <><span style={{ color: 'var(--red)' }}>⚠️ VULNERABLE</span><br />
                  Deleted → stale event processed → <strong style={{ color: 'var(--red)' }}>customer returns</strong></>
              ) : (
                <><span style={{ color: 'var(--green)' }}>🛡 FIXED</span><br />
                  Deleted → stale event blocked → <strong style={{ color: 'var(--green)' }}>customer stays absent</strong></>
              )}
            </div>

            <button
              onClick={handleRun}
              disabled={running || !ready || ready.status !== 'ready'}
              style={{
                width: '100%', padding: '8px 0', fontWeight: 600,
                background: running ? 'var(--surface)' : '#1f3a5f',
                borderColor: 'var(--accent)', color: 'var(--accent)',
              }}
            >
              {running ? '⏳ Running…' : '▶ Run Scenario'}
            </button>

            {runError && (
              <p style={{ color: 'var(--red)', fontSize: 11, marginTop: 8 }}>{runError}</p>
            )}
          </section>

          {/* Run history */}
          <section>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
              RUN HISTORY {runsLoading && '(loading…)'}
            </div>
            {runs.length === 0 && !runsLoading && (
              <p style={{ color: 'var(--muted)', fontSize: 12 }}>No runs yet. Run a scenario above.</p>
            )}
            {runs.map((r) => (
              <RunCard
                key={r.runId}
                run={r}
                selected={r.runId === selectedRunId}
                onSelect={() => setSelectedRunId(r.runId)}
              />
            ))}
          </section>
        </div>

        {/* Right panel — run details */}
        <div>
          {selectedRun ? (
            <>
              {/* Run header */}
              <div style={{
                padding: '14px 18px', borderRadius: 8,
                background: 'var(--surface)', border: '1px solid var(--border)', marginBottom: 16,
                display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
              }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{selectedRun.scenario}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                    Run {selectedRun.runId} · {selectedRun.startedAt.slice(0, 19).replace('T', ' ')}
                    {selectedRun.codeRevision && ` · rev ${selectedRun.codeRevision}${selectedRun.dirtyWorktree ? '*' : ''}`}
                  </div>
                  <div style={{ marginTop: 8 }}><InvariantBadge status={safetyLabel(selectedRun)} /></div>
                  <div style={{ fontSize: 12, marginTop: 4, color: 'var(--muted)', fontStyle: 'italic' }}>{selectedRun.verdict}</div>
                </div>
                <a
                  href={`/api/runs/${selectedRun.runId}/download`}
                  download
                  style={{ fontSize: 12, color: 'var(--accent)', textDecoration: 'none', border: '1px solid var(--border)', padding: '5px 10px', borderRadius: 6 }}
                >
                  ⬇ Download
                </a>
              </div>

              {/* Before/after state */}
              <div style={{
                display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16,
              }}>
                <div style={{ padding: 14, borderRadius: 8, background: 'var(--surface)', border: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>BEFORE DELETION</div>
                  {beforeObserved ? (
                    <div style={{ fontSize: 12, color: 'var(--green)' }}>Customer created (trace observed)</div>
                  ) : (
                    <div style={{ fontSize: 12, color: 'var(--yellow)' }}>Unknown — no customer_created in trace</div>
                  )}
                </div>
                <div style={{ padding: 14, borderRadius: 8, background: 'var(--surface)', border: '1px solid var(--border)' }}>
                  <CustomerState
                    state={selectedRun.finalCustomerState}
                    kind={resolveCustomerKind(selectedRun)}
                    label="AFTER SCENARIO"
                  />
                </div>
              </div>

              {/* Event timeline */}
              <section style={{
                padding: 16, borderRadius: 8,
                background: 'var(--surface)', border: '1px solid var(--border)', marginBottom: 16,
              }}>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
                  EVENT TIMELINE ({selectedRun.trace.length} events)
                </div>
                <div style={{ maxHeight: 320, overflowY: 'auto' }}>
                  <Timeline trace={selectedRun.trace} />
                </div>
              </section>

              {/* Errors */}
              {selectedRun.errors.length > 0 && (
                <section style={{
                  padding: 14, borderRadius: 8,
                  background: '#1a0f0f', border: '1px solid var(--red)', marginBottom: 16,
                }}>
                  <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 6 }}>EXECUTION ERRORS</div>
                  {selectedRun.errors.map((e, i) => (
                    <div key={i} style={{ fontSize: 12, color: 'var(--red)' }}>{e}</div>
                  ))}
                </section>
              )}

              {/* Side-by-side comparison */}
              <ComparisonPanel runs={sameScenarioRuns} />
            </>
          ) : (
            <div style={{
              padding: 40, borderRadius: 8, textAlign: 'center',
              background: 'var(--surface)', border: '1px solid var(--border)',
            }}>
              <p style={{ color: 'var(--muted)' }}>Select a run from the history or execute a new scenario.</p>
            </div>
          )}
        </div>
      </div>

      <footer style={{ marginTop: 48, paddingTop: 16, borderTop: '1px solid var(--border)', textAlign: 'center', color: 'var(--muted)', fontSize: 11 }}>
        DeleteProof · IBM Bob Hackathon 2024 · Evidence-backed distributed-systems bug demo
      </footer>
    </div>
  );
}
