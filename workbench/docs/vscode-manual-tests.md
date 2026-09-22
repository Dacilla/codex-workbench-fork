# Track B manual verification steps (M3 slice)

Environment template — copy per run: OS + version / VS Code version /
backend (`codex-workbench` SHA or official version) / commit SHA / log location.

## 1. Two sessions beside a code file (local)

1. Open a workspace, open any source file in group 1.
2. `Codex Workbench: New Chat in Editor Tab` → chat A (editor tab, group 2).
3. `Codex Workbench: Open Chat Beside` → chat B (group 3). Layout: file | A | B.
4. Send a distinct prompt in each tab; confirm deltas stream to the owning
   tab only (automated: `npm run test` → "two-thread routing").
5. In A, trigger a command approval (e.g. ask for a shell action under
   `on-request` policy). Confirm: B shows nothing; A shows the exact
   command + cwd; Deny → turn continues denied; double-click Approve →
   second click ignored ("already settled").
6. `Interrupt` mid-turn → `turn/interrupt`; status returns to idle.
7. Close tab A (no delete prompt is correct). `Open/Resume Existing Chat` →
   Quick Pick lists the thread → resume → history hydrates via
   `thread/turns/list` + `thread/items/list`, no duplicated messages.
8. Kill the backend process manually → both tabs show disconnected (not
   "still running"); `Reconnect Backend` → resume works, in-flight turns
   reported interrupted.

## 2. Remote SSH (Windows → Ubuntu/Debian)

1. `Developer: Show Running Extensions` → `codex-workbench` runs **Workspace**
   (remote), UI renders locally.
2. Backend discovery resolves the **remote** binary (`Show Logs` shows the
   remote path + `platformOs: linux`); a local `C:\…` override must NOT leak
   across (clear local setting, set remote machine setting instead).
3. Two tabs + approval + remote file edit; `vscode.diff` opens a remote diff.
4. Disconnect network/SSH → honest disconnected status; reconnect → resume
   with interruption notice. No claim of continued execution across
   disconnect (spec 4.5).

## 3. Opt-in live model + approval test (costs quota)

Requires authenticated `codex` (official fallback OK).

1. `codex app-server` probe (read-only, no quota):
   `thread/list`, `thread/resume <id>` + `excludeTurns: true`,
   `thread/turns/list`, `thread/items/list`, `model/list`, `getAuthStatus`.
2. New thread + `turn/start` with a prompt that triggers a shell approval;
   answer in UI; confirm single response on the wire and correct turn
   completion. Record thread id, model, approval method, outcome.

## 4. VSIX smoke

`npm run package` → install `.vsix` on Windows x64 and Linux x64
(`code --install-extension`), repeat sections 1–2. Confirm no bundled
binaries (`unzip -l`: only `package.json`, `out/`, `media/`, docs).

## 5. Model + reasoning effort picker (new threads + per-thread pins)

1. Open a chat tab with no prior selection → header reads
   `… · model: default` (never "unknown").
2. Command Palette → `Codex Workbench: Select Model` → QuickPick lists
   `model/list` entries (display name + description, hidden skipped,
   current + default marked) → pick one → header shows the display name.
3. `Codex Workbench: Select Reasoning Effort` → options come from the
   picked model's `supportedReasoningEfforts` with descriptions → header
   appends `· effort: <value>`.
4. Send a turn → `Show Logs` has no new warnings; the pin applies to this
   turn and subsequent turns (protocol pin semantics).
5. `New Chat in Editor Tab` → new thread inherits the last chosen
   model/effort (header already shows them; first turn sends them).
6. Close + restore the tab (window reload) → pins survive via persisted
   panel bindings; header re-renders after re-resume.

Live-tested vs not: override forwarding (params present when set, keys
absent — never null — when unset), pin resolution/inheritance, `ext/model`
reducer + header format, unknown-model rejection, and catalog-vs-fallback
effort options are covered by `npm test` → "turn/start override
forwarding", "ThreadRegistry model/effort overrides", "ext/model header
state", "ModelCatalog" (fake transport over real stdio). NOT live-tested:
real-backend `model/list` values, Extension Development Host rendering of
the header/QuickPick, window-reload pin restore, and any billed model turn
with a pin.

## 6. Collaboration mode toggle (question tool)

Requires a backend that accepts experimental `thread/settings/update`
with `collaborationMode` (no auth needed to observe a rejection; a model
turn needs auth + quota).

1. Open a chat tab → header ends with `· mode: default`.
2. Command Palette → `Codex Workbench: Select Collaboration Mode` →
   QuickPick shows Default ("question tool is unavailable") and Plan
   ("can ask questions with the question tool"), current marked →
   pick Plan → header shows `· mode: plan`.
3. Against a backend WITHOUT experimental support (or an older official
   binary without the method): picking Plan must show an honest error
   (`collaboration mode change failed: …`) and the header must STAY at
   `· mode: default` — never a faked success.
4. `New Chat in Editor Tab` → new thread inherits Plan automatically
   (header already shows it). If inheritance fails, the tab shows an
   honest `collaboration mode inheritance failed` error and stays
   `default`.
5. Pick Default on a Plan thread → header returns to `· mode: default`;
   this IS sent (explicit change), unlike the untouched default.
6. Reload the window → plan binding restores; header re-renders after
   re-resume. If the backend lost the mode across resume, re-pick it.
7. Opt-in live question round trip (costs quota): in Plan mode, prompt
   the model to ask a clarifying question → the per-question Answer card
   appears → answer → turn continues.

Live-tested vs not: payload shape (incl. model/effort echo-back),
fail-closed rejects (unknown thread/mode/model), registry
inheritance/persistence, reducer + `· mode:` segment, and the
`experimentalApi: true` handshake flag are covered by `npm test` →
"mode payload", "mode validation", "ThreadRegistry collaboration
modes", "ext/model mode header state", "experimental handshake flag"
(fake transport over real stdio; the fake does NOT enforce the
experimental gate). NOT live-tested: real-backend acceptance of the
update (any backend at all), a real Plan-mode question round trip,
Extension Host rendering of the segment/QuickPick, window-reload mode
restore against a real backend, billed turns under Plan mode.

## Known gaps (not certifying)

- Live model turns, live interactive approvals, real-backend concurrency
  (two simultaneous model turns) — automated only against the fake.
- Model/effort picker against a real catalog, Extension Host rendering of
  the header/QuickPick, window-reload pin restore — automated at the
  transport/reducer/catalog level only (see section 5 above).
- Account login flows and connected-apps parity — explicitly not claimed.
- Webview ES-module loading inside VS Code — typechecked, not yet rendered
  in a live Extension Development Host.
