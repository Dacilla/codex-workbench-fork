# Upstream changes

- Base SHA: `639d2478cc2e16d6ca715952d2e726a3aecc024e` (`openai/codex` main, 2026-09-22).
- `upstream-main` branch: pristine upstream, no custom edits.
- `workbench/main` branch: reviewed workbench changes on top.
- Sync status (2026-09-23): upstream HEAD is `40eac3ce8a0c10cbcb9db910d529355eb2f8fc09`
  (13 commits ahead). Assessed, rebase DEFERRED with reasons: (1) this clone
  is shallow so no merge-base exists for a clean merge; a proper sync needs
  full history; (2) upstream touched `codex-rs/core/src/config/mod.rs`
  (46 lines) — our `tui_tool_call_display` mapping identifiers are untouched
  by their diff (verified by scan), but the rebase still needs hands-on
  conflict review + full re-verify on both OSes; (3) nothing in the drift
  changes our patch behavior, and our live backend (0.155.1) is already newer
  than both pins. Next sync is its own task: deepen history, rebase,
  regenerate protocol TS via the upstream generator, full CI gate.

## Patch list

- Track A M0/M1 (`feature/cli-compact-mcp`): compact MCP display policy.
  `[tui] tool_call_display = compact|preview|full` (default `compact`) hides full MCP
  argument JSON from everyday history; transcript/expansion keep full details;
  `full` restores legacy rendering. Display-only: no execution/permission/context
  change. See `workbench/docs/cli-compact-mcp-changelog.md` for files, rationale,
  and verification.
- Track B M0/M3 (`feature/vscode-appserver`, commit `2a736df`): independent
  graphical VS Code extension under `workbench/vscode/` (frontend-only VSIX,
  workspace extension host, pinned-protocol App Server client). No `codex-rs/`
  changes. See `workbench/docs/vscode-feature-matrix.md`,
  `vscode-backend-discovery.md`, `vscode-manual-tests.md`.
