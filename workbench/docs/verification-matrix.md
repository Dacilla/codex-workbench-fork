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
- [x] CI fully green on `workbench/main` (run 35716951619, 43m42s, 2026-09-22): TUI fmt/clippy/targeted-nextest on Ubuntu + Windows, vscode typecheck/lint/test on both OSes, secret scan, npm pack check. First green gate run.

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
- [~] Fourth live run: screenshot shows pre-normalize build still installed — the shell-free `package-vsix.js` invoked vsce's exported runner directly, which silently no-ops (only the `vsce` bin wrapper parses argv), so "OK" packaged nothing new. Fixed via `scripts/run-vsce.js` wrapper + exists-check on the output file; verified normalize code present in the installed extension. Reload + new chat required (old tabs run stale webview JS).
- [~] Fifth live run: user message renders once, agent code fences render (raw ``` fences, no highlighting yet — M4 polish). New concern: no model/effort visibility — usage anxiety. Fixed: per-thread model + reasoning-effort picker (`Select Model` / `Select Reasoning Effort` commands over live `model/list`, per-thread pins forwarded on `turn/start`, `model · effort` in the header, pins persisted). 72/72 suite green; VSIX rebuilt/reinstalled with installed-copy verification.
- [~] Sixth live run (screenshot): model picker WORKS against official 0.155.1 — header shows real `model: gpt-5.6-luna · effort: max`, single user card, agent answer streams, MCP segment honest. Remaining polish: raw ``` fences (no code highlighting), flat card styling (M4). An earlier "failed to startup" cleared on retry with no error in our logs — transient, cause unknown; watching for recurrence.
- [~] Seventh live run (pending user retry): M4 render increment — fenced code blocks render as labeled `<pre>` blocks (language tag, editor font, horizontal scroll + wrap, no inline-markdown leakage, unclosed fences contained), plus card CSS. 73/73 suite green; VSIX rebuilt/reinstalled with installed-copy verification.
- [~] Eighth live run (screenshots): turn works but Enter gives no in-conversation feedback until the first token (header flips, composer clears, nothing else). Fixed: `awaitingFirstToken` placeholder row ("Working…" with pulsing dot, aria-live) armed on turn start, cleared by first delta/item or terminal status. 74/74 suite green; VSIX rebuilt/reinstalled with installed-copy verification.
- [~] Tenth live run (screenshots): placeholder works but clears ~5s before visible text — the backend echo of our own message retired it long before generation produced anything. Fixed: only agent-side items/deltas (never `userMessage` echoes) clear the flag. 75/75 suite green; VSIX rebuilt/reinstalled with installed-copy verification, awaiting user retry.
- External review #5/#6 closed without new live runs yet: context commands (attach/rename/model/effort) now resolve via focus-tracked active panel instead of first-visible (split-safe); the same thread can no longer be live in two panels (resume reveals the existing tab; in-tab resume of an elsewhere-open thread errors honestly). 75/75 green; installed with verification. Manual check pending: split two chats, attach in each, resume an open thread.
- Upstream drift assessed: 7 commits / 111 files since the pin, all additive protocol surface (gateway OAuth) — nothing touches our patched files (`tui/history_cell`, config, chatgpt). Rebase deferred until approval/focus work lands, recorded here rather than silently skipped.
- [~] Ninth live run: `Error loading webview: Could not register service worker / document is in an invalid state` on startup. Our logs show a clean connect, so this is VS Code's loader failing on the restored pre-update tab, not our HTML (we register no service workers). Hardened the serializer restore path anyway (state-shape validation, whole-body try/catch so a failed restore logs instead of leaving a dead webview). If it recurs on a FRESH New Chat tab (not a restored one), that reclassifies it as our bug — report which.
- [ ] Live Extension Development Host render of two tabs (manual steps in `vscode-manual-tests.md`).
- [~] First live run (2026-09-22, Windows 11 x64, official codex-cli 0.155.1 backend): extension activates and handshake SUCCEEDS (`connected to codex-workbench/0.155.1`), but New Chat opened nothing — auto-connect at activation raced the command and the second connect threw `backend connection already in progress`. Fixed via connect coalescing (`ConnectGate`, 3 unit tests, 47/47 suite green, commit `e1abcea`); VSIX rebuilt/reinstalled, awaiting user retry.
- [~] Second live run: panel opens, but `thread/started` + per-server `mcpServer/startupStatus/updated` + every other background notification rendered as raw activity cards (screenshot evidence). Fixed: lifecycle notices stay out of the timeline, MCP updates coalesce into one header segment (`ext/mcpStatus`, bounded at 64 servers), unknown methods go to the output channel only. 48/48 suite green at the time.
- [~] Third live run (screenshot): panel opens and a live turn works, but the user message double-renders (local echo + backend echo as separate cards, the latter showing the raw `userMessage` kind label) and collapsed cards show crude `[+] reasoning` labels. Fixed: backend echo adopts the optimistic local card (same text), tool cards use ▸/▾ toggles with friendly labels (Thinking, Terminal, Edit, Tool, Plan) plus a one-line collapsed preview. 50/50 suite green; VSIX rebuilt/reinstalled, awaiting user retry.
- [ ] Real-backend simultaneous-turn concurrency (documented trigger for revisiting single-server isolation).

Full per-method status: `vscode-feature-matrix.md`. Known gaps: auth/connected-apps parity not claimed; webview ES-module load not yet rendered live; no Remote SSH run yet.
- [x] Local Linux runtime validation (2026-09-22, Ubuntu 26.04.1 x64, Node 22.22.1, host `peanut`): `check-protocol-pin` OK, typecheck clean, lint OK, `node --test` 44/44 pass. VS Code GUI install/render smoke NOT run (headless).

## M4 — IDE client (external review triage, 2026-09-22 — all 12 items verified)

- [x] ThreadItem normalization keystone: `normalizeThreadItem()` boundary (App Server ThreadItem → ViewItem) using real generated shapes; `mcpCall`→`mcpToolCall` remap; content-free/unknown variants dropped with logging instead of kind labels; command output detail keeps tail; fixtures mirror generated types. 63/63 suite green (merges `2250bc2`, `d45c2e8`). Reviewer's duplicate-fix-will-fail prediction addressed (backend echo now normalizes real `content[]` shapes).
- [x] Workspace Trust honest (`supported:false`), VSIX packaging shell-free (verified), release tag guards (branch/pin/naming), handoff record committed in-repo, recursion workaround reverted (verified green under pinned 1.95.0). Merge `7bf74bd`.
- [ ] Approval per-kind UI (Approve shown for permissions/userInput/dynamicTool that fail closed into deny).
- [ ] Focus-aware multi-panel commands (attach/rename use first-visible, wrong in splits) + same-thread-in-two-panels approval ownership (proposed: forbid, reveal existing instead).
- [ ] Official-backend fallback gating (handshake allows writes on drifted servers; propose known-compatible full vs unknown read-only/explicit-override).
- [ ] Upstream sync decision (6 commits behind incl. gateway-OAuth protocol addition; assess file-level impact before rebasing).

## M5 — Remote + releases (Linux host leg, `alfie` Ubuntu 26.04.1 x64)

- [ ] VS Code-themed layout, compact tool cards, file context, native diff, session picker, model controls (as supported), CSP/sanitization, state restoration

## M5 — Remote + releases (Linux host leg, `alfie` Ubuntu 26.04.1 x64)

- [x] Full TUI suite on Linux (2026-09-22, repo-pinned toolchain 1.95.0): 5449 tests run; all green except 6 `ide_context::ipc::fetch_ide_context_*` socket tests that trip a deliberate security guard (`parent mode & 0o022`, rejects group-writable socket dirs) because alfie runs umask 002. Proven environmental: same 10 tests 10/10 pass with umask 022. Our diff touches none of that code. Build needed `OPENSSL_DIR/LIB_DIR/INCLUDE_DIR` (headers present, `pkg-config` missing) — no sudo required.
- [ ] Windows → Ubuntu/Debian Remote SSH (remote execution, no local-path inference)
- [ ] Local Windows + local Linux VSIX smoke
- [ ] Tagged GitHub release + npm (same tested binaries)
