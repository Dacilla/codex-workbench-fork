# Verification matrix (live document)

Record each acceptance test with OS/version, SHA, command/manual steps, outcome, log location, unresolved limitation.
Do not claim completeness from mock tests alone.

## M0 — Baseline

- [x] Upstream SHA recorded: `639d2478cc2e16d6ca715952d2e726a3aecc024e` (`workbench/UPSTREAM_SHA`, commit `d4f19aa`, 2026-09-22).
- [x] Targeted TUI tests pass (Windows host) — baseline at pinned SHA: 5383 run, 5353 passed, 26 pre-existing theme-snapshot fails, 4 timeouts, 9 skipped (Track A report; required one-line recursion-limit workaround `153a588` to build on rustc 1.98.1).
- [x] Standard Codex debug build + run (at least one host) — debug binaries built via `just test -p codex-tui` on Windows 11 x64, rustc 1.98.1 (2026-09-22). No standalone `codex` smoke run yet.
- [~] App Server test client handshake — PARTIAL: live read-only probes vs official codex-cli 0.155.1 (`thread/list`, `thread/resume`, `thread/turns/list`, `thread/items/list`, `model/list`, `getAuthStatus`, `modelProvider/capabilities/read`, 2026-09-22; Track B). `initialize`+`turn/start` via test client UNTESTED.

## M1 — CLI prototype (Track A)

- [x] Compact vs full golden snapshots — accepted after review (commits `4d723d3`, `6086618`; 14 policy tests; 2026-09-22, Windows 11 x64). `full` restores legacy byte-for-byte (existing snapshots unchanged).
- [x] Synthetic MCP server receives large request byte-for-byte unchanged — CLOSED (2026-09-22): `codex-rs/rmcp-client/tests/large_payload_round_trip.rs` (commit `ea49752`) drives the real stdio stack (`RmcpClient` + `LocalStdioServerLauncher` + `test_stdio_server` echo tool). 1,048,576-byte synthetic Confluence-shaped body (nested + unicode, no credentials) returns exactly equal (full equality + sha256); 25 MiB also succeeds byte-identical on the default legacy local path (unbounded native codec); malformed args explicitly rejected. 3/3 pass on Windows 11 x64 (rustc 1.98.1, independently re-run green) AND Ubuntu 26.04.1 x64 (host `peanut`, repo-pinned toolchain 1.95.0, 8.49s).
- [x] No huge request in scrollback/transcript/replay/resume by accident — covered by replay/transcript snapshot tests + 1 MB payload test (compact ≤4 lines vs >1000 full). Result bodies keep the existing bounded 3-row preview in all modes (only args hidden; documented).
- [x] Before/after captures — accepted insta snapshot `...display_policy_tests__compact_preview_and_full_presentations_snapshot.snap` in repo.
- [x] Post-merge hygiene (2026-09-22, Windows 11 x64, rustc 1.98.1): `cargo fmt --check` passes; clippy clean for all workbench files (one deny-level `redundant_clone` fixed); targeted `display_policy` 14/14 re-passed after fixes (commit `6086618`, merge `9e0f598`). Follow-up broadening: `codex-config` 344/344 pass; `history_cell` 224/227 with the same 3 pre-existing theme/width snapshot fails as baseline (`recap_history_cell_preserves_line_breaks…`, two `session_header…halfwidth…` — unrelated to MCP, match Track A's baseline triage). Pre-existing `layout.rs` late-init (clippy-1.98-only; upstream CI pins 1.95.0) left untouched.
- CI: `workbench-ci` vscode/secret/npm jobs green on both OSes (run 35702742769); TUI job red on a workflow bug (wrong cwd, no root Cargo.toml) — fixed, re-run 35702978564 pending.

## M2 — CLI public-ready

- [ ] Windows x64 + Linux x64 assembled packages (not lone .exe)
- [ ] Sandbox/MCP/login smoke on release packages
- [x] `npm pack` verification — wrapper `npm pack --dry-run` + launcher syntax/fail-closed checks pass locally (Windows 11, Node 23.10.0) and in CI (`npm-pack-check` green, run 35702742769). Side-by-side install with official `codex` UNTESTED. Scope still placeholder `@YOUR_SCOPE` (owner decision required).
- [ ] Draft release + hashes + changelog (no publish without authorization)

## M3 — App Server vertical slice (Track B)

Branch `feature/vscode-appserver`. Extension SHA: see commit log. Pinned protocol SHA `639d2478cc2e16d6ca715952d2e726a3aecc024e` (`npm run check-protocol-pin`).

- [x] Two editor webviews, one App Server, correct per-thread routing — FAKE-ONLY: `npm run test` ("two-thread routing", "global notifications") on Windows 11 x64, Node 23.10.0, 2026-09-22. Real-backend concurrency UNTESTED.
- [x] User-mediated approval, interrupt, crash/reconnect — FAKE-ONLY: owned approve/deny exactly-once, orphaned decline, decision timeout, crash settlement (`TransportClosedError` + `crashed` state). Live interactive approval UNTESTED (needs model turn; opt-in steps in `vscode-manual-tests.md`).
- [x] Thread reopen via paginated read APIs, no duplicate deltas — FAKE-ONLY (`thread/resume` + `excludeTurns` + `thread/turns/list` + `thread/items/list`, dedup asserted) plus LIVE-OFFICIAL read probes against codex-cli 0.155.1 (`thread/list`, `thread/resume`, `thread/turns/list`, `thread/items/list`, `model/list`, `getAuthStatus`, `modelProvider/capabilities/read` — read-only, 2026-09-22). `turn/start` against a real backend UNTESTED.
- [ ] Live Extension Development Host render of two tabs (manual steps in `vscode-manual-tests.md`).
- [~] First live run (2026-09-22, Windows 11 x64, official codex-cli 0.155.1 backend): extension activates and handshake SUCCEEDS (`connected to codex-workbench/0.155.1`), but New Chat opened nothing — auto-connect at activation raced the command and the second connect threw `backend connection already in progress`. Fixed via connect coalescing (`ConnectGate`, 3 unit tests, 47/47 suite green, commit `e1abcea`); VSIX rebuilt/reinstalled, awaiting user retry.
- [ ] Real-backend simultaneous-turn concurrency (documented trigger for revisiting single-server isolation).

Full per-method status: `vscode-feature-matrix.md`. Known gaps: auth/connected-apps parity not claimed; webview ES-module load not yet rendered live; no Remote SSH run yet.
- [x] Local Linux runtime validation (2026-09-22, Ubuntu 26.04.1 x64, Node 22.22.1, host `peanut`): `check-protocol-pin` OK, typecheck clean, lint OK, `node --test` 44/44 pass. VS Code GUI install/render smoke NOT run (headless).

## M4 — IDE client

- [ ] VS Code-themed layout, compact tool cards, file context, native diff, session picker, model controls (as supported), CSP/sanitization, state restoration

## M5 — Remote + releases

- [ ] Windows → Ubuntu/Debian Remote SSH (remote execution, no local-path inference)
- [ ] Local Windows + local Linux VSIX smoke
- [ ] Tagged GitHub release + npm (same tested binaries)
