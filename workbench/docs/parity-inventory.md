# Claude-Code / Codex feature-parity inventory (VS Code extension)

Date: 2026-09-23. Branch: `workbench/main`. Scope: **our** VS Code extension
(`workbench/vscode`, `codex-workbench` 0.1.0, 11 commands) vs the interaction
surface of two locally installed reference extensions plus our own pinned TUI.

Reference versions (local declarative metadata only — no proprietary code or
assets copied or shipped):

- Claude Code for VS Code `2.1.280` (`anthropic.claude-code-2.1.280-win32-x64`),
  31 commands, 3 views, 2 view containers, 9 keybindings, 20 config keys.
- Codex `26.5917.62051` (`openai.chatgpt-26.5917.62051-win32-x64`), 10 commands,
  2 views, 2 view containers, 1 keybinding, 8 config keys, plus
  `customEditors` (`chatgpt.conversationEditor` on `openai-codex:/**/*`),
  `chatSessions` provider (`openai-codex`), one language+grammar
  (`codex-rules`).
- Our TUI slash commands: `codex-rs/tui/src/slash_command.rs`
  (`SlashCommand::description` = one-line purpose, quoted below).
- Prior observation: `codex-workbench-handoff/04-source-and-validation-notes.md`
  (Claude VSIX 2.1.278 architecture notes).

Protocol citations are generated TS under
`codex-rs/app-server-protocol/schema/typescript/v2/`. `GUESS` = inferred
without a confirmed method. Status values: **have** / **partial** /
**missing-backed** (protocol shape exists, no client UI) / **needs-research**.

## Summary counts

| Status | Count |
|---|---|
| have | 18 |
| partial | 16 |
| missing-backed-by-protocol | 35 |
| missing-needs-research | 16 |
| not-applicable (terminal-only / divergent / ours-only scope notes) | 8 |
| total rows | 93 |

Counts cover the tables below (reference capabilities + TUI mirrors). Ours-only
items (reconnect backend, write-policy gate) are listed but excluded from
parity counts where noted.

## 1. Chat lifecycle (new / resume / close / reopen)

| Reference capability | What it does (one line) | Ours | Protocol backer | Size / blocker |
|---|---|---|---|---|
| Claude `editor.open` / `openLast` / `primaryEditor.open` / `window.open` / `sidebar.open` — open placements | Open a chat in a new editor tab, last tab, primary editor, new window, or sidebar | **partial** — `newChat` + `openChatBeside` cover editor-tab + beside; no sidebar, window, primary-editor placements | `ThreadStartParams.ts` | M; placement is local VS Code work, no protocol blocker |
| Claude `newConversation` | Start a fresh conversation | **have** — `newChat` | `ThreadStartParams.ts` | — |
| Codex `newCodexPanel` + `conversationEditor` (`openai-codex:/**/*`) | New agent backed by an editor-tab document | **have** — editor-tab panels (own URI scheme, not `openai-codex:`) | `ThreadStartParams.ts` | — |
| Claude `reopenClosedSession` (+ `ctrl+shift+t`) | Reopen the most recently closed session tab | **missing-backed** — bindings dropped on close by design | `ThreadResumeParams.ts` (threadId rejoin) + local binding retention | S |
| Claude `markSessionUnread` | Flag a session unread in the list | **needs-research** — local-only state; no protocol counterpart found | GUESS (local state) | S; needs list UI first |
| Panel close semantics | Close tab without destroying the thread | **have** — close drops binding, fails closed prompts, never deletes thread | — (local) | — |
| Window-reload restore | Restored session continues after reload | **partial** — serializer restores panel→thread bindings, metadata-only resume; interrupted turns reported honestly | `ThreadResumeParams.ts` | S to harden; cf. Claude `continueAfterReload` |
| TUI `/new` ("start a new chat during a conversation") | Same as newConversation | **have** | `ThreadStartParams.ts` | — |
| TUI `/clear` ("clear the terminal and start a new chat") | Clear + new chat | **partial** — new chat exists; no transcript-clear action | `ThreadStartParams.ts` | S (local) |
| TUI `/quit`, `/exit` ("exit Codex") | Quit the app | N/A (IDE client; no equiv needed) | — | — |

