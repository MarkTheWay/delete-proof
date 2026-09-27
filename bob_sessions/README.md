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
| 01 | MarkTheWay | "git init, npm workspaces with p…" — scaffolded the npm-workspaces monorepo (38 files changed) and diagnosed the Windows Vite/Rollup native-binary install failure | [`marktheway-01-monorepo-scaffold-a.png`](marktheway-01-monorepo-scaffold-a.png), [`marktheway-01-monorepo-scaffold-b.png`](marktheway-01-monorepo-scaffold-b.png) · task history export: _pending_ |
