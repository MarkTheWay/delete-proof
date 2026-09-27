# IBM Bob session reports

Required for judging: every team member exports **every** Bob IDE task used for
this project. Each task needs two files:

1. The exported task history (markdown).
2. A screenshot of the task session consumption summary.

## How to export (from the hackathon guide)

1. In Bob IDE chat, open **Views and More Actions → History**.
2. Confirm the workspace is this project (choose **All** if tasks span workspaces).
3. Open the task and select the task header to show the consumption summary.
4. Screenshot the consumption summary.
5. In the same view, click **Export task history** to download the markdown.
6. Repeat for each task.

Make sure you are on the hackathon account (`ibm-coding-challenge-xxx`), not a
personal Bob account.

## Before committing

Search every export for credentials, API keys, tokens, and `.env` contents and
remove them. IBM deactivates accounts when credentials appear in a public repo.

## Naming

```
bob_sessions/
  <github-handle>-01-<topic>.md
  <github-handle>-01-<topic>.png
  <github-handle>-02-<topic>.md
  <github-handle>-02-<topic>.png
```

## Sessions

| # | Member | Task | Files |
|---|---|---|---|
| 01 | MarkTheWay | Task `ffe658448386cf1939242dd67dfb387f` — build the DeleteProof prototype from the project brief (162 commands, 44 file writes, 12 diffs; 45.88 Bobcoins) | [task history](marktheway-01-deleteproof-build-task-history.md) · [consumption summary](marktheway-01-deleteproof-build-consumption-summary.png) · in progress: [a](marktheway-01-deleteproof-build-in-progress-a.png), [b](marktheway-01-deleteproof-build-in-progress-b.png) |
| 02 | MarkTheWay | Task `840d7a56fe5a461799780401742c5ad3` on `ibm-coding-challenge-2` — Bob drove DeleteProof through its MCP tools (vulnerable vs fixed run, traces, comparison), explained the repair from the code, and surfaced an MCP `structuredContent` bug that was then fixed and re-verified (0.586 Bobcoins) | [task history](marktheway-02-mcp-demo-task-history.md) · [consumption summary](marktheway-02-mcp-demo-consumption-summary.png) |
| 01 | Fares (FaresCH10) | Task `dc58e7531faa79590d361ab408695b92` — Bob pulled the vulnerable run through the DeleteProof MCP, located the unconditional upsert in `vulnerable.ts` (lines 72–79) as the resurrection point, and explained why nothing blocks the write (0.349 Bobcoins) | [task history](fares-01-mcp-trace-debug-task-history.md) · [consumption summary](fares-01-mcp-trace-debug-consumption-summary.png) · in progress: [a](fares-01-mcp-trace-debug-in-progress-a.png), [b](fares-01-mcp-trace-debug-in-progress-b.png) |
