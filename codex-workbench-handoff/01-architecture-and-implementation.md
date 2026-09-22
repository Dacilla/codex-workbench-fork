# Codex Workbench — Architecture and Implementation Specification

**Status:** Implementation handoff; design baseline, not a claim that the fork or VSIX has been built.  
**Date:** 2026-09-22  
**Product:** A custom upstream-based Codex CLI and an independent Claude-inspired graphical VS Code extension.  
**Target platforms:** Windows x64; Ubuntu/Debian Linux x64; VS Code Remote SSH.  
**Distribution:** Standalone archives from GitHub Releases and npm for the CLI; installable VSIX for the extension.

## 0. What we are building

**Track A — Terminal, for a user who does not use VS Code.** Patch Codex's actual Rust TUI so long MCP arguments/results do not flood the everyday transcript. The underlying requests, results, permissions, model context, and agent behaviour must be unchanged. Ship a usable standalone terminal application on both target OSes. Its release must not depend on Track B.

**Track B — Graphical IDE client.** Build an independent VS Code extension with graphical editor-tab conversations, not a terminal in an editor tab and not a relocation of the official Codex UI. Use `WebviewPanel` and a small, VS Code-themed frontend. Connect to the same Codex engine through its version-pinned App Server protocol, first using upstream App Server if possible. Support multiple simultaneous threads, approvals, history, file/diff integration, local and Remote SSH execution. Ship a VSIX independently of Track A when possible; prefer the custom backend but permit a compatible official backend if an initial handshake verifies compatibility.

**Cross-track invariants:** No change to MCP arguments merely to change what is shown. No replacing the core agent, account flow or tool execution with a homemade implementation. No dependency on Anthropic's binary, frontend bundle, or proprietary source at runtime. No unauthorized copying of Anthropic code/assets. No integration that forces the CLI-only user to install VS Code. No attempt to mimic the official Codex GUI.

## 1. Evidence and exact upstream reconnaissance targets

The user-provided `anthropic.claude-code-2.1.278-win32-x64.vsix` is a packaged reference implementation, **not** a distributable source dependency. Its `extension/package.json` registers editor-tab/new-conversation/reopen commands. Packaged `extension/extension.js` contains `createWebviewPanel` and `registerWebviewPanelSerializer`; `extension/webview/index.js` and `index.css` are independent graphical assets. These observations are sufficient to justify editor-hosted graphical webviews, not to claim we have recovered readable original TypeScript.

Check the **exact pinned commit** in our Codex fork before editing. Current reconnaissance starting points (locations may change upstream):

- `codex-rs/tui/src/history_cell/mcp.rs`: `McpToolCallCell`, `display_lines()`, `raw_lines()`, `format_mcp_invocation()`; investigate `transcript_lines()` and every render/export/replay path. The present display formatter serializes the JSON argument value and is the immediate source of request-body flooding.
- `codex-rs/tui/src/history_cell/`: check shell calls, file changes, unified history renderer, transcript overlay, resizing, scrollback, completed and resumed histories.
- `codex-rs/app-server-protocol/`: generated TypeScript v2 protocol; do **not** hand-author JSON-RPC fields from memory. `thread/resume` can rejoin a running thread ID or load a persisted one, but does not guarantee continuation after the underlying process is killed.
- `codex-rs/app-server/` and its test client: actual transport, initialize handshake, thread/turn lifecycle, approval requests, notifications, account/model/MCP capabilities, cancellation, and structured tool events.
- `scripts/codex_package/README.md`, `scripts/build_codex_package.py`, `codex-cli/scripts/build_npm_package.py`, `codex-rs/scripts/setup-windows.ps1`: upstream's complete binary/resource packaging, npm layout and OS-specific build prerequisites. Use the release package builder rather than distributing a lone executable unless testing establishes that a one-file package is supported.

Upstream reference URLs are in `04-source-and-validation-notes.md`. Record an immutable `UPSTREAM_SHA` before work begins. `main` links here are inspection leads, not a frozen protocol contract.

## 2. Versioning, repository and branch strategy

Create a **GitHub fork of `openai/codex`** for the CLI and backend. Suggested names are placeholders: `YOUR_ORG/codex-workbench-fork` and npm `@YOUR_SCOPE/codex-workbench`. Preserve upstream file layout. Put our documentation, experimental extension and auxiliary release scripts in `workbench/` (or a separate companion repo if upstream merge friction makes that necessary). Do not copy a second complete Codex source tree underneath the fork.

Proposed layout:

```
<fork of openai/codex>/
  codex-rs/                 # upstream source; narrow Rust patch in TUI
  codex-cli/                # upstream npm/package references
  scripts/                  # upstream package builder
  workbench/
    docs/
      architecture.md
      verification-matrix.md
      upstream-changes.md
    vscode/
      package.json         # extensionKind: ["workspace"] initially
      src/extension.ts
      src/backend/           # app-server process, RPC, version/capabilities
      src/sessions/          # thread IDs, panel IDs, storage, event router
      src/ide/               # files, selections, diffs, uri helpers
      src/webview/           # React/TS; VS Code theme vars; no terminal
      src/test/
    packaging/              # custom CLI launcher/npm manifest/release checks
  .github/workflows/
    workbench-ci.yml
    workbench-release.yml
```

Branches: `upstream-main` tracks the official repository without custom edits; `workbench/main` contains reviewed changes; `feature/cli-compact-mcp` and `feature/vscode-appserver` are independent implementation branches (or separate worktrees). Tag custom releases `workbench-vX.Y.Z+upstream.<commit>` or another unambiguous version mapping. Store the base SHA and custom patch list in the release manifest.

**Upstream sync:** fetch and pin a tested official release/commit; rebase or merge with a CI gate; inspect MCP formatter and App Server protocol diff; regenerate version-matched TypeScript definitions only via the upstream generator; run both tracks' tests and manual smoke tests before shipping. If only Track B changed, do not force new CLI binaries. Keep the Rust patch scoped to presentation wherever possible. Do not silently auto-update the CLI to an untested upstream version.

## 3. Track A: Rust TUI display policy

### 3.1 Functional behaviour

Default compact example (illustrative, no sensitive payload echoed):

```
• Called atlassian_rovo_legacy.updateConfluencePage  · succeeded
  pageId=204341250 · body=<hidden: 18,420 chars>
```

Do not assume all tool arguments are benign: URLs, headers, API keys and arbitrary strings can be secrets. The safest default is **tool name + status only**, with carefully allowlisted safe metadata when relevant; expose non-sensitive argument previews only in an optional `preview` mode. Do not build a general-purpose formatter that leaks the first N characters of every value by default. For arbitrary tool results show a short status or explicit opt-in preview; error type and a bounded diagnostic should remain visible without spilling the original body.

Introduce a display policy with at least `compact` and `full` modes; `preview` is optional after tests. Define its scope clearly: MCP only initially, configurable extension to other tool types later. Default to compact for our build, but retain the upstream display as an opt-in fallback. Setting names and config serialization **must be verified against the pinned `codex-rs` config architecture**; `[tui] tool_call_display = "compact"` is a proposed design, not an existing upstream key.

### 3.2 Data/render separation

Keep original arguments and results in the existing Codex execution flow; transform only their display. Keep live calls, completion, failures, reflow, resumed conversation replay and transcript mode consistent. Investigate whether `raw_lines()` feeds any copy/export/log facility before deciding whether raw transcript should preserve full bodies or be compact by default. An explicit full-details action may expose the existing original data, but the fork must not create **additional persistent copies** of arguments, particularly credentials and private documents. Never inject hidden bodies into terminal scrollback merely when a panel is resized or history is reopened.

Guard against malformed JSON, Unicode/newlines/ANSI control sequences, 1–25 MB argument bodies, nested maps/arrays, null/absent args, narrow terminals, long tool names, repeated call IDs and error cases. A call should be visually unambiguous as pending/completed/failed; indicate elapsed time only if cheaply available. Avoid expensive repeated serialization on every animation tick.

### 3.3 Required tests

- Golden/snapshot tests for compact and full display, running and completed calls, success and failure, narrow/wide terminal, unicode, nested JSON, ANSI/control-string handling and resizing.
- A synthetic local MCP test server receives a large request byte-for-byte unchanged; capture and compare parsed JSON or payload hash. Do not use real Atlassian credentials or production documents.
- Validate full-details interaction intentionally, and verify no huge request appears by accident in normal scrollback, transcript overlays, command output, replay or after resume.
- Smoke test terminal login/config/MCP, shell approvals and Windows/Linux sandbox behaviour with release-packaged binaries. Tests must explicitly record what was and was not run.

**MVP exit gate:** the CLI-only user can use the released terminal binary on Windows and Linux, see actionable progress between tool calls, inspect failures and intentionally access details, while identical MCP payloads reach the server.

## 4. Track B: editor-hosted graphical extension

### 4.1 Visual/interaction reference

From the user's two supplied screenshots: a conversation is an **ordinary VS Code editor tab**, movable and splittable into multiple editor groups; two chats can sit side by side alongside an image or source editor. No terminal emulator, no application-within-an-application shell, no required sidebar, no second row of custom session tabs. Use restrained VS Code-native spacing/typography, theme tokens, small header and anchored composer. Render tool actions as compact lines or expandable cards; edited files may show inline previews and open native VS Code diff editors. Code/diff blocks must be usable at narrow split widths. The screenshot is **a behaviour/layout reference, not a request to reuse Claude code or artwork**.