## 2. Input / composer (send, cancel, steer, queue, attachments, mentions)

| Reference capability | What it does (one line) | Ours | Protocol backer | Size / blocker |
|---|---|---|---|---|
| Composer send (both refs; Codex `followUpQueueMode`, `composerEnterBehavior`) | Send text, choose Enter vs Ctrl+Enter, queue-vs-steer follow-ups | **partial** — `composer/send` exists; no enter-behavior setting, no queue/steer choice | `TurnStartParams.ts`; `TurnSteerParams.ts`; `ThreadQueueChangedNotification.ts`, `QueuedSubmission.ts` | M; follow-up queue UI is the real work |
| Composer cancel / stop | Stop the running turn | **have** — `composer/cancel` → `turn/interrupt` | `TurnInterruptParams.ts` | — |
| TUI `/steer` equivalent (`turn/steer`) | Redirect the in-progress turn with new input | **missing-backed** | `TurnSteerParams.ts` | S (composer affordance + wire call) |
| Thread queue (`thread/queue/*`) | Queue submissions while busy | **missing-backed** | `ThreadQueueChangedNotification.ts`, `QueuedSubmission.ts` (methods in protocol enum list) | M; needs design (auto-queue vs explicit) |
| Codex `addToThread` / `addFileToThread` (editor context + tab menus) | Attach selection / file to the thread | **partial** — `attachSelection` command + `@`-mention rendering exist; no editor/tab context-menu entries, no file-attach command | `ThreadAttachmentAddParams.ts` (+ local excerpt path `ide/UriContext.ts`) | S/M; decide attachment-vs-excerpt story |
| Claude `insertAtMention` (`alt+k`) / `insertAtMentioned` | Insert `@`-file reference at cursor from the editor | **partial** — mention rendering in webview; no editor-side insert command or keybinding | GUESS (local VS Code work; attachments optional) | S |
| Claude `attachOpenFile` (config, default on) | Auto-include the open file in messages | **missing-backed** (effectively local) | GUESS — no protocol method needed; editor-state → message context | S; needs product decision (default on/off) |
| TUI `/mention` ("mention a file") | Same as above, CLI-side | **partial** (as above) | `ThreadAttachmentAddParams.ts` | S |
| TUI `/ide` ("include current selection, open files, and other context from your IDE") | Bulk IDE context attach | **missing-backed** | `ThreadAttachmentAddParams.ts`, `ThreadInjectItemsParams.ts` | M |
| Codex `reviewDelivery: inline` vs separate chat | `/review` starts inline when possible | **missing-backed** | `ReviewStartParams.ts`, `ReviewStartResponse.ts` (+ `ReviewDelivery.ts`) | M; feeds review-start build |
| TUI `/diff` ("show git diff (including untracked files)") | Show working-tree diff | **partial** — completed file-change items open in native diff; no general git-diff view | GUESS (local git; no protocol method confirmed) | S/M |

## 3. Approvals (commands, files, permissions, questions, MCP)

| Reference capability | What it does (one line) | Ours | Protocol backer | Size / blocker |
|---|---|---|---|---|
| Exec / command approval card (approve/deny) | Approve or deny a shell command | **have** — card + fail-closed decline | `CommandExecutionRequestApprovalParams.ts` (method `item/commandExecution/requestApproval`) | — |
| File-change approval card | Approve or deny a proposed edit | **have** — card + fail-closed decline | `FileChangeRequestApprovalParams.ts` | — |
| Permissions approval (grant profiles) | Grant a permission profile for a scope | **partial** — deny-only by design ("grant profiles aren't supported in this client yet") | `PermissionsRequestApprovalParams.ts`, `PermissionProfileListParams.ts` | M; needs profile picker + scope UX |
| Question tool (`item/tool/requestUserInput`) | Answer model questions inline (radios/secret/free-text) | **have** — per-question Answer + Deny, bounded, fallback deny-only | `ToolRequestUserInputParams.ts` | — |
| MCP elicitation (`mcpServer/elicitation/request`) | Answer a tool's schema-prompted questions | **have** — approve/deny card | `McpServerElicitationRequestParams.ts` | — |
| TUI `/approve` ("approve one retry of a recent auto-review denial") | One-shot retry approval | **missing-backed** | `ThreadApproveGuardianDeniedActionParams.ts` (GUESS — name suggests this flow; not confirmed) | S/M; confirm method semantics first |
| Claude `initialPermissionMode` / `allowDangerouslySkipPermissions` | Default permission posture + bypass mode | **partial** — `approvalPolicy` setting (`untrusted/on-failure/on-request/never`) sent on start; no bypass mode (intentionally) | `ThreadStartParams.ts` (+ `SandboxPolicy.ts`, `AskForApproval.ts`) | S for mode presets; bypass stays out |
| TUI `/permissions` ("choose what Codex is allowed to do") | Interactive permission picker | **partial** (as above) | `PermissionProfileListParams.ts`, `ConfigReadParams.ts` | M |

