# Codex Workbench — Architecture (fork scaffold)

- Upstream: `openai/codex` pinned at `639d2478cc2e16d6ca715952d2e726a3aecc024e` (see `workbench/UPSTREAM_SHA`).
- Fork: `Dacilla/codex-workbench-fork`. `upstream-main` tracks upstream without edits; `workbench/main` holds reviewed changes.
- Full spec: `codex-workbench-handoff/01-architecture-and-implementation.md`.
- Track A brief: `codex-workbench-handoff/02-agent-brief-cli.md`.
- Track B brief: `codex-workbench-handoff/03-agent-brief-vscode.md`.
- Sources/validation: `codex-workbench-handoff/04-source-and-validation-notes.md`.

## Layout (per spec)

- `codex-rs/` — upstream source; narrow Rust TUI patch only.
- `workbench/vscode/` — independent graphical VS Code extension (frontend-only VSIX initially).
- `workbench/packaging/` — CLI launcher/npm manifest/release checks.
- `workbench/docs/` — this file, verification-matrix.md, upstream-changes.md.
- `.github/workflows/workbench-ci.yml`, `workbench-release.yml` — TODO (M2/M5).

## Invariants

- No change to MCP arguments to change display; execution flow unchanged.
- No homemade agent/account/tool replacement; no Anthropic binary/frontend/proprietary source at runtime.
- CLI usable without VS Code; no mimic of official Codex GUI.
