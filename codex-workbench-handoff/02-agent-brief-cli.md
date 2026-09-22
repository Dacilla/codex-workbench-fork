# Coding Agent Brief A — Custom Codex CLI (Windows + Linux)

You are implementing **Track A** of the accompanying architecture document. This is a real repository implementation request, not a request for another plan. Read `01-architecture-and-implementation.md` first. The CLI-only user must be able to run the result without VS Code. Do not start Track B or alter the App Server unless evidence shows that a CLI requirement truly needs it.

## First actions

1. Inspect current Git tree, toolchain and `openai/codex` upstream. Create or work in a fork, record base commit SHA and actual relevant files at that SHA. Do not assume `main` source remains identical to the linked examples.
2. Baseline: run the existing targeted TUI tests, build and execute standard Codex on at least one supported host; record failures before changing code.
3. Trace `codex-rs/tui/src/history_cell/mcp.rs`, `format_mcp_invocation`, `McpToolCallCell::display_lines`, `raw_lines`, `transcript_lines`, history overlay/reflow and session replay. Check how raw content reaches copy/export/log/scrollback. Identify the narrowest maintainable patch.
4. Implement default **compact MCP call display**: show server.tool, pending/success/failure, and safe status; hide oversized or secret-bearing args and results in everyday transcript. Full details are optional and intentional, never emitted on reflow/replay. Preserve exact tool calls/results sent to Codex core. Prefer allowlisted argument metadata over generic first-N-character previews. Keep failures understandable.
5. Wire setting(s) into the pinned version's real config schema and document their semantics. `compact` and `full` are mandatory; `preview` is optional. Avoid hardcoding Confluence names and avoid creating additional persistent copies of payloads.
6. Write and run tests for 1–25 MB synthetic payloads, nested/unicode/malformed args, narrow terminals, pending/completed/failed calls, animation, resize, replay, transcript and overflow; verify byte-for-byte or parsed JSON equivalence of the payload received by a fake MCP server.
7. Build **complete upstream-style distributions**, not just one `.exe`: Windows x64 and Linux x64 Ubuntu/Debian. Validate sandbox and installed MCP on packaged artifacts. Add GitHub Actions build/smoke/release and npm wrapper/platform-package staging using identical tested native assets. Do not publish a public release or npm package without user-approved account credentials and explicit release authorization; prepare dry-run artifacts and workflow first.

## Outputs required in the repository

- Focused Rust patch and tests; config user docs; `UPSTREAM_SHA`/patch list and human-readable changelog.
- `codex-workbench` command or wrapper with side-by-side official Codex installation; no overwrite of `codex` without an explicit opt-in.
- Verified Windows x64 and Linux x64 archives **if build hosts are actually available**; otherwise make workflows build them and report precisely which OS could not be exercised.
- GitHub Actions CI and release workflow; npm package manifest/staging and `npm pack` verification.
- A concise verification report with exact tests/run output, manual steps, package hashes and any blocked integrations. If blocked by unavailable credentials or network, use synthetic fixtures and disclose the missing live test.

## Acceptance — do not self-certify without evidence

A 1 MB `updateConfluencePage`-shaped request should occupy only a small number of terminal lines by default, show tool progress and error status, and reach the fake MCP server unchanged. `full` explicitly restores intended original rendering; normal resize/replay does not unexpectedly dump it. CLI operates independently of the graphical extension and has functioning side-by-side install. Real release-package smoke tests pass for both supported platforms before calling the track complete.

## Handoff format

At the end, provide: commit SHA(s), file list, build/release asset paths, tests with pass/fail/skipped, screenshots or short transcripts of compact/full modes, security/compatibility caveats, outstanding tasks, and precise commands for a human to try the CLI. Do not claim Windows or Linux tests passed unless executed on that OS or its representative target environment.
