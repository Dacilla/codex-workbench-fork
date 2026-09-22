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

- [ ] Two editor webviews, one App Server, correct per-thread routing
- [ ] User-mediated approval, interrupt, crash/reconnect
- [ ] Thread reopen via paginated read APIs, no duplicate deltas

## M4 — IDE client

- [ ] VS Code-themed layout, compact tool cards, file context, native diff, session picker, model controls (as supported), CSP/sanitization, state restoration

## M5 — Remote + releases

- [ ] Windows → Ubuntu/Debian Remote SSH (remote execution, no local-path inference)
- [ ] Local Windows + local Linux VSIX smoke
- [ ] Tagged GitHub release + npm (same tested binaries)
