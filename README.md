# DeleteProof

**IBM Bob Hackathon 2024**

Reproduce and repair a distributed-systems ghost-write bug: a deleted customer
is recreated by a stale asynchronous event. DeleteProof proves the failure,
explains its cause, and demonstrates a transactional repair.

```
REPRODUCE → EXPLAIN → REPAIR → VERIFY
```

---

## The Problem

In event-driven systems, a message queued before a customer deletion can be
processed after it. A naive upsert in the worker recreates the deleted customer
row — violating the invariant:

> **After deletion commits, asynchronous processing must not recreate
> that customer.**

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  CLI / Dashboard                                        │
│  packages/runner  ──► SampleAppAdapter                  │
└────────────────────────┬────────────────────────────────┘
                         │
        ┌────────────────┼──────────────────┐
        ▼                ▼                  ▼
  Fastify API       PostgreSQL          Redis / BullMQ
  (customers,      (customers,          (profile-updates
   barriers,        tombstones,          queue)
   trace)           barriers,
                    job_completions,
                    trace_events)
        │
        ▼
  BullMQ Worker
  (vulnerable | fixed processing)
```

**Packages:**
- `packages/shared`     — TypeScript types and the `TargetAdapter` interface
- `packages/sample-app` — Fastify API + BullMQ worker (vulnerable and fixed modes)
- `packages/runner`     — Scenario runner, CLI, HTTP API, Vitest suite
- `packages/dashboard`  — React/Vite evidence dashboard

## Prerequisites

- Node.js ≥ 20
- Docker Desktop (for PostgreSQL 16 + Redis 7)

## Quick Start

```bash
# 1. Copy environment file
cp .env.example .env

# 2. Start infrastructure
docker compose up -d

# 3. Install dependencies
npm install

# 4. Run database migrations
npm run migrate -w packages/sample-app

# 5. Start the BullMQ worker
npm run dev:worker -w packages/sample-app &

# 6. (Dashboard) Start the runner API
npx tsx packages/runner/src/server.ts &

# 7. Run the vulnerable reproduction
npx tsx packages/runner/src/cli.ts run delayed_update_after_deletion vulnerable

# 8. Run the fixed repair
npx tsx packages/runner/src/cli.ts run delayed_update_after_deletion fixed

# 9. Run all scenarios
npx tsx packages/runner/src/cli.ts run-all

# 10. Start the dashboard
npm run dev -w packages/dashboard
# → http://localhost:5173
```

## The Repair

### Invariant
Once deletion commits, no async processing may recreate that customer.

### Transaction and Locking Boundaries

**Deletion (fixed mode):**
```sql
BEGIN;
SELECT pg_advisory_xact_lock(hash(customerId));  -- exclusive, released on commit
INSERT INTO tombstones (customer_id, deleted_at, run_id) VALUES (…);
DELETE FROM customers WHERE id = …;
COMMIT;  -- tombstone and deletion are atomic
```

**Worker (fixed mode):**
```sql
BEGIN;
SELECT pg_advisory_xact_lock(hash(customerId));  -- blocks until deletion releases
SELECT customer_id FROM tombstones WHERE customer_id = …;
-- if found: COMMIT (no write)
-- if absent: upsert customer, COMMIT
```

### Both Orderings Are Safe

| Ordering | Outcome |
|---|---|
| Deletion acquires lock first | Worker blocks, then sees committed tombstone → skips write |
| Worker acquires lock first | Worker commits update → deletion acquires lock, inserts tombstone, deletes customer |

A "check tombstone, then write" without the advisory lock is **insufficient**:
deletion could commit between the check and the write. The advisory lock closes
that gap by making the check and the write a single critical section.

### Why Not In-Memory Locks?
Advisory locks survive across the separate API and worker processes. In-memory
locks do not.

## Scenarios

| ID | Title | Vulnerable | Fixed |
|---|---|---|---|
| `delayed_update_after_deletion` | A: Delayed update after deletion | ❌ resurrects | ✅ absent |
| `duplicate_stale_delivery` | B: Duplicate stale delivery | ❌ resurrects | ✅ absent |
| `concurrent_deletion_and_update` | C: Concurrent deletion and processing | ❌ resurrects | ✅ absent |
| `normal_active_update` | D: Normal active-customer update | ✅ updates | ✅ updates |
| `unrelated_customer_update` | E: Unrelated customer update | ✅ unaffected | ✅ unaffected |

## Verification

```bash
# Run integration tests (requires live Docker services)
npm test -w packages/runner
```

## Limitations

- Demonstrates the invariant for one sample application (PostgreSQL + Redis/BullMQ).
- Synthetic customer data only — no real PII.
- Tombstone markers are outside any complete data-erasure guarantee.
- No authentication, multi-tenancy, or production hardening.
- Docker must be installed and running for verification.

## Evidence

Each run produces a JSON evidence file in `evidence/runs/<runId>.json` containing:
the run ID, scenario, mode, ordered trace events with timestamps, transaction
commit acknowledgements, final database assertions, and code revision.

## License

See [LICENSE](LICENSE). If no license has been selected, this is a handoff
decision — choose an appropriate open-source license before publication.
