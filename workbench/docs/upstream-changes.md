# Upstream changes

- Base SHA: `639d2478cc2e16d6ca715952d2e726a3aecc024e` (`openai/codex` main, 2026-09-22).
- `upstream-main` branch: pristine upstream, no custom edits.
- `workbench/main` branch: reviewed workbench changes on top.

## Patch list

- Track A M0/M1 (`feature/cli-compact-mcp`): compact MCP display policy.
  `[tui] tool_call_display = compact|preview|full` (default `compact`) hides full MCP
  argument JSON from everyday history; transcript/expansion keep full details;
  `full` restores legacy rendering. Display-only: no execution/permission/context
  change. See `workbench/docs/cli-compact-mcp-changelog.md` for files, rationale,
  and verification. (Track B extension work is listed separately when merged.)