## 4. Models / modes (pickers, Plan, tiers)

| Reference capability | What it does (one line) | Ours | Protocol backer | Size / blocker |
|---|---|---|---|---|
| Model + reasoning-effort picker | Choose model/effort per thread | **have** — `selectModel`/`selectEffort`, per-thread pins forwarded on `turn/start` | `ModelListParams.ts`, `ModelListResponse.ts`, `TurnStartParams.ts`, `ReasoningEffortOption.ts` | — |
| Collaboration mode toggle (Default/Plan) | Enable the model-side question tool | **have** — `selectMode`, experimental `thread/settings/update` | `ThreadSettings.ts` (via `thread/settings/update`) | — (live-backend acceptance UNTESTED) |
| TUI `/model` ("choose what model and reasoning effort to use") | Same, CLI-side | **have** | as above | — |
| TUI `/plan` ("switch to Plan mode") | Same, CLI-side | **have** | as above | — |
| Service-tier / routing display (`modelProvider/capabilities/read`, reroute notices) | Show tier/routing state | **missing-backed** | `ModelProviderCapabilitiesReadParams.ts`, `ModelReroutedNotification.ts`, `ModelServiceTier.ts` | S (header segment + notice) |
| TUI `/status` ("show current session configuration and token usage") | Session config + usage readout | **missing-backed** | `ConfigReadParams.ts`, `ThreadTokenUsageUpdatedNotification.ts` | S |
| TUI `/debugConfig` ("show config layers and requirement sources") | Config-layer debugging | **missing-backed** | `ConfigReadParams.ts`, `ConfigLayer.ts` | S |

## 5. MCP / skills / hooks / plugins / apps

| Reference capability | What it does (one line) | Ours | Protocol backer | Size / blocker |
|---|---|---|---|---|
| MCP server status + tool calls display | Show which MCP servers/tools are live | **missing-backed** — tool-call progress renders; no server-status surface | `ListMcpServerStatusParams.ts`, `McpServerStatusUpdatedNotification.ts`, `McpServerToolCallParams.ts` | S/M |
| TUI `/mcp` ("list configured MCP tools; use /mcp verbose for details") | Same, CLI-side | **missing-backed** (as above) | as above | S |
| TUI `/skills` ("use skills to improve how Codex performs specific tasks") | Browse/use skills | **missing-backed** — shapes read, no UI | `SkillsListParams.ts`, `SkillsListResponse.ts`, `SkillSummary.ts` | S (read-only list first) |
| TUI `/hooks` ("view and manage lifecycle hooks") | View/manage lifecycle hooks | **missing-backed** — no client paths | `HooksListParams.ts`, `HooksListResponse.ts` | M (management writes need care) |
| Claude `installPlugin` | Install a plugin | **missing-backed** — no client paths | `PluginInstallParams.ts`, `PluginListParams.ts` | M; low priority |
| TUI `/plugins`, `/apps` ("browse plugins", "manage apps") | Browse/manage | **missing-backed** — no client paths | `PluginListParams.ts`, `AppsListParams.ts` | M/L; low priority |
| Codex `showLspMcpCliArgs` (copy CLI args for LSP MCP) | Copy args to wire the CLI as an MCP server | **needs-research** — local-only helper; construction unknown | GUESS (local; needs CLI flag research) | S |
| TUI `/memories` ("configure memory use and generation") | Memory settings | **needs-research** | `memory/status` seen in method list; no generated TS confirmed here | S/M after method check |

