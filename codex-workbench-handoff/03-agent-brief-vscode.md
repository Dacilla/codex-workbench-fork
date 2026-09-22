# Coding Agent Brief B — Claude-style graphical Codex VS Code extension

You are implementing **Track B** of the accompanying architecture document. Read `01-architecture-and-implementation.md` first. Build a **graphical VS Code extension in normal editor tabs**, NOT an integrated terminal, OpenCode-style terminal-in-a-pane, or wrapper around the official Codex GUI. The CLI branch is a separate independent deliverable; coordinate a pinned App Server protocol SHA with Track A but do not block the graphical prototype on its TUI patch.

## Visual requirement

The user's reference screenshots show two Claude Code conversations open in **separate regular editor groups**, with a normal file/image editor beside them. Keep the standard VS Code tab bars; no nested custom tabs, permanent session sidebar, oversized app-like navigation or terminal. Use responsive narrow/wide layouts, VS Code theme colors/fonts, a minimal conversation header, an anchored composer, compact tool events and a native diff affordance. The user-provided Claude VSIX is for understanding supported interaction/design patterns only; do not ship, import, copy or execute its proprietary JS/assets.

## First actions

1. Pin the Codex upstream SHA and study its `codex-rs/app-server-protocol` generated TS declarations, the actual App Server stdio handshake, thread/turn events, typed tool calls, history/pagination, approval requests and identity/config/capability queries. Create a feature matrix with **confirmed via live test**, **supported by source but untested**, and **unsupported** statuses. Do not invent JSON-RPC methods or response types.
2. Build a tiny local vertical slice: `WebviewPanel` editor tab → VS Code extension host → one `codex app-server` child over stdio → initialize → start/resume thread → send turn → stream response and tool statuses. Introduce safe JSON-RPC request IDs and route every event and approval by thread/turn. Test two independently active editor tabs; never attach a tool event or approval to the wrong tab.
3. Implement explicit approval UI with decision and accurate command/diff/target; fail closed on lost connection, disposed panel or ambiguous ownership; do not automatically approve. Implement interrupt, error, process crash and manual reconnect.
4. Add `registerWebviewPanelSerializer` and minimal panel/thread metadata. Closing editor tab must not delete its saved conversation. Restore thread history using the pinned App Server's actual paginated read APIs, not by retaining giant webview state. No promise of continued turn execution after extension-host shutdown or SSH disconnect.
5. Implement VS Code-native file selection/reference, active editor and highlighted-code context, `vscode.diff` for valid changed files, Quick Pick for older threads, model/effort options as exposed by the backend, compact expandable tool display and bounded streaming updates. Validate all incoming content before display; CSP, nonce, URI authorization and no credential echo.
6. Remote SSH validation: run workspace extension host + backend on remote Ubuntu/Debian x64, GUI locally on Windows. Set extension kind explicitly or document why another split architecture is needed. Webview ↔ extension-host message passing only, **no webview localhost shortcuts**. Test two threads, approvals, remote file edits, disconnect/reconnect and backend binary discovery on the remote OS. Test local Windows and local Linux as well.
7. Produce a **frontend-only VSIX** with settings to locate the backend on the execution host. Prefer our custom binary, allow a compatible upstream binary only after a version/capability handshake; display a clear error on mismatch. Wire CI for typecheck, lint, UI/protocol tests and package smoke. Deliver a VSIX without bundling proprietary Claude resources.

## Suggested components (refine based on actual protocol)

`backend/ProcessManager`, `backend/JsonRpcTransport`, `backend/ProtocolVersion`, `sessions/ThreadRegistry`, `sessions/PanelRegistry`, `sessions/EventRouter`, `ide/UriContext`, `ide/DiffProvider`, `webview/Conversation`, `webview/Composer`, `webview/ToolActivity`, `webview/Approval`, `webview/SessionPicker`. A single workspace-host App Server with multiple threads is the starting hypothesis; measure concurrency and adapt only if tests justify it.

## Acceptance — do not self-certify without evidence

- Two concurrent graphical Codex chats in separate movable editor tabs, normal VS Code editor grouping and file/image previews alongside them; no terminal UI.
- Independent session context, stream routing, editor focus, approvals, interruptions, close/reopen, and no duplicate messages on resume.
- Large synthetic MCP requests are visually compact while backend arguments are unchanged; full details available only by explicit action, with sensitive-value handling.
- From local Windows VS Code over Remote SSH, backend executes on remote Ubuntu/Debian repository, reads/writes remote files correctly, never attempts local Windows-path operations, and resumes persisted thread state after reconnect with honest interruption status.
- VSIX installs and runs on Windows x64 and Linux x64; documented official-backend fallback behaviour and known feature-parity gaps.

## Handoff format

Report actual commit SHA, pinned protocol SHA, architectural decisions, executable path/discovery assumptions, all tests performed with environment, VSIX artifact, known limitations, and manual verification steps including opening two sessions beside a code file and testing Remote SSH. If account/connected-app checks cannot be run without credentials, leave reproducible opt-in tests and report the gap; do not claim parity with the official extension.
