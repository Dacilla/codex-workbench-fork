# Backend discovery + official-binary fallback handshake

All resolution runs on the **extension-host side**
(`src/backend/BackendDiscovery.ts`, `discoverBackend()`), so under Remote SSH
it executes on the remote Ubuntu/Debian host next to the repository — never on
the local Windows laptop.

## Order

1. `codexWorkbench.codexExecutablePath` (machine scope). Must be executable
   **on this host** or discovery throws `DiscoveryError` naming the host and
   platform. A Windows path set locally is never evaluated remotely because
   the setting is read by the host-side extension host (machine scope does
   not roam values across SSH the way window scope would mislead — and the
   code never falls back to a cached local path).
2. `codex-workbench` on `PATH` (fork build, preferred).
3. `codex` on `PATH` (official fallback).
4. Well-known dirs: Windows `%ProgramFiles%\Codex-Workbench`,
   `%LOCALAPPDATA%\Programs\…`; Linux `~/.local/bin`, `/usr/local/bin`.

Spawn argv is always `["app-server"]` stdio (verified against
`codex-rs/app-server-test-client/src/lib.rs` `spawn_stdio`: `codex app-server`
with piped stdin/stdout, inherited stderr).

## Official-binary fallback handshake

Any binary passing `performHandshake()` (`src/backend/ProtocolVersion.ts`)
is accepted:

- `initialize` with `clientInfo: {name: "codex-workbench", …}`,
  `capabilities: {experimentalApi: false, requestAttestation: false}`;
- required response fields: `userAgent`, `codexHome` (strings),
  `platformFamily`, `platformOs`; then the client sends `initialized`;
- unknown extra fields are ignored (observed drift: 0.155.1 `thread/resume`
  carries `runtimeWorkspaceRoots`, `activePermissionProfile`,
  `multiAgentMode`, `initialTurnsPage`, absent from the pinned schema).

When `userAgent` does not contain `codex-workbench`, the UI shows a
persistent "official backend" warning: reads are expected to work, writes may
drift, unsupported methods error honestly. No silent auto-update to untested
servers: the pin (`npm run check-protocol-pin` vs `workbench/UPSTREAM_SHA`)
is a CI gate.

## What is NOT done

- No automatic backend downloads.
- No bundling of binaries into the VSIX (frontend-only; `npm run lint`
  fails the build if an executable/archive appears under `workbench/vscode/`).
- No credential handling: stderr is captured into a 200-line sanitized ring
  (`apiKey`, bearer tokens, `sk-…` redacted) shown via Show Logs.
