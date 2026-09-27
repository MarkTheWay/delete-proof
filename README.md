# DeleteProof

**IBM Bob 2.0 Hackathon** · Theme: *Turn idea into impact faster*

Reproduce and repair a distributed-systems ghost-write bug: a deleted customer
is recreated by a stale asynchronous event. DeleteProof proves the failure,
explains its cause, and demonstrates a transactional repair.

```
REPRODUCE → EXPLAIN → REPAIR → VERIFY
```

| | |
|---|---|
| Demo video | _add link_ |
| Bob session reports | [`bob_sessions/`](bob_sessions/) |
| Bob integration | [`.bob/mcp.json`](.bob/mcp.json) → `packages/mcp` |

---

## The Problem

In event-driven systems, a message queued before a customer deletion can be
processed after it. A naive upsert in the worker recreates the deleted customer
row — violating the invariant:

> **After deletion commits, asynchronous processing must not recreate
> that customer.**

This is a GDPR right-to-erasure failure that unit tests almost never catch: it
only appears under one specific interleaving of an API transaction and a queue
worker, so it ships to production and surfaces as "deleted users coming back".

## The Solution

DeleteProof forces that interleaving deterministically (Redis barriers, no
sleeps), records evidence from the real database, and verifies a repair:

1. **Reproduce** — run the race against real PostgreSQL 17 + Redis 7 and watch the deleted row reappear.
2. **Explain** — a merged trace shows exactly which transaction wrote after the delete committed.
3. **Repair** — `customer_tombstones` + `pg_advisory_xact_lock(customer_lock_key(id))`.
4. **Verify** — five scenarios × two modes; the fix must block stale writes *and* keep legitimate updates working.

## Theme fit: turn idea into impact faster

Concurrency bugs normally take days to reproduce and are "fixed" on intuition.
DeleteProof turns that into a single command with a pass/fail verdict, and
exposes the same scenarios to IBM Bob over MCP so Bob can reproduce, inspect
traces, and confirm a repair from inside the IDE instead of the developer
hand-building a race harness.

## How IBM Bob is used

**In the product.** `.bob/mcp.json` registers `packages/mcp` as a stdio MCP
server in Bob IDE. Bob gets these tools: `list_scenarios`, `run_scenario`,
`get_run_trace`, `compare_runs`, `list_runs`, `export_report`.

**In development.** Bob built the first end-to-end version of DeleteProof from
our project brief in one task (162 commands, 44 file writes, 12 diffs):

- npm-workspaces monorepo, pinned dependencies, `docker-compose.yml`, `.env.example`
- sample app: schema with `customer_tombstones` and `customer_lock_key`, Fastify API,
  BullMQ worker, Redis barriers + trace stream, the vulnerable fixture
- the repair: `READ COMMITTED` + `pg_advisory_xact_lock` + tombstone check
- runner: `TargetAdapter`, evidence model, all five scenarios, `dp` CLI, Vitest suite
- runner HTTP API, React/Vite dashboard, the stdio MCP adapter registered in `.bob/mcp.json`
- README, demo script, submission draft

Bob could not run the scenarios against live services because Docker was not
installed on that machine, and the task stopped when the trial Bobcoins ran
out. The team then ran everything against real PostgreSQL and Redis, made the
concurrency scenarios deterministic, tightened assertions, and polished the CLI.
Full transcript: [`bob_sessions/`](bob_sessions/).

## Architecture

```
CLI / Dashboard / MCP
        │
        ▼
packages/runner  (HTTP + Redis barriers/traces + read-only Postgres)
        │
        ├── HTTP ──► packages/sample-app (Fastify API)
        ├── Redis ──► barriers (LPUSH/BLPOP) + trace stream (XADD)
        └── PG RO ──► assertions / pg_stat_activity lock waits
                │
                ▼
        BullMQ worker (vulnerable | fixed)
                │
                ▼
        PostgreSQL 17  (customers, customer_tombstones, customer_lock_key)
```

**Packages**
- `packages/sample-app` — Fastify API + BullMQ worker; Redis barriers/trace only when `DELETEPROOF_TEST_HOOKS=1`
- `packages/runner` — scenarios, CLI (`dp`), HTTP API, Vitest (never imports sample-app internals)
- `packages/dashboard` — React/Vite evidence UI (real runner API only)
- `packages/mcp` — thin stdio MCP for IBM Bob (`.bob/mcp.json`)
- `packages/shared` — shared types / `TargetAdapter`

## Prerequisites

- Node.js ≥ 20
- **Either** Docker Desktop (PostgreSQL 17 + Redis 7) **or** the embedded path below

