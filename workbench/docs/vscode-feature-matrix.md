# Track B feature matrix — App Server protocol (M0+M3 slice)

Pinned SHA: `639d2478cc2e16d6ca715952d2e726a3aecc024e`
Extension branch: `feature/vscode-appserver`
Date: 2026-09-22. Host: Windows 11 x64, VS Code local (no Remote SSH yet).

Statuses: **LIVE-FAKE** = exercised against the in-repo fake over real stdio
(`npm run test`, 43 tests); **LIVE-OFFICIAL** = observed against installed
official `codex-cli 0.155.1` via throwaway NDJSON probes (read-only except
where noted; that binary is NEWER than the pinned SHA, so drift notes are
expected); **SOURCE** = verified in pinned Rust source / generated TS but not
executed; **UNTESTED** = not verified at all.

## Transport (LIVE-FAKE + LIVE-OFFICIAL)

- Framing is newline-delimited JSON, one message per line, no
  `jsonrpc: "2.0"` field (`codex-rs/app-server-protocol/src/rpc.rs`: "We do
  not do true JSON-RPC 2.0"). Confirmed live: official binary accepts
  messages with and without the field; canonical client form omits it.
- Request ids: UUID strings (test client `request_id()`); client accepts
  string|number ids on inbound traffic.
- `initialize` → `{ userAgent, codexHome, platformFamily, platformOs }`
  (LIVE-OFFICIAL exact keys; matches pinned `InitializeResponse`).
  Followed by client `initialized` notification (method only, no params).
- Unsolicited globals observed live: `configWarning`,
  `remoteControl/status/changed`, `account/updated` — all WITHOUT `threadId`,
  all carrying `emittedAtMs`. The router broadcasts these; thread attribution
  never guesses.

## Threads (LIVE-FAKE + LIVE-OFFICIAL for reads)

| Method | Pinned params | Observed | Status |
|---|---|---|---|
| `thread/start` | all-optional overrides (model, cwd, approvalPolicy, sandbox, …) | `{thread, model, modelProvider, serviceTier, disabledPluginIds, cwd, instructionSources, approvalPolicy, approvalsReviewer, sandbox, reasoningEffort}` | LIVE-FAKE |
| `thread/resume` | `{threadId, …overrides, excludeTurns?}` | metadata + `turnsBackwardsCursor`, `itemsBackwardsCursor` | LIVE-FAKE + LIVE-OFFICIAL |
| `thread/list` | `{cursor?, limit?, sortKey?, sortDirection?, …}` cursor pagination | `{data, nextCursor, backwardsCursor}`; Thread has `historyMode: "paginated"`, `status: {type}`, `originator`, `source` | LIVE-OFFICIAL |
| `thread/turns/list` | `{threadId, cursor?, limit?, sortDirection?, itemsView?}` | `{data: Turn[], nextCursor, backwardsCursor}`; resume cursor used with `sortDirection: "desc"` | LIVE-OFFICIAL |
| `thread/items/list` | `{threadId, turnId?, cursor?, limit?, sortDirection?}` (default ascending) | `{data: [{turnId, item}], …}`; `ThreadItem` union (`userMessage`/`agentMessage`/`commandExecution`/…) | LIVE-OFFICIAL |
| `thread/read` | `{threadId, includeTurns?}` (full hydration deprecated) | not used by client (uses paginated reads instead) | SOURCE |

### Drift warning (LIVE-OFFICIAL vs pinned schema)

Official 0.155.1 `thread/resume` returns keys ABSENT from the pinned
`ThreadResumeResponse`: `runtimeWorkspaceRoots`, `activePermissionProfile`,
`multiAgentMode`, `initialTurnsPage`; and OMITS pinned `collaborationMode`.
The client therefore decodes tolerantly (required fields checked, extras
ignored). Exact-shape decoding would break on every server upgrade.

## Turns (LIVE-FAKE; live model turn UNTESTED)

| Method / event | Pinned shape | Status |
|---|---|---|
| `turn/start` | `{threadId, input: UserInput[], …overrides}` → `{turn}`; text input is `{type: "text", text, text_elements: []}` | LIVE-FAKE; real model turn UNTESTED (needs auth + quota; opt-in steps in `vscode-manual-tests.md`) |
| `turn/steer`, `turn/interrupt` | `{threadId, turnId}` / `{threadId, input}` | interrupt LIVE-FAKE; steer SOURCE |
| `turn/started`, `turn/completed` | `{threadId, turn}`; `Turn.status`: completed\|interrupted\|failed\|inProgress | LIVE-FAKE |
| `item/started`, `item/completed` | `{threadId, turnId, item, startedAtMs/completedAtMs}` | LIVE-FAKE (item kinds) |
| `item/agentMessage/delta` | `{threadId, turnId, itemId, delta}` | LIVE-FAKE |

## Approvals (LIVE-FAKE incl. fail-closed; live interactive UNTESTED)

Server→client requests (pinned `ServerRequest` union), all carrying
`threadId` (+`turnId`, `itemId`) except v1 which uses `conversationId`:

| Method | Response | Fail-closed default (tested) |
|---|---|---|
| `item/commandExecution/requestApproval` | `{decision: accept\|…\|decline\|cancel}` | `{decision: "decline"}` |
| `item/fileChange/requestApproval` | `{decision: …}` | `{decision: "decline"}` |
| `item/permissions/requestApproval` | `{permissions, scope}` | `{permissions: {}, scope: "turn"}` |
| `item/tool/requestUserInput` | `{answers: {qid: {answers: []}}}` | `{answers: {}}` |
| `mcpServer/elicitation/request` | `{action, content, _meta}` | `{action: "cancel", content: null, _meta: null}` |
| `item/tool/call` (dynamic tool) | `{contentItems, success}` | `{success: false, …}` — no handler, never executes |
| `applyPatchApproval`, `execCommandApproval` (v1) | `{decision: ReviewDecision}` | `{decision: {denied: …}}` |

Live interactive approval against a real backend is UNTESTED (needs a model
turn that requests approval; opt-in steps provided). Decision timeout,
double-send rejection, orphaned-prompt decline, and crash settlement are
LIVE-FAKE.

VS Code approval-card support per kind (unit-tested validator/reducer/render;
live interactive click-through UNTESTED for every kind):

| Kind | Card offers | Notes |
|---|---|---|
| `commandExecution`, `fileChange`, `applyPatchApproval`, `execCommandApproval`, `elicitation` | Approve / Deny | unchanged; existing `approveResult` shapes |
| `permissions` | Deny only ("grant profiles aren't supported in this client yet") | Approve would fail closed into a silent deny, so no Approve button |
| `item/tool/call` (dynamic tool), unknown | Deny only ("unsupported request type") | never executes; unknown has no safe wire shape |
| `item/tool/requestUserInput` | Per-question Answer + Deny | radios / password for `isSecret` / free text for `isOther`; answers ride `approval/answer` → `decideApproval(approved: true, result: {answers})` bounded to ≤20 questions, values ≤4 KiB; empty/malformed question lists fall back to Deny-only (no fabricated answers) |

## Models / account (LIVE-OFFICIAL read-only)

- `model/list` `{}` → `{data: [{id, model, displayName, …, supportedReasoningEfforts}]}` (LIVE-OFFICIAL).
- Extension model/effort picker (`codexWorkbench.selectModel`,
  `codexWorkbench.selectEffort`): per-thread pins forwarded on `turn/start`
  only when set (keys absent otherwise), inherited by new threads,
  `ext/model` header segment (`model: <displayName|id|default>[ · effort]`,
  never "unknown") — LIVE-FAKE (fake catalog over real stdio) for
  forwarding/inheritance/reducer/validation; real-catalog values + Host
  rendering UNTESTED (manual steps in `vscode-manual-tests.md` §5).
- `getAuthStatus` `{includeToken, refreshToken}` → `{authMethod: "chatgpt", authToken: null, requiresOpenaiAuth: true}` (LIVE-OFFICIAL, token not requested).
- `modelProvider/capabilities/read` → `{namespaceTools, imageGeneration, webSearch}` (LIVE-OFFICIAL).
- `account/login/*`, `account/logout`, connected Codex Apps / hosted
  integrations: SOURCE only — **no parity claimed** with the official
  extension (spec 4.3 high-risk item). The client surfaces `account/updated`
  notifications but does not implement login flows.

## Collaboration mode (question-tool toggle)

- `codexWorkbench.selectMode` QuickPick (`Default` / `Plan`) per focused
  thread: Plan enables the model-side question tool
  (`item/tool/requestUserInput`; `allows_request_user_input()` is true only
  for `Plan` in pinned `codex-rs/protocol/src/config_types.rs`), Default
  does not. One-line descriptions in the picker state exactly this.
- Applied post-start via experimental `thread/settings/update` with
  `{threadId, collaborationMode: {mode, settings: {model, reasoning_effort,
  developer_instructions: null}}}` (outer camelCase, `settings` snake_case
  per pinned `Settings`; `null` instructions = built-in preset). Only the
  `collaborationMode` key is sent. `thread/start` itself is unchanged — it
  has no mode slot (verified in generated `ThreadStartParams.ts`).
- `settings.model`/`reasoning_effort` echo the thread's current values
  (explicit option → user pin → backend-reported) because a
  `Some(collaboration_mode)` REPLACES mode+settings server-side; blanks
  would clobber model/effort pins. Unknown model → honest throw, never an
  empty send. Local mode records only after transport success; rejections
  leave header + registry untouched.
- EXPERIMENTAL: the whole method requires the `experimentalApi` handshake
  capability (variant-level `#[experimental("thread/settings/update")]` in
  `common.rs` wins over field-level gating; the server rejects otherwise).
  The client now handshakes with `experimentalApi: true` (opt-in permits
  methods; stable behavior unchanged).
- Header appends `· mode: <plan|default>` via the existing `ext/model`
  event (optional `mode` field; absent = keep current; never "unknown").
  New threads inherit the last chosen mode (applied post-start; on failure
  the thread stays honestly `default`); mode persists in panel bindings
  only when non-default; restore is local-only (resume is expected to echo
  the persisted `collaborationMode`).
- Status: LIVE-FAKE (request shape incl. echo-back, fail-closed paths,
  registry inheritance/persistence, reducer + segment, handshake flag —
  `npm test` → "mode payload", "mode validation", "ThreadRegistry
  collaboration modes", "ext/model mode header state", "experimental
  handshake flag"). UNTESTED live: official-backend acceptance of
  `thread/settings/update` with `collaborationMode` (incl. the
  experimental gate on a non-fake server), a real Plan-mode question round
  trip, Extension Host rendering of the segment/QuickPick, window-reload
  mode restore vs resume echo, and any billed turn under Plan mode.

## Unsupported / deferred in this slice

- `thread/realtime/*` (voice), `command/exec*` PTY hosting, `fs/*` direct
  manipulation, `review/start`, plugin/marketplace/skill writes: SOURCE (shapes
  exist) but no client code paths; calling them returns honest backend errors.
- Multi-App-Server isolation: single-server hypothesis holds under fake
  concurrency tests; real-backend concurrency (two simultaneous model turns +
  simultaneous approvals) is UNTESTED — the documented trigger for revisiting
  isolation strategy.
- Remote SSH end-to-end, local Linux smoke, VS Code webview rendering: manual,
  see `vscode-manual-tests.md`.
