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

Open a terminal. Show Docker services are healthy:

```bash
docker compose ps
```

Run the vulnerable scenario:

```bash
npx tsx packages/runner/src/cli.ts run delayed_update_after_deletion vulnerable
```

**Point out in the output:**
1. `customer_created` — synthetic customer exists.
2. `event_queued` — update event in Redis.
3. `barrier_raised` — worker held.
4. `deletion_committed` — customer deleted (no tombstone).
5. `barrier_released` — worker resumes.
6. `worker_write_attempted` — upsert executes against the deleted customer.
7. **"Resurrection reproduced — deletion invariant failed."** ← the bug.

> "The final database query shows the customer is back. Row was absent. Now it's
> present. That is the ghost-write bug."

---

## 1:30 — REPAIR: fixed CLI run (30 s, live)

```bash
npx tsx packages/runner/src/cli.ts run delayed_update_after_deletion fixed
```

**Point out:**
- `deletion_committed` now shows **[FIXED] … with tombstone**.
- `worker_blocked_by_tombstone` — worker saw the tombstone and skipped the write.
- **"Deletion invariant held."**
- Final customer state: `absent (null)`.

> "Same worker, same event, same sequence — but now a transactional advisory
> lock ensures the worker sees the committed tombstone before it can write."

---

## 2:00 — VERIFY: dashboard + evidence (30 s, live)

Open browser → `http://localhost:5173`

1. Show the **infrastructure readiness** badges (PostgreSQL: ok, Redis: ok).
2. Show the **run history** — vulnerable run is ❌, fixed run is ✅.
3. Select the vulnerable run, show the **event timeline** scrolling through the
   resurrection.
4. Select the fixed run — timeline ends with `worker_blocked_by_tombstone`.
5. Scroll to the **side-by-side comparison**: left column customer returns, right
   column customer absent.
6. Click **⬇ Download** to export the evidence JSON.

> "Everything you just saw is backed by real PostgreSQL queries and BullMQ job
> acknowledgements — not mocked results."

---

## 2:30 — Close (30 s)

> "DeleteProof gives distributed-systems developers a three-minute path from
> 'we have a ghost-write bug report' to 'here is the exact transaction interleaving
> and a verified fix.' Bob was used to implement, inspect the vulnerable write path,
> design the repair, and run regression checks — all with recorded evidence."

---

## Backup talking points

- **Why advisory locks?** They work across separate API and worker OS processes —
  in-memory locks cannot.
- **Why not "check then write"?** Deletion can commit between the check and the
  write. The advisory lock closes that window.
- **Limitations:** synthetic data, one sample app, no production hardening.