## 6. Sessions / history (list, search, archive, fork, compact, revert)

| Reference capability | What it does (one line) | Ours | Protocol backer | Size / blocker |
|---|---|---|---|---|
| Claude sessions-list view (`claudeVSCodeSessionsList`) | Browse past sessions in a sidebar | **partial** — `resumeChat` QuickPick over paginated `thread/list`; no dedicated view | `ThreadListParams.ts`, `ThreadListResponse.ts` | M (view TBD by placement decision) |
| Codex `chatSessions` provider (`openai-codex`) + `newSession` menu | Native session switcher integration | **needs-research** — proposed API surface; adoption cost unknown | GUESS (VS Code API, not App Server) | M; research API stability first |
| TUI `/resume` ("resume a saved chat") | Same, CLI-side | **have** | `ThreadResumeParams.ts` | — |
| Thread search | Find threads by query | **missing-backed** | `thread/search` (method confirmed in protocol enum; `ThreadSearchResult.ts`, `ThreadSearchSortKey.ts`) | S/M (needs search UI) |
| Archive / unarchive | Shelve a session out of the active list | **missing-backed** | `ThreadArchiveParams.ts`, `ThreadUnarchiveParams.ts` (+ `ThreadArchivedNotification.ts`, `ThreadUnarchivedNotification.ts`) | S |
| Delete thread | Permanently remove a session | **missing-backed** | `ThreadDeleteParams.ts` (+ `ThreadDeletedNotification.ts`) | S (confirm UX guard) |
| Fork thread | Branch a session from a point | **missing-backed** | `ThreadForkParams.ts`, `ThreadForkResponse.ts` | S |
| Compact thread | Summarize to survive context limits | **missing-backed** | `ThreadCompactStartParams.ts`, `ThreadCompactStartResponse.ts` (+ `ContextCompactedNotification.ts`) | S/M (progress UX) |
| Revert thread | Roll a thread back to an earlier state | **missing-backed** | `ThreadRevertParams.ts` (+ `ThreadRevertedNotification.ts`) | M (destructive; needs confirm UX) |
| TUI `/archive`, `/delete`, `/fork`, `/compact`, `/recap`, `/rename` | Same six, CLI-side | **missing-backed** except rename (**have** via `thread/name/set`) | as above; recap GUESS (no method confirmed — likely local summarize or compact variant) | S–M each |
| Rename tab (both refs) | Rename the session tab | **have** — `renameTab` | `ThreadSetNameParams.ts` (+ `ThreadNameUpdatedNotification.ts`) | — |
| TUI `/export` ("export the conversation as markdown") | Dump transcript to markdown | **missing-backed** (local-only) | GUESS — `ThreadItemsListParams.ts` pagination as the source | S |
| TUI `/rollout` (debug-only, "print the rollout file path") | Locate the session file | N/A (debug-only in TUI) | — | — |

## 7. Diffs / files (review, hunk decisions, CodeLens)

| Reference capability | What it does (one line) | Ours | Protocol backer | Size / blocker |
|---|---|---|---|---|
| Claude accept/reject proposed diff + hunk (editor title, context, comment-bar) | Accept whole diff or per-hunk from editor chrome | **partial** — completed file changes open in native `vscode.diff`; no accept/reject wiring (approval card is the decision point) | GUESS for hunk-level: no hunk method confirmed; whole-change decision rides the file-change approval response | M; needs protocol check before promising hunk granularity |
| Codex `reviewDelivery` + `/review` flow (`review/start`) | Review current changes, inline or separate chat | **missing-backed** | `ReviewStartParams.ts`, `ReviewStartResponse.ts` | M |
| TUI `/review` ("review my current changes and find issues") | Same, CLI-side | **missing-backed** (as above) | as above | M |
| Codex `implementTodo` CodeLens (`commentCodeLensEnabled`) | One-click "implement this TODO with Codex" | **needs-research** — CodeLens + turn bootstrap flow unknown | GUESS (`TurnStartParams.ts` + local CodeLens provider) | M; needs runtime study of official flow |
| `fs/*` direct manipulation | Read/write/watch workspace files via server | intentionally out (IDE owns files) | `FsReadFileParams.ts`, `FsWriteFileParams.ts`, etc. | — (no build planned) |
| TUI `/init` ("create an AGENTS.md file with instructions for Codex") | Scaffold repo instructions | **needs-research** — file-write + instruction-source flow | GUESS (`FsWriteFileParams.ts` or local write; `NewThreadModelDefaults.ts`?) | S/M; product decision |

