# Codex Workbench — VS Code extension (Track B, M0+M3 slice)

Independent graphical Codex client. Editor-tab `WebviewPanel` conversations,
workspace extension host (`extensionKind: ["workspace"]`), one `codex
app-server` stdio child per host, version-pinned App Server protocol.

No terminal UI. No official Codex GUI relocation. No Anthropic code/assets.

## Layout

- `src/extension.ts` — activation, commands, `registerWebviewPanelSerializer`, webview HTML (CSP+nonce).
- `src/backend/` — `ProcessManager` (stdio child), `JsonRpcTransport`
  (newline-delimited JSON-RPC, request-ID map, timeout/cancel, bounded
  backpressure), `ProtocolVersion` (`initialize` handshake + compatibility
  gate), `BackendDiscovery` (extension-host-side resolution + official-binary
  fallback rule).
- `src/sessions/` — `ThreadRegistry` (panel→thread map, persisted metadata
  only), `PanelRegistry`, `EventRouter` (per-thread routing, bounded hidden
  buffers), `Approvals` (explicit UI decisions, fail closed, exactly-once),
  `SessionManager` (lifecycle orchestration).
- `src/ide/` — `UriContext` (scheme/authority-preserving references),
  `DiffProvider` (native `vscode.diff` targets).
- `src/webview/` — `protocol.ts` (shared ext↔webview contract + strict
  validators), `state.ts` (pure reducer), `Conversation`, `Composer`,
  `ToolActivity`, `Approval`, `SessionPicker`, `main.ts` entry. Compiled as ES
  modules into `media/`, styled with VS Code theme tokens (`media/main.css`).
- `src/test/` — fake app-server + `node --test` protocol tests (no vscode API).

## Protocol provenance

Field shapes mirror the generated TypeScript at pinned
`UPSTREAM_SHA 639d2478cc2e16d6ca715952d2e726a3aecc024e`
(`codex-rs/app-server-protocol/schema/typescript/...`). Nothing is
hand-authored from memory: `npm run check-protocol-pin` gates the pin, and
`workbench/docs/vscode-feature-matrix.md` records live-vs-source status per
method, including drift observed against official codex-cli 0.155.1.

## Scripts

- `npm run typecheck` — `tsc --noEmit` (host + webview projects).
- `npm run lint` — no proprietary refs, no binaries, CSP/serializer present,
  innerHTML allowlist, no webview localhost shortcuts.
- `npm run test` — build, then `node --test` over fake-server protocol tests.
- `npm run package` — frontend-only VSIX via vsce (no binaries bundled).

## Backend discovery

Resolution happens on the extension host (remote-safe): explicit
`codexWorkbench.codexExecutablePath` (machine scope) → `codex-workbench` on
PATH → `codex` on PATH (official fallback, handshake-gated with a UI banner)
→ well-known install dirs. See `workbench/docs/vscode-backend-discovery.md`.
