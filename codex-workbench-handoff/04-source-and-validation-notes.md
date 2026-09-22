# Source anchors, validation status, and handoff notes

**This package contains a plan and coding-agent prompts, not implemented source, compiled binaries, or validated end-to-end integration.** All upstream paths must be resolved again against the commit selected by the coding agent.

## Verified inspection in this conversation

- Provided VSIX: `/mnt/data/anthropic.claude-code-2.1.278-win32-x64.vsix`; its `extension/package.json` identifies `claude-code` 2.1.278 and lists `claude-vscode.editor.open`, `.newConversation`, `.reopenClosedSession`, `.renameSessionTab`, `.addSessionTabToGroup`. It includes `extension/extension.js`, `extension/webview/index.js`, `extension/webview/index.css`, and a platform-specific bundled executable. String inspection finds `createWebviewPanel`, `registerWebviewPanelSerializer`, `onDidChangeActiveTextEditor` and `onDidChangeTextEditorSelection`. This is evidence of the broad packaged architecture, **not** a verified source-level behavioural specification or licence to copy bundled code.
- The user's screenshots visually establish conventional editor tabs and two side-by-side chat webviews, a separate image preview, an anchored composer, compact tool entries and VS Code theme integration.
- Official Codex TUI `McpToolCallCell::display_lines` calls `format_mcp_invocation`, and that function serializes `.arguments` to JSON; `raw_lines` also uses it. Test exactly which paths emit to terminal history before finalizing policy.
- Official App Server generated `ThreadResumeParams` notes that a running thread ID can rejoin a thread, while a non-running one is loaded from storage. **This does not imply a child process survives SSH disconnection.**
- Official package builder README specifies a canonical package with binary and supporting resources; npm staging has OS/architecture-specific packages.
- Official VS Code Remote Extension guidance establishes UI vs workspace extension hosts and that remote-webview `localhost` refers to a different machine; use extension-host message passing.

## Primary source URLs (read at the chosen SHA)

- https://github.com/openai/codex
- https://github.com/openai/codex/blob/main/codex-rs/tui/src/history_cell/mcp.rs
- https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol
- https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ThreadResumeParams.ts
- https://github.com/openai/codex/tree/main/codex-rs/app-server
- https://github.com/openai/codex/blob/main/codex-rs/app-server-test-client/README.md
- https://github.com/openai/codex/blob/main/scripts/codex_package/README.md
- https://github.com/openai/codex/blob/main/codex-cli/scripts/build_npm_package.py
- https://github.com/openai/codex/blob/main/codex-rs/scripts/setup-windows.ps1
- https://code.visualstudio.com/api/advanced-topics/remote-extensions
- https://code.visualstudio.com/api/extension-guides/webview

## Critical unknowns to resolve *through tests*, not assumptions

1. In the pinned TUI, where do original arguments/results leak into normal view, transcript, copies, logs, animations, reflow, and session replay?
2. Can one App Server reliably process two active threads and independent approvals through our chosen stdio client implementation?
3. Which auth, model, file, MCP/hosted Codex Apps and session features actually work in a non-official graphical client? Account-specific services may vary.
4. Can the release package (not just the raw compiled binary) preserve Windows sandbox and Linux helper behavior?
5. What exact process survival/recovery semantics apply to Remote SSH disconnection?
6. Do package licences and trademark requirements permit the chosen redistribution branding, license notices and npm names? Review before publishing.
7. What is the actual tested Ubuntu/Debian version floor, native library/dependency list, and CLI/VSIX install path behaviour?

## Recommended review passes after each coding-agent milestone

- **Safety/data:** args/results unchanged over execution; no secret echo in default preview, logs, CI artifacts or webview persistent state; approval fail-closed.
- **UX:** independent native editor tabs, small chrome, responsive widths, compact activity, intentional full-detail expansion, meaningful error visibility, focus and keyboard shortcuts.
- **Compatibility:** pinned upstream SHA, surface-level patch, generated protocol from same SHA, successful official-fallback handshake when supported, CLI independent of VSIX.
- **Operations:** Windows and Linux release-package smoke, actual npm pack/install, no collision with official Codex, Remote SSH remote execution, reproducible hashes and tagged manifests.

## Proposed commands for the human who owns the project

Use one coding agent in an isolated repo worktree with `02-agent-brief-cli.md`; separately use another worktree/agent with `03-agent-brief-vscode.md`, sharing the pinned base SHA and this specification. Require concrete commit IDs and test logs. Review Track A before making it the boss's default executable; review Track B before replacing the official extension in daily work. Keep official CLI/extension installed during the transition.