## 8. IDE integration (menus, keybindings, sidebar, onboarding, terminal)

| Reference capability | What it does (one line) | Ours | Protocol backer | Size / blocker |
|---|---|---|---|---|
| Editor context / title menus (both refs) | Chat actions from right-click / title bar | **missing-backed** (local-only) | — (VS Code menus, no protocol) | S (attach + new-chat entries) |
| Keybindings (Claude 9, Codex 1) | Focus input, open chat, new conversation, reopen session, @-mention | **missing-backed** (local-only; zero keybindings shipped) | — | S; needs product sign-off on chords |
| Sidebar + secondary-sidebar views (both refs) | Chat in the side bar instead of editor tabs | intentionally divergent — editor-tab-first; no sidebar view | — | M if ever wanted; architecture decision |
| Claude walkthrough / Codex NUX (`dumpNuxState`/`resetNuxState` are debug) | First-run onboarding checklist | **needs-research** — trigger/state shapes unknown at runtime | GUESS (local webview content) | S/M; needs runtime observation |
| Claude `terminal.open` / `useTerminal` (+ Codex `command/exec`, `process/*`) | Run the agent in a terminal/PTY instead of native UI | **needs-research** — PTY hosting is a big build; no decision | `CommandExecParams.ts`, `process/spawn` family | L; explicit decision required |
| Claude `focus` / `blur` / `focusLastMessage` / `toggleFocusView` + `focusView` config | Keyboard focus control + activity-folding focus mode | **needs-research** — focus commands are local; focus-view ≈ collapsible tool cards | GUESS (local; ours already collapses tool activity) | S/M |
| Claude `lockEditorGroups`, `scrollToBottomOnSend`, `useCtrlEnterToSend`, `autosave`, `respectGitIgnore` | Editor-behavior tuning knobs | **needs-research** — each is local; none confirmed needed | GUESS (local settings) | S each; pick individually |
| Claude `createWorktree` / TUI `/worktree` | Start/continue conversation in a new worktree | **needs-research** — backend worktree support unknown | GUESS (no method confirmed) | L; blocked on protocol research |
| Claude `addSessionTabToGroup` | Group session tabs | **needs-research** — grouping model unknown (local groups vs `threadSection/*`?) | GUESS (`ThreadSectionCreateParams.ts` exists — unconfirmed relation) | M after research |
| TUI `/side`, `/btw` ("start a side conversation in an ephemeral fork") | Ephemeral fork for a quick question | **missing-backed** | `ThreadForkParams.ts` (GUESS — fork-then-drop; ephemeral semantics unconfirmed) | M |
| TUI `/agents`, `/subagents` ("agent command center", "switch between subagents") | Multi-agent oversight | **needs-research** | `CollabAgentState.ts`, `CollabAgentStatus.ts` seen; UI flow unknown | M/L after research |
| TUI `/goal` ("set or view the goal for a long-running task") | Long-task goal tracking | **missing-backed** | `ThreadGoalSetParams.ts`, `ThreadGoalGetParams.ts` | S/M |
| TUI `/daemon` ("Manage the local background server") | Background server control | N/A (extension host manages the backend process) | — | — |
| TUI `/cd`, `/pwd` | Change/show working directory | **partial** — cwd shown/pinned per thread; no mid-thread `cd` | `ThreadShellCommandParams.ts`? GUESS for cd; `ThreadEnvironment.ts` for display | S/M; `cd` mid-thread needs semantics check |
| TUI `/ps`, `/stop` ("list/stop background terminals") | Background terminal management | **missing-backed** | `ThreadBackgroundTerminals*` (methods `thread/backgroundTerminals/list|clean|terminate` confirmed in enum; no TS individually verified here) | M |
| TUI `/voice` ("start or stop voice") | Realtime voice session | **needs-research** | `ThreadRealtimeStartTransport.ts`, `thread/realtime/*` family | L; explicit decision required |
| TUI `/app` ("continue this session in the Desktop app") | Hand off to desktop app | N/A (no desktop app in scope) | — | — |
| TUI `/import` ("import setup, this project, and recent chats from Claude Code") | Migrate Claude state in | **needs-research** | `ExternalAgentConfigImportParams.ts` family (GUESS — names suggest exactly this) | M after research |
| TUI `/experimental` ("toggle experimental features") | Flip experimental flags | **missing-backed** | `ExperimentalFeatureListParams.ts`, `ExperimentalFeatureEnablementSetParams.ts` | S |
| TUI `/setup-default-sandbox` ("set up elevated agent sandbox") | Elevated sandbox setup | **needs-research** (platform-specific; Windows sandbox readiness exists) | `WindowsSandboxSetupStartParams.ts` (GUESS) | M; platform-gated |
| TUI `/keymap`, `/vim`, `/tui`, `/theme`, `/title`, `/pets` | Terminal-chrome preferences | N/A (terminal-only concerns) | — | — |