## Quick Start

```bash
# 1. Environment
cp .env.example .env

# 2. Infrastructure — pick ONE
docker compose up -d          # preferred when Docker works
# OR (no Docker):
npm run services:up           # embedded-postgres + redis-memory-server → .dp-data/

# 3. Install (if not already)
npm install

# 4. Schema
npm run migrate

# 5. Sample app (exactly one API + one worker — duplicates break barriers)
npm run start:api
npm run start:worker

# 6. Verify all scenarios (both modes)
npm run dp -- verify

# 7. Single scenario / compare / report
npm run dp -- run --scenario delayed-update-after-delete --mode vulnerable
npm run dp -- compare
npm run dp -- report

# 8. Runner API + dashboard
npm run start:runner
npm run start:dashboard
# → http://localhost:5173
```

Stop embedded services with `npm run services:down` (Docker: `docker compose down`).

## The Repair

### Invariant
Once deletion commits, no async processing may recreate that customer.

### Fixed path

**Deletion**
```sql
BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL application_name = 'dp:{runId}:api';
SELECT pg_advisory_xact_lock(customer_lock_key(id));
INSERT INTO customer_tombstones … ON CONFLICT DO NOTHING;
DELETE FROM customers WHERE id = …;
-- barrier api.before_commit (Redis BLPOP) when test hooks enabled
COMMIT;
```

**Worker**
```sql
BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL application_name = 'dp:{runId}:worker';
SELECT pg_advisory_xact_lock(customer_lock_key(id));
SELECT … FROM customer_tombstones WHERE customer_id = …;
-- if found: COMMIT (no write) → blocked_by_tombstone
-- else: barrier worker.before_write → upsert → COMMIT
```

Vulnerable mode is the demo fixture: plain `DELETE` and `INSERT … ON CONFLICT DO UPDATE` with no tombstone check.

### Barriers (correctness)

Redis only — **no sleep-based barriers for correctness**:

1. Participant: `LPUSH dp:{runId}:ack:{point}` then `BLPOP dp:{runId}:release:{point}`
2. Runner: waits for ack, observes lock waits via `pg_stat_activity.wait_event_type = 'Lock'`, then releases
3. On timeout: transaction `ROLLBACK` + `barrier_timeout` trace event

Trace events: `XADD dp:{runId}:trace`

## Scenarios

| ID | Vulnerable | Fixed |
|---|---|---|
| `delayed-update-after-delete` | ❌ resurrects | ✅ absent |
| `duplicate-stale-delivery` | ❌ resurrects | ✅ absent |
| `concurrent-delete-update` | ❌ resurrects | ✅ absent (both orderings) |
| `active-customer-update` | ✅ updates | ✅ updates |
| `unrelated-customer-update` | ✅ unaffected | ✅ unaffected |

Vulnerable resurrection verdict (exact):

> Resurrection reproduced — deletion invariant failed.

Evidence separates `executionStatus` from `safetyOutcome`
(`invariant_held` | `invariant_violated` | `not_evaluated`).

## CLI

```bash
npm run dp -- list
npm run dp -- run --scenario <id> --mode <vulnerable|fixed>
npm run dp -- verify
npm run dp -- compare
npm run dp -- report [runId]
```

## Verification status

**Verified** against **Docker Compose** (`postgres:17-alpine` + `redis:7-alpine`, 2026-09-26)
and the embedded `npm run services:up` path (2026-09-27), each with a live
sample-app API + BullMQ worker:

| Check | Result |
|---|---|
| `npm run typecheck` | clean (shared, sample-app, runner, mcp) |
| `npm run build` | dashboard builds |
| `npm run dp -- verify` | exit 0 — full 10-cell matrix matched expected outcomes |
| `npm test` | Vitest 6/6 passed |
| `npm run e2e` | Playwright scenario 1 (vulnerable + fixed) passed (2026-09-26) |

Vulnerable resurrection verdict observed exactly:

> Resurrection reproduced — deletion invariant failed.

Fallback without Docker: `npm run services:up` (embedded-postgres + redis-memory-server → `.dp-data/`).

## Limitations

- One sample application (PostgreSQL + Redis/BullMQ).
- Synthetic customer data only — no real PII.
- Tombstones are outside any complete data-erasure guarantee.
- No authentication, multi-tenancy, or production hardening.

## Bob session reports

Exported IBM Bob IDE task histories and their consumption-summary screenshots
are in [`bob_sessions/`](bob_sessions/), as required for judging.

## License

MIT — see [LICENSE](LICENSE).
