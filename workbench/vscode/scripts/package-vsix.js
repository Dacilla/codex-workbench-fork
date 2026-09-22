/**
 * Assemble a FRONTEND-ONLY VSIX (a zip with the .vsix extension).
 * Contents: package.json, out/ (extension host), media/ (webview bundle+css),
 * README, LICENSE notice. No binaries, no node_modules, no proprietary assets.
 *
 * Uses @vscode/vsce; fails closed when vsce is unavailable (CI installs it
 * as a devDependency). No Compress-Archive fallback: hand-rolled zips risk
 * shipping wrong layouts, so packaging refuses rather than guessing.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function run(cmd, args) {
  // No shell: portable across Windows dev machines and Linux CI runners
  // (Ubuntu provides pwsh, not powershell.exe — the old hardcoded shell
  // broke release packaging on Linux).
  execFileSync(cmd, args, { cwd: ROOT, stdio: "inherit" });
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const outFile = path.join(ROOT, `${pkg.name}-${pkg.version}.vsix`);

for (const dir of ["out", "media"]) {
  if (!fs.existsSync(path.join(ROOT, dir))) {
    console.error(`package-vsix: FAIL: missing ${dir}/ — run npm run build && npm run build:webview first`);
    process.exit(1);
  }
}

try {
  const runner = path.join(ROOT, "scripts", "run-vsce.js");
  run(process.execPath, [runner, "package", "--no-dependencies", "--out", outFile]);
  if (!fs.existsSync(outFile)) {
    throw new Error("vsce reported success but wrote no file");
  }
  console.log(`package-vsix: OK via vsce: ${outFile}`);
} catch (error) {
  console.error(`package-vsix: vsce failed (${error.message}); CI must install @vscode/vsce to package.`);
  process.exit(1);
}