## 9. Status / usage visibility (accounts, limits, diagnostics)

| Reference capability | What it does (one line) | Ours | Protocol backer | Size / blocker |
|---|---|---|---|---|
| Account / rate-limit surfaces | Show plan, limits, resets, token usage | **missing-backed** — notifications observed, no UI | `GetAccountRateLimitsResponse.ts`, `RateLimitSnapshot.ts`, `AccountTokenUsageSummary.ts`, `ThreadTokenUsageUpdatedNotification.ts`, `AccountRateLimitsUpdatedNotification.ts` | S (header/readout first) |
| TUI `/usage` ("view account usage or use a usage limit reset") | Same, CLI-side | **missing-backed** (as above) | `GetAccountTokenUsageParams.ts` (method `account/usage/read`), `ConsumeAccountRateLimitResetCreditParams.ts` (GUESS — filename inferred, not verified) | S/M |
| TUI `/warnings` ("view retained warnings and diagnostic details") | Surfaced diagnostics | **partial** — errors shown per-panel; no retained-warnings view | `WarningNotification.ts`, `ErrorNotification.ts` | S |
| Claude `showLogs` | Open extension logs | **have** — `showLogs` | — (local) | — |
| `server/diagnostics` | Backend process diagnostics | **missing-backed** | `ServerDiagnosticsProcess.ts` (GUESS — type verified, method wiring not) | S |
| Auth status display (login state, not the flow) | Show signed-in account | **partial** — `account/updated` surfaced; no account readout | `Account.ts`, `GetAccountResponse.ts` | S |

## 10. Installation / distribution (backend discovery, login, updates)

