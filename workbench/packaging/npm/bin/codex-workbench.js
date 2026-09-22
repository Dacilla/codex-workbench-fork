#!/usr/bin/env node
// codex-workbench launcher: resolves the platform package installed alongside
// this wrapper and execs the native binary. The vendor binary keeps its
// upstream file name (codex / codex.exe); only the npm bin name differs, so
// resource discovery and sandbox helpers behave exactly as tested.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const SCOPE = "@YOUR_SCOPE";
const PLATFORM_PACKAGE_BY_TARGET = {
  "x86_64-unknown-linux-musl": `${SCOPE}/codex-workbench-linux-x64`,
  "x86_64-pc-windows-msvc": `${SCOPE}/codex-workbench-win32-x64`,
};

let targetTriple = null;
if (process.platform === "linux" && process.arch === "x64") {
  targetTriple = "x86_64-unknown-linux-musl";
} else if (process.platform === "win32" && process.arch === "x64") {
  targetTriple = "x86_64-pc-windows-msvc";
}
if (!targetTriple) {
  throw new Error(
    `codex-workbench: unsupported platform ${process.platform} (${process.arch}); supported: linux x64, win32 x64.`,
  );
}

const platformPackage = PLATFORM_PACKAGE_BY_TARGET[targetTriple];

function findNativeBinary() {
  let vendorRoot;
  try {
    const packageJsonPath = require.resolve(`${platformPackage}/package.json`);
    vendorRoot = path.join(path.dirname(packageJsonPath), "vendor");
  } catch {
    vendorRoot = path.join(__dirname, "..", "vendor");
  }
  const binaryPath = path.join(
    vendorRoot,
    targetTriple,
    "bin",
    process.platform === "win32" ? "codex.exe" : "codex",
  );
  if (existsSync(binaryPath)) {
    return binaryPath;
  }
  throw new Error(
    `codex-workbench: missing optional dependency ${platformPackage}. ` +
      `Reinstall with: npm install -g ${SCOPE}/codex-workbench@latest`,
  );
}

const binaryPath = findNativeBinary();
const child = spawn(binaryPath, process.argv.slice(2), { stdio: "inherit" });

child.on("error", (err) => {
  console.error(err);
  process.exit(1);
});

const forwardSignal = (signal) => {
  if (!child.killed) {
    try {
      child.kill(signal);
    } catch {
      /* ignore */
    }
  }
};
["SIGINT", "SIGTERM", "SIGHUP"].forEach((sig) => {
  process.on(sig, () => forwardSignal(sig));
});

const result = await new Promise((resolve) => {
  child.on("exit", (code, signal) => {
    resolve(signal ? { type: "signal", signal } : { type: "code", exitCode: code ?? 1 });
  });
});
if (result.type === "signal") {
  process.kill(process.pid, result.signal);
} else {
  process.exit(result.exitCode);
}
