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

## Known gaps (not certifying)

- Live model turns, live interactive approvals, real-backend concurrency
  (two simultaneous model turns) — automated only against the fake.
- Account login flows and connected-apps parity — explicitly not claimed.
- Webview ES-module loading inside VS Code — typechecked, not yet rendered
  in a live Extension Development Host.