Core commands: New Chat in Editor Tab; Open/Resume Existing Chat (Quick Pick); Rename Tab; Open Chat Beside; Reconnect Backend; Show Logs (sanitized). Closing a panel must not delete the thread or implicitly cancel a turn. A backend crash or SSH disconnect must result in a clear recoverable status, not a false 'still running' indicator.

### 4.2 Architecture

```
Local VS Code UI <— VS Code webview message channel —>
workspace extension host (local or over Remote SSH)
       ↕ JSON-RPC over app-server stdio, request-ID routing
custom/compatible upstream Codex app-server on workspace host
       ↕ Codex engine + workspace tools/MCP
```

Use a **workspace extension** initially; in Remote SSH, the host and subprocess should execute on Ubuntu/Debian next to the repository while the webview renders in local VS Code. Avoid a webview `localhost` backend and avoid remote port forwarding. Use `webview.asWebviewUri` for assets, Content Security Policy, strict message validation and the extension host as the only process with tool execution authority. Do not send credentials into webview state, logs or telemetry. Make platform executable discovery occur on the extension-host side; Windows local → Windows package; Linux remote → Linux package. Explicit `codexExecutablePath` setting overrides discovery and is scoped to the execution host, not blindly transferred from local Windows settings to a remote Linux path.

Start with **one App Server per workspace extension host**, with multiple thread IDs and correlation-safe notification routing. That is a hypothesis until tested under concurrent turns and approvals; if an App Server instance cannot support the needed concurrency, change the isolation strategy after documenting evidence. Maintain an in-memory panelId→threadId map and persist only enough metadata to restore the mapping, names, workspace identity and drafts. Codex owns the source-of-truth conversation history. Key workspace identity by remote authority + URI and avoid accidentally resuming a local thread into a remote workspace with a different `cwd`.

### 4.3 App Server contract and guardrails

On startup: spawn `codex app-server` (verify argv against chosen SHA); perform `initialize` and required handshake; verify compatible protocol/version/capabilities; query account and model state where supported. Use **version-matched generated TypeScript protocol types** from the pinned commit and strict decoding/validation at the process boundary. Treat all incoming event text as untrusted before rendering. Build a request map keyed by JSON-RPC IDs, a thread/turn event router, cancellation and timeout handling, and bounded backpressure for streaming. Buffer/rehydrate events for hidden panels without unbounded memory growth.

Use `thread/start`, `thread/list`, `thread/resume`, `turn/start` and notifications only after confirming their exact schemas at the pinned commit. Check the latest paginated read APIs rather than assuming a full history arrives automatically on resume. Streaming deltas must not duplicate finalized items on resume. Investigate auth/login/status, model/effort selection, MCP integration, turn interrupt/steering, filesystem edits, images/attachments and approval RPCs. Preserve all approval policy semantics: pending approval shows the exact command/diff/target; user may approve/deny; ambiguous or disconnected approvals fail closed; never silently approve, and do not send a response twice.

A specific high-risk item: **connected Codex Apps / hosted integrations may behave differently from third-party MCP servers in a custom client**. Test the actual supported capability flow in a test account; do not assume a custom App Server client has feature parity with OpenAI's closed-source VS Code extension. If a feature is unavailable, state it explicitly and decide whether to defer it or use the existing official client for that feature. Never promise that a custom frontend inherits all proprietary extension services.

### 4.4 Editor integration

- Derive file references from VS Code `Uri`, `workspace.fs`, active editor and selection; preserve scheme/remote authority. Don't infer local `C:\` paths for remote Linux content. Explicitly present what file/selection is being attached.
- Native VS Code `vscode.diff` for proposed edits where a legitimate before/after pair exists; use document providers only if needed.
- Restore panel using VS Code's webview panel serializer and a stable thread ID. Don't require `retainContextWhenHidden` for all tabs; hydrate from backend state and store minimal UI state. Ensure two sessions in split groups keep focus, editor context and approval state independent.
- Sanitize markdown/html and links; CSP with nonce, no inline arbitrary script, avoid unsanitized `innerHTML`; test with adversarial tool output.

### 4.5 Backend lifetime

Closing a webview is **not** the same as stopping a turn. Closing VS Code or disconnecting SSH **may** stop the child App Server and its active work: persistent thread history does not imply persistent process execution. First release guarantees honest recovery of saved state after reconnect, not continued running across disconnect. Background survival requires an explicit later design (process supervisor/service, ownership, authentication and cleanup). On process exit, reject/settle pending RPC promises, show disconnected status and provide manual reconnect without duplicating submissions.

