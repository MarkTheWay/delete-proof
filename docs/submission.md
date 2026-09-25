# Submission Draft — DeleteProof

## Problem Statement

In event-driven microservices, a customer deletion and a queued update message
frequently race. If the message is processed after the deletion commits, a naive
upsert in the worker recreates the deleted customer row. This "ghost-write" bug
violates GDPR right-to-erasure expectations, corrupts audit logs, and has
surfaced in production systems.

## Developer Value

1. **Reproducible failure** — CLI + Redis barriers demonstrate resurrection on real PostgreSQL/Redis.
2. **Root-cause explanation** — tied to the vulnerable upsert and transaction ordering.
3. **Verified repair** — `customer_tombstones` + `pg_advisory_xact_lock(customer_lock_key(id))` across five scenarios.
4. **Evidence export** — `executionStatus` vs `safetyOutcome`, Redis trace stream, lock-wait observations.

## Technical Approach

- Sample app modes: `vulnerable.ts` (demo fixture) and `fixed.ts` (repair).
- Test hooks (`DELETEPROOF_TEST_HOOKS=1`): Redis `LPUSH`/`BLPOP` barriers + `XADD` traces.
- Runner never imports sample-app internals; uses HTTP + Redis + read-only Postgres.
- Lock waits confirmed via `pg_stat_activity.wait_event_type = 'Lock'` (runner holds no DB locks).

## Bob's Actual Contribution

_(Template for the team — do not invent Bob usage.)_

Fill this section with **real** IBM Bob sessions only:

1. What Bob was asked to do (inspect, reproduce, repair, verify, docs).
2. What Bob actually changed (file paths / scenarios).
3. Links or filenames of screenshots under `bob_sessions/` (see `bob_sessions/README.md`).

Until teammates add genuine session evidence, leave this section as a checklist rather than attributing Cursor-built work to Bob.


## Scenarios

| Scenario | Vulnerable | Fixed |
|---|---|---|
| delayed-update-after-delete | ❌ resurrects | ✅ absent |
| duplicate-stale-delivery | ❌ resurrects | ✅ absent |
| concurrent-delete-update | ❌ resurrects | ✅ absent |
| active-customer-update | ✅ succeeds | ✅ succeeds |
| unrelated-customer-update | ✅ unaffected | ✅ unaffected |

*Verification requires live Docker services (PostgreSQL 17, Redis 7) plus API + worker.*

## Limitations

- Synthetic data; one sample stack; no production hardening.

## Repository

https://github.com/FaresCH10/delete-proof
