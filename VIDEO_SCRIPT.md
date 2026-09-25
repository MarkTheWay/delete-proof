# DeleteProof — 3‑Minute Video Script

**Audience:** IBM Bob hackathon judges  
**Length:** 2:45–3:00 (hard stop at 3:00)  
**Style:** live terminal first, one short Bob/MCP beat, clean close  
**Tone:** calm, specific, slightly urgent — like a senior engineer walking a war room

---

## Before you hit Record (5 minutes)

Do this **off-camera** so the video never waits on Docker:

```bat
cd C:\Users\User\Desktop\Delete-Proof
docker compose up -d
npm run migrate
```

**Terminal A**
```bat
npm run start:api
```

**Terminal B**
```bat
npm run start:worker
```

**Terminal C (recording window)** — full screen, large font (~18–20), dark theme.

Optional warm-up (discard output; proves the stack is hot):
```bat
npm run dp -- run --scenario delayed-update-after-delete --mode vulnerable
```

Clear the screen before take 1:
```bat
cls
```

Have ready (second monitor or alt-tab):
- Bob IDE with DeleteProof MCP connected (`.bob/mcp.json`), **or** a still screenshot of Bob calling `run_scenario`
- README architecture diagram scrolled into view

---

## Shot list (what judges see)

| Time | Shot |
|------|------|
| 0:00–0:20 | Face or voice-over + title card: **DeleteProof** |
| 0:20–0:35 | Terminal: `docker compose ps` |
| 0:35–1:35 | Terminal: vulnerable run (red `-` lines) |
| 1:35–2:20 | Terminal: fixed run (green `+` lines) |
| 2:20–2:40 | Bob MCP **or** `npm run dp -- compare` |
| 2:40–3:00 | Close on verdict + one-line ask |

---

## Script (word-for-word)

### 0:00–0:20 — Hook

**ON SCREEN:** black title card or terminal with cursor blinking  
Text: `DeleteProof` / `Reproduce. Repair. Prove.`

**SAY:**

> Imagine a customer exercises their right to be deleted.
> Their row is gone.
> Then a stale sync job runs… and they come back.
>
> That ghost-write is real. Teams usually find it in production.
> We built DeleteProof so you find it in three minutes — with evidence, not vibes.

*(~12 seconds of silence after “vibes” is fine — let it land.)*

---

### 0:20–0:35 — Prove the stack is real

**DO — type and run:**
```bat
docker compose ps
```

**SAY (while it prints):**

> Real PostgreSQL. Real Redis. Not a mock. Not a sleep timer.
> DeleteProof forces the race with Redis barriers — so the bug shows up on demand.

**SHOW:** `dp_postgres … (healthy)` and `dp_redis … (healthy)`.

---

### 0:35–1:35 — REPRODUCE (vulnerable)

**SAY:**

> First: break it on purpose.

**DO — type slowly enough to be readable:**
```bat
npm run dp -- run --scenario delayed-update-after-delete --mode vulnerable
```

**SAY (as the colored trace scrolls — point with mouse or narrate line by line):**

> Watch the red minus signs — same language as a code review.
>
> Customer created.
> Sync job queued.
> Worker pauses at the barrier — that’s Redis BLPOP, not `sleep(2)`.
> Deletion commits — no tombstone.
> Barrier releases.
> Worker upserts…
>
> And there. Customer is back.
>
> Verdict: **Resurrection reproduced — deletion invariant failed.**
> Final state: present. The ghost is in the database.

**SHOW clearly:**
- red banner / `invariant_violated`
- red `-` on `deletion_committed` and `worker_write_committed`
- `- Final customer state: present (resurrected / still there)`

---

### 1:35–2:20 — REPAIR (fixed)

**SAY:**

> Same race. Same infrastructure. Different code path.

**DO:**
```bat
npm run dp -- run --scenario delayed-update-after-delete --mode fixed
```

**SAY:**

> Fixed mode takes an advisory lock, writes a tombstone, then deletes.
> When the stale worker wakes up — green plus — blocked by tombstone.
> Write skipped.
>
> Safety outcome: **invariant_held**.
> Final customer state: **absent**.
>
> That is the repair: tombstones plus `pg_advisory_xact_lock` —
> so delete and update cannot step on each other across processes.

**SHOW clearly:**
- green banner / `invariant_held`
- green `+` on `worker_blocked_by_tombstone`
- `+ Final customer state: absent (null)`

---

### 2:20–2:40 — Bob / verify beat (pick ONE path)

#### Path A — Best for IBM Bob scoring (preferred)

**ON SCREEN:** IBM Bob chat (pre-typed prompt ready)

**Bob prompt (paste in Bob):**
```text
Using the DeleteProof MCP, list scenarios, then run delayed-update-after-delete
in fixed mode and summarize the safetyOutcome.
```

**SAY:**

> Inside IBM Bob we wired a DeleteProof MCP —
> so Bob doesn’t guess. It runs the scenario, reads the trace, and returns the verdict.

**SHOW:** Bob tool call → `safetyOutcome: invariant_held` (or screenshot if live MCP is flaky).

#### Path B — If Bob isn’t on camera

**DO:**
```bat
npm run dp -- compare
```

**SAY:**

> Side by side: vulnerable resurrects, fixed holds.
> Five scenarios, both modes — same evidence format Bob can call through MCP.

---

### 2:40–3:00 — Close

**ON SCREEN:** freeze on the fixed-run green verdict, or a slide:

```
DeleteProof
REPRODUCE → EXPLAIN → REPAIR → VERIFY
GitHub: github.com/FaresCH10/delete-proof
```

**SAY:**

> DeleteProof turns a silent GDPR-class failure into a reproducible demo:
> real Postgres, real Redis, barrier-forced races, and a verified transactional fix —
> with IBM Bob in the loop.
>
> That’s DeleteProof. Thanks for watching.

**Stop recording. Do not add a second outro.**

---

## Pacing cheat sheet

| Segment | Max | If running long… |
|---------|-----|------------------|
| Hook | 20s | Cut the “vibes” line |
| Docker | 15s | Skip narration; just show healthy |
| Vulnerable | 60s | Don’t re-read every trace line — hit create → delete → resurrect → verdict |
| Fixed | 45s | Skip lock explanation; land on green absent |
| Bob/compare | 20s | Screenshot only |
| Close | 20s | Title card + one sentence |

---

## Backup lines (if a judge asks / Q&A after video)

- **Why not only check-then-write?** Deletion can commit between the check and the upsert. The advisory lock closes that window.
- **Why Redis barriers?** Deterministic interleaving. Sleep-based demos lie.
- **Why Bob?** Bob drives the MCP tools — list, run, compare — so the agent works from measured evidence, not chat guesses.
- **Scope honesty:** One sample stack, synthetic data, proof-of-concept — designed to be clear under three minutes.

---

## Recording tips that win judges

1. **One take for the two CLI runs.** Judges trust live output more than slides.
2. **Font large enough to read on a phone.** Many reviewers watch on mobile.
3. **Don’t start `npm run start:api` on camera.** Dead air kills scores.
4. **Say the exact verdict strings** — they match the README and look intentional.
5. **End cold.** No “I hope you liked it.” Stop on the product name.
6. **Upload:** public YouTube/Loom unlisted is fine; paste the link on the event platform + README.

---

## Copy-paste command block (recording window)

```bat
docker compose ps
npm run dp -- run --scenario delayed-update-after-delete --mode vulnerable
npm run dp -- run --scenario delayed-update-after-delete --mode fixed
npm run dp -- compare
```

That’s the whole live demo. Everything else is voice.
