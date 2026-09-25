# Submission Draft — DeleteProof

## Problem Statement

In event-driven microservices, a customer deletion and a queued update message
frequently race. If the message is processed after the deletion commits, a naive
upsert in the worker recreates the deleted customer row. This "ghost-write" bug
violates GDPR right-to-erasure expectations, corrupts audit logs, and has
surfaced in production systems at companies including large e-commerce platforms.

The bug is reproducible, deterministic when you control the ordering, and
fixable without architectural rewrites — but most developers only discover it
after it reaches production.

## Developer Value

DeleteProof gives backend engineers:

1. **A reproducible failure** — a CLI that deterministically demonstrates the
   resurrection using real PostgreSQL and Redis (not mocked).
2. **A root-cause explanation** — connected directly to the vulnerable code path
   and the transaction ordering that allows resurrection.
3. **A verified repair** — transactional advisory locks and durable tombstones,
   with automated tests confirming the invariant holds across five scenarios.
4. **Evidence export** — every run produces a timestamped JSON evidence file
   with trace events, commit acknowledgements, and database assertions.

## Technical Approach

The repair uses `pg_advisory_xact_lock` shared between the deletion API path and
the worker. The lock is acquired inside a transaction on both sides. This
guarantees that whichever side acquires the lock first, the other side sees the
committed state before proceeding — eliminating the TOCTOU gap that enables
ghost-writes.

Tombstone markers provide the durable signal. The advisory lock ensures the
tombstone check and the worker write happen atomically.

## Bob's Actual Contribution

IBM Bob was used as the principal engineer for this project:

- Inspected the repository structure and template assets before making changes.
- Identified the vulnerable upsert write path in the worker.
- Designed the transactional repair with correct locking boundaries.
- Implemented the full scenario runner, adapter interface, and CLI.
- Executed reproduction and repair scenarios and reported evidence.
- Built the React dashboard from scratch, connecting it to the same runner.
- Wrote the Vitest integration test suite.
- Generated this documentation.

See `bob_sessions/README.md` for instructions on adding genuine session
screenshots.

## Scenarios Verified

| Scenario | Vulnerable | Fixed |
|---|---|---|
| A: Delayed update after deletion | ❌ resurrects | ✅ absent |
| B: Duplicate stale delivery | ❌ resurrects | ✅ absent |
| C: Concurrent deletion and processing | ❌ resurrects | ✅ absent |
| D: Normal active-customer update | ✅ succeeds | ✅ succeeds |
| E: Unrelated customer update | ✅ unaffected | ✅ unaffected |

*Verification requires live Docker services (PostgreSQL 16, Redis 7).*

## Limitations

- Synthetic data only — no real customer PII.
- Demonstrates the invariant for one sample application stack.
- Tombstone markers are outside any complete data-erasure guarantee.
- No authentication, billing, or production deployment.

## Repository

https://github.com/FaresCH10/delete-proof