| Reference capability | What it does (one line) | Ours | Protocol backer | Size / blocker |
|---|---|---|---|---|
| Backend discovery + version pin + write gate | Use a known-good backend, fail closed otherwise | **have** (ours-only; stricter than either ref) — discovery, compat list, session-only override | `ProtocolVersion.ts` (local) | — |
| Login / logout flows (Claude `logout`, TUI `/logout`, Codex auth) | Sign in/out from the IDE | **missing-backed** with caution | `LoginAccountParams.ts`, `LogoutAccountResponse.ts` (methods `account/login/start`, `account/logout`) | M; **blocked**: account-specific behavior in a non-official client is unverified (handoff unknown #3); needs opt-in live testing, never ship blind |
| Claude `update` (self-update when supported) | Update the extension/backend | N/A (VSIX distribution story is ours to define) | — | — |
| Codex `cliExecutable` override + WSL runner | Point at a dev CLI / run under WSL | **partial** — machine-scoped executable path + discovery; no WSL runner | — (local process mgmt) | M for WSL; needs Windows testing |
| Codex `openOnStartup` | Focus sidebar on startup | **missing-backed** (local-only; trivial) | — | S; product decision |
| Untrusted-workspace guard | Refuse to run in untrusted workspaces | **have** (ours-only; `untrustedWorkspaces: false`) | — | — |

## Recommended build order (missing-backed items only)

Ordered by value ÷ size, respecting dependencies (list UI before per-thread
management actions that need it):

1. **Fork thread** (`ThreadForkParams.ts`) — S. Unlocks side-conversation and
   safe-experiment flows; no dependencies.
2. **Archive / unarchive / delete** (`ThreadArchiveParams.ts`,
   `ThreadUnarchiveParams.ts`, `ThreadDeleteParams.ts`) — S. Session hygiene
   both references have; pairs with #4.
3. **Compact** (`ThreadCompactStartParams.ts`) — S/M. Context-limit survival;
   highest value-per-line of the TUI mirrors.
4. **Thread search + sessions-list affordance** (`thread/search`,
   `ThreadSearchResult.ts`, existing `ThreadListResponse.ts` pagination) — S/M.
   Makes 1–3 usable at scale; QuickPick first, view later.
5. **Usage / rate-limit / token-usage readout**
   (`GetAccountRateLimitsResponse.ts`, `ThreadTokenUsageUpdatedNotification.ts`,
   `AccountTokenUsageSummary.ts`) — S. Visibility users ask for first; feeds
   the `/status` + `/usage` mirrors.
6. **Review start** (`ReviewStartParams.ts`) — M. Flagship Codex flow
   (`reviewDelivery` inline-vs-separate decision included).
7. **Attachments add/list/remove** (`ThreadAttachmentAddParams.ts`) — M.
   Completes `attachSelection` into a real file-context story.
8. **Steer + queue follow-ups** (`TurnSteerParams.ts`,
   `ThreadQueueChangedNotification.ts`) — M. Needs composer UX design; do
   after interrupt path (have) is live-tested.
9. **Revert** (`ThreadRevertParams.ts`) — M. Destructive; ship after archive
   (recovery story) with confirm UX.
10. **Skills / MCP status read-only** (`SkillsListParams.ts`,
    `ListMcpServerStatusParams.ts`) — S. Display before any management writes.
11. **Goal set/get** (`ThreadGoalSetParams.ts`, `ThreadGoalGetParams.ts`) — S/M.
12. **Status/config readout** (`ConfigReadParams.ts`) — S. `/status` +
    `/debugConfig` mirrors, cheap.
13. **Editor menus + keybindings** (local-only) — S. Attach/new-chat context
    entries; chords need sign-off.
14. **Reopen-closed-session + export markdown** (local-only, `ThreadResumeParams.ts`
    / `ThreadItemsListParams.ts` as sources) — S each.

Explicitly **not** in the build order (need research or a product decision
first): login/logout live behavior, voice/realtime, terminal/PTY hosting,
worktree backend support, `chatSessions` provider adoption, CodeLens TODO
flow, sidebar views, hunk-level diff decisions, plugin/app/marketplace
management, sandbox elevation.

## What could NOT be determined (honest limits)

- **Runtime-only behaviors.** Streaming deltas, focus/keyboard feel, NUX and
  walkthrough triggers, sidebar session-list state, unread badges, grouping,
  onboarding checklists, and error copy are visible only with the extensions
  running. Manifests declare the surface, not the behavior.
- **Proprietary flows.** Auth token handling, account-specific services
  (hosted apps, billing-adjacent usage/reset), update mechanics, bundled-CLI
  argument construction (`showLspMcpCliArgs`), and terminal-integration details
  cannot be derived from `package.json` and were not reverse-engineered.
- **Method↔UI bindings.** A protocol method existing (e.g.
  `thread/backgroundTerminals/*`, `threadSection/*`, question-tool flows)
  does not confirm which reference UI triggers it or with what payloads.
  `GUESS` rows mark exactly these.
- **Version drift.** References (Claude 2.1.280, Codex 26.5917.62051) are
  newer than the pinned upstream SHA; the feature matrix already records
  `thread/resume` drift on the official backend. Re-verify each backer method
  against the pinned schema at build time.
- **TUI dispatch ≠ protocol.** Slash-command descriptions say what the CLI
  does, not which App Server method backs it; several mappings above
  (`/recap`, `/side`, `/approve`, `/init`) are inferences.
- **Counts are surface rows, not effort.** Sizes are rough (S <1d, M days,
  L week+) and exclude testing against live backends, which the verification
  matrix shows is the long pole.
