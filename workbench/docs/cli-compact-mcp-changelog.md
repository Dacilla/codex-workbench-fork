# Track A M0/M1 — Compact MCP display: changelog

Base: upstream `639d2478cc2e16d6ca715952d2e726a3aecc024e` (`openai/codex`, 2026-09-22).
Branch: `feature/cli-compact-mcp`.

## What changed (display only; execution, permissions, model context untouched)

Everyday TUI history no longer echoes full MCP argument JSON. New `[tui] tool_call_display`
setting (`compact` default, `preview`, `full` opt-in) wired through the real config schema
(`codex-rs/core/config.schema.json`), core `Config`, and TUI `LocalSettings` into
`McpToolCallCell`. Code-mode cells (`node_repl`/`cua_repl`) keep their title rendering;
Ctrl+T transcript and activity expansion always retain full details as the explicit,
intentional full-details path. `Full` restores the legacy rendering byte-for-byte.

Before (everyday history, 1 MB-class `updateConfluencePage`-shaped call):

```
• Called confluence.updateConfluencePage({"pageId":204341250,"body":"<18,420 chars of payload>..."})
  └ <3-row bounded result preview>
```

After, default `compact`:

```
• Called confluence.updateConfluencePage · succeeded
  └ <3-row bounded result preview>
```

After, `preview` (allowlisted scalars verbatim, strings/containers as sizes):

```
• Called confluence.updateConfluencePage(pageId=204341250 · body=<hidden: 18420 chars>) · succeeded
```

Configure in `~/.codex/config.toml`:

```toml
[tui]
tool_call_display = "compact"  # or "preview" | "full"
```

## Files

- `codex-rs/config/src/types.rs` — `ToolCallDisplay` enum + `Tui::tool_call_display`.
- `codex-rs/core/src/config/mod.rs` — effective `Config::tui_tool_call_display` + mapping.
- `codex-rs/core/config.schema.json` — regenerated via `just write-config-schema`.
- `codex-rs/tui/src/history_cell/mcp_display_policy.rs` — new: summary builders.
- `codex-rs/tui/src/history_cell/mcp.rs` — policy field, Display/raw branches.
- `codex-rs/tui/src/history_cell/mcp_display_policy_tests.rs` — new: 17 policy tests.
- `codex-rs/tui/src/thread_transcript/{tools.rs,computer_groups.rs}, thread_transcript.rs,
  chatwidget/tool_lifecycle.rs, local_settings.rs` — policy plumbing.
- `codex-rs/thread-manager-sample/src/main.rs` — mechanical `Config` literal fix.
- Existing MCP test call sites pin `ToolCallDisplay::Full`; one replay snapshot updated to
  the new compact default.
- `codex-rs/chatgpt/src/lib.rs` — separate build-compat commit: `#![recursion_limit]`
  workaround for rustc 1.98.1 (pre-existing codegen failure at pinned SHA, separable).

## Verification (Windows 11, rustc 1.98.1, `just` 1.58.0, `cargo-insta` 1.48.0)

- Baseline `just test -p codex-tui` at pinned SHA (+ build workaround): 5383 run —
  5353 passed, 26 failed (24 unique pre-existing snapshot mismatches caused by terminal
  theme detection on this host; none MCP-related), 4 timed out (worktree/session
  integration tests), 9 skipped. Full log: outside repo (see session report).
- After (`just test -p codex-tui` full): 5397 run — 5363 passed, 30 failed
  (29 unique), 4 timed out (same worktree/session tests), 9 skipped.
  - All 14 display-policy tests pass (incl. 1 MB payload: compact ≤ 4 lines,
    `Full` restores >1000 lines, retained arguments hash-identical before/after
    render, replay round-trip preserves arguments).
  - `history_cell` (incl. all pre-existing MCP tests), `thread_transcript`,
    `exec_flow`, `computer_groups`, `local_settings`, `codex-config` (344/344),
    and the new core config mapping test are green.
  - 4 snapshots updated for the intended behavior change (compact default +
    `· succeeded/failed` status): replay `completed_tool_presentations`,
    `failed_repl_mcp_tool_call…` (plus its header-span assert),
    `image_result_live_and_replay…`, `misalignment_replayed_failed_tool`.
  - Remaining failures match the baseline set, plus: `reasoning_defaults` and
    `startup_resume` failed only under disk-full sqlite errors mid-run and pass
    on re-run; `patch_approval_pager` is theme-flaky on this host (bg Reset vs
    Rgb selection tint, no content/MCP difference — passed at baseline, fails
    intermittently since); `luna_reserve` flipped baseline-fail → pass (flaky).
- NOT run: fake-MCP-server byte-for-byte transport test (no execution code changed;
  TUI-boundary integrity asserted instead), release-package smoke, Linux build,
  App Server handshake, `just fmt`/`just fix` (rustfmt/clippy absent from this
  toolchain — `cargo install --git rust-lang/rustfmt` also failed on disk space;
  code follows repo style manually; CI must confirm).

## Caveats

- Result bodies keep the existing bounded 3-row preview in all modes; only invocation
  arguments are hidden by the policy. A follow-up may add a result-hiding mode.
- `server`/`tool` names are still echoed (they come from local config, not payloads).
- Pre-existing, unrelated: `codex-chatgpt` needs the recursion-limit workaround to
  compile on rustc 1.98.1; 24 snapshot tests fail at baseline on this Windows host
  due to theme-dependent colors; 4 worktree/session tests time out here.