**MVP exit gate:** two live graphical conversations in separate VS Code editor groups, streamed messages, compact expandable tools, user-mediated approvals, tab close/reopen and Remote SSH reconnect—without any terminal UI embedded.

## 5. Build, packaging and installation

### Native packages

Build and test **x86_64-pc-windows-msvc** and **x86_64-unknown-linux-musl** (or a GNU alternative only after a documented compatibility decision), using native Windows/Linux CI runners where viable. Follow the upstream package assembler and include its manifest and supporting resources/companions. Verify Linux glibc/musl compatibility on clean Ubuntu/Debian target VMs/containers. Preferred release assets: `codex-workbench-windows-x64.zip`, `codex-workbench-linux-x64.tar.gz`, checksums, version manifest and changelog. Distinct install directories plus separate `codex-workbench` launch alias prevent overwriting official `codex`; do not assume renaming the actual executable is harmless to resource discovery or sandbox behaviour.

### npm

Publish a scoped CLI wrapper `@YOUR_SCOPE/codex-workbench` with two optional platform packages `...-win32-x64`, `...-linux-x64`, using upstream npm staging conventions as a starting point and **renaming metadata/entrypoint deliberately**. Install should select the correct prebuilt package; npm packaging must **reuse exactly the same tested binary package** as the release archives. Test clean `npm install -g`, `npm uninstall`, `--version`, config discovery, MCP startup and no collision with official `codex`. CI must check npm archive contents, hashes, executable permission and supported Node version. npm publishing requires user-provided org/scope and scoped registry credentials via GitHub secrets or trusted publishing—never hardcode tokens.

### VSIX

Package a platform-neutral **frontend-only** VSIX initially. Workspace-side setting/lookup selects a compatible local or remote Codex binary, with preference for our installed fork and explicit official-binary fallback only if the handshake passes. Bundle native binaries into platform-specific VSIX variants only if installation friction justifies it later. Validate VSIX in local Windows, local Linux, and Windows → Ubuntu/Debian Remote SSH with `Developer: Show Running Extensions` verifying execution location.

### CI/release gates

PR CI: lint/format; Rust unit and snapshot tests; frontend type-check/unit tests; App Server fake-server/protocol tests; package assembly; secret/no-credential scan. Tag workflow: build both OS targets, run smoke tests with **assembled release packages**, generate checksums, publish a GitHub draft release, publish npm packages only after archive verification, attach VSIX when Track B's tests pass. Never label a build successful solely because compilation completed. Sign or attest artifacts if feasible; at minimum include hashes and upstream SHA. Pin Actions to reviewed versions and protect release permissions.

## 6. Development order and acceptance checklist

**M0 — Baseline:** fork official repo, record upstream SHA, baseline build/test and CLI/App Server version; ensure local auth and standard Codex run without custom changes.

**M1 — CLI prototype:** narrow TUI patch, synthetic oversized MCP fixture, display/reflow/replay tests. Produce debug binaries; show before/after captures.

**M2 — CLI public-ready:** configure policy, full-detail path, complete Windows/Linux assembly, sandbox/MCP/login smoke, downloadable archives/npm package. This is a standalone release gate for the CLI user.

**M3 — App Server vertical slice:** disposable extension development host; two editor webviews, one App Server, streaming to the correct panel, user-mediated approval, thread reopen and backend-crash recovery. No styling polish before this passes.

**M4 — IDE client:** VS Code-themed UI matching the screenshots' layout, compact tool cards, file context, native diff, session picker, model controls as supported, strict message security and state restoration.

**M5 — Remote + releases:** Windows → Linux Remote SSH; local Linux; package/discovery; Linux/Windows VSIX smoke; tagged GitHub release and npm package.

Record each acceptance test with **OS/version, SHA, command or manual steps, outcome, log location, unresolved limitation**. Do not claim a feature is complete if it has only a mock test. The principal go/no-go tests are: original MCP payload unchanged; usable standalone CLI without VS Code; independent graphical editor tabs; approval routing never crosses threads; Remote SSH executes on the remote workspace; archives and npm resolve the same tested binaries.

## 7. Non-goals and explicit unresolved issues

Non-goals for MVP: cloning Claude's proprietary source or visuals, pixel-identical styling, shipping a generic terminal-in-editor, guaranteeing execution during SSH loss, full parity with every closed-source Codex feature, cloud sync of user preferences, macOS/ARM builds, a custom model API client, and automatic backend downloads.

Require evidence before resolving: final upstream SHA; exact config setting registration; whether full original args should be inspectable in UI vs an existing raw transcript (sensitive data policy); App Server concurrency/approval routing and history pagination; Windows sandbox helpers; Ubuntu/Debian compatibility floor; auth/connected-app availability in a custom client; license/attribution and npm/release naming. If one fails, update this document and choose a documented fallback rather than silently narrowing scope.
