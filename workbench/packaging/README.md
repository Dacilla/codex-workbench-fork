# Packaging (CLI distribution)

Release assets (M2 target):

- `codex-workbench-windows-x64.zip` — canonical package dir for
  `x86_64-pc-windows-msvc` (upstream assembler output, not a lone `.exe`).
- `codex-workbench-linux-x64.tar.gz` — canonical package dir for
  `x86_64-unknown-linux-musl` (verify on clean Ubuntu/Debian first; a GNU
  target only after a documented compatibility decision).
- `SHA256SUMS` per archive + `codex-package.json` version manifest + changelog
  in the draft GitHub release.

Rules:

- npm wrapper (`@YOUR_SCOPE/codex-workbench`, scope TBD by repo owner) must
  resolve to the **same tested binary package** as the release archives —
  never a separately built binary. Staging follows
  `codex-cli/scripts/build_npm_package.py` conventions with renamed
  metadata/entrypoint. `npm pack` verification runs in `workbench-ci.yml`.
- Side-by-side with official `codex`: distinct install directories plus a
  separate `codex-workbench` launch alias. Do not overwrite the official
  binary, and do not assume renaming the executable is harmless to resource
  discovery or sandbox behaviour — verify on the assembled package.
- No public release or npm publish without explicit owner authorization and
  user-provided registry credentials (GitHub secrets / trusted publishing).
  `workbench-release.yml` opens a **draft** release only.
