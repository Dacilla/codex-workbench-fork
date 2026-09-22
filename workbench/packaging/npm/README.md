# npm wrapper staging

Wrapper `@YOUR_SCOPE/codex-workbench` + two optional platform packages,
mirroring upstream's `@openai/codex` / `@openai/codex-{linux,win32}-x64`
split (see `codex-cli/bin/codex.js`). Only linux-x64 and win32-x64 are
supported; other platforms fail with an explicit error.

## Rules (enforced at release time, not by these files)

- `SCOPE` (`@YOUR_SCOPE`) is a placeholder. Replace with the owner-approved
  npm org/scope in all three manifests before first publish, and keep the
  three versions in lockstep.
- `vendor/<target-triple>/bin/codex[.exe]` inside each platform package must
  be copied **verbatim from the same tested release archives** produced by
  `workbench-release.yml` — never a separately built binary. The vendor
  binary keeps its upstream file name; only the npm bin
  (`codex-workbench`) differs, so resource discovery and sandbox helpers
  behave exactly as tested.
- No collision with official `codex`: this wrapper installs only the
  `codex-workbench` bin. Verify with `npm install -g` on a machine that
  already has `@openai/codex` installed.

## Local verification (no publish, no binaries needed)

```
cd workbench/packaging/npm
npm pack --dry-run            # wrapper manifest check
node --check bin/codex-workbench.js
node bin/codex-workbench.js --version   # fails closed: missing vendor binary
```
