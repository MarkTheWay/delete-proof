# Three-Minute Demo Script — DeleteProof

**Audience:** IBM hackathon judges  
**Total:** ~3 minutes | Live demo: ≥ 90 seconds

---

## 0:00 — Introduction (30 s)

> "DeleteProof solves a real distributed-systems bug that most teams don't catch
> until production: a customer gets deleted, but a stale async event recreates
> their data minutes later. We built a tool that reproduces the failure with
> real infrastructure, explains the root cause at the transaction level, and
> verifies a repair — all inside IBM Bob."

Point to the architecture diagram in the README.

---

## 0:30 — REPRODUCE: vulnerable CLI run (60 s, live)

```bash
docker compose ps
npm run dp -- run --scenario delayed-update-after-delete --mode vulnerable
```

**Point out in the output:**
1. `customer_created` — synthetic customer exists.
2. `event_queued` — sync job in Redis/BullMQ.
3. `barrier_ack` / `worker.before_write` — worker held (Redis BLPOP, not sleep).
4. `deletion_committed` — customer deleted (no tombstone).
5. `barrier_released` — worker resumes.
6. `worker_write_committed` — upsert recreates the row.
7. **"Resurrection reproduced — deletion invariant failed."** ← the bug.

> "The final database query shows the customer is back. That is the ghost-write."

---

## 1:30 — REPAIR: fixed CLI run (30 s, live)

```bash
npm run dp -- run --scenario delayed-update-after-delete --mode fixed
```

**Point out:**
- Tombstone + `pg_advisory_xact_lock(customer_lock_key(id))`.
- Optional `lock_wait_observed` from `pg_stat_activity` (runner never holds locks).
- `worker_blocked_by_tombstone` or delete-after-write leaving the row absent.
- `safetyOutcome: invariant_held`
- Final customer state: `absent (null)`.

---

## 2:00 — VERIFY: dashboard + evidence (30 s, live)

```bash
npm run start:runner
npm run start:dashboard
```

Open `http://localhost:5173`

1. Infrastructure readiness badges (PostgreSQL, Redis, API).
2. Run history — vulnerable ❌, fixed ✅.
3. Event timeline + side-by-side comparison.
4. Download evidence JSON.

---

## 2:30 — Close (30 s)

> "DeleteProof gives a three-minute path from ghost-write report to a verified
> transactional fix, with Redis barriers and Postgres lock waits as evidence —
> not mocked sleeps."

---

## Backup talking points

- **Why advisory locks?** Cross-process; in-memory locks cannot.
- **Why Redis BLPOP?** Deterministic interleaving without sleep-based correctness.
- **Why not check-then-write alone?** Deletion can commit between check and write;
  the transactional lock closes that window.
