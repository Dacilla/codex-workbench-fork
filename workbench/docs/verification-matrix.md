# Verification matrix (live document)

Record each acceptance test with OS/version, SHA, command/manual steps, outcome, log location, unresolved limitation.
Do not claim completeness from mock tests alone.

## M0 — Baseline

- [ ] Upstream SHA recorded: `639d2478cc2e16d6ca715952d2e726a3aecc024e`
- [ ] Targeted TUI tests pass (Windows host)
- [ ] Standard Codex debug build + run (at least one host)
- [ ] App Server test client handshake (`initialize`, `thread/start`, `turn/start`)

## M1 — CLI prototype (Track A)

- [ ] Compact vs full golden snapshots (running/completed, success/failure, narrow/wide, unicode, nested JSON, ANSI, resize)
- [ ] Synthetic MCP server receives large request byte-for-byte unchanged
- [ ] No huge request in scrollback/transcript/replay/resume by accident
- [ ] Before/after captures

## M2 — CLI public-ready

- [ ] Windows x64 + Linux x64 assembled packages (not lone .exe)
- [ ] Sandbox/MCP/login smoke on release packages
- [ ] `npm pack` verification, side-by-side install with official `codex`
- [ ] Draft release + hashes + changelog (no publish without authorization)

## M3 — App Server vertical slice (Track B)

Branch `feature/vscode-appserver`. Extension SHA: see commit log. Pinned protocol SHA `639d2478cc2e16d6ca715952d2e726a3aecc024e` (`npm run check-protocol-pin`).

- [x] Two editor webviews, one App Server, correct per-thread routing — FAKE-ONLY: `npm run test` ("two-thread routing", "global notifications") on Windows 11 x64, Node 23.10.0, 2026-09-22. Real-backend concurrency UNTESTED.
- [x] User-mediated approval, interrupt, crash/reconnect — FAKE-ONLY: owned approve/deny exactly-once, orphaned decline, decision timeout, crash settlement (`TransportClosedError` + `crashed` state). Live interactive approval UNTESTED (needs model turn; opt-in steps in `vscode-manual-tests.md`).
- [x] Thread reopen via paginated read APIs, no duplicate deltas — FAKE-ONLY (`thread/resume` + `excludeTurns` + `thread/turns/list` + `thread/items/list`, dedup asserted) plus LIVE-OFFICIAL read probes against codex-cli 0.155.1 (`thread/list`, `thread/resume`, `thread/turns/list`, `thread/items/list`, `model/list`, `getAuthStatus`, `modelProvider/capabilities/read` — read-only, 2026-09-22). `turn/start` against a real backend UNTESTED.
- [ ] Live Extension Development Host render of two tabs (manual steps in `vscode-manual-tests.md`).
- [ ] Real-backend simultaneous-turn concurrency (documented trigger for revisiting single-server isolation).

Full per-method status: `vscode-feature-matrix.md`. Known gaps: auth/connected-apps parity not claimed; webview ES-module load not yet rendered live; no Remote SSH run yet.

## M4 — IDE client

- [ ] VS Code-themed layout, compact tool cards, file context, native diff, session picker, model controls (as supported), CSP/sanitization, state restoration

## M5 — Remote + releases

- [ ] Windows → Ubuntu/Debian Remote SSH (remote execution, no local-path inference)
- [ ] Local Windows + local Linux VSIX smoke
- [ ] Tagged GitHub release + npm (same tested binaries)
