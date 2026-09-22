/**
 * Backend discovery on the EXTENSION-HOST side.
 *
 * Remote SSH rule: this module always runs on the machine hosting the
 * workspace extension host. It never consults the *local* UI-side settings
 * or paths when the extension host is remote. The explicit
 * `codexExecutablePath` setting is `machine`-scoped for exactly this reason:
 * a Windows laptop path must never be reused on a remote Linux host.
 *
 * Resolution order:
 *   1. Explicit `codexExecutablePath` (must exist + be executable).
 *   2. `codex-workbench` on PATH (our fork build, preferred).
 *   3. `codex` on PATH (official fallback — accepted only if the
 *      `initialize` handshake in ProtocolVersion.ts succeeds; the UI then
 *      shows an explicit "official backend" banner).
 *   4. Well-known install directories per OS.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface DiscoveryResult {
  executable: string;
  argv: string[];
  source: "explicit-setting" | "path-workbench" | "path-official" | "well-known-dir";
  isOfficialFallback: boolean;
}

export class DiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryError";
  }
}

/** Candidate well-known install locations for the *current* host OS. */
export function wellKnownCandidates(): string[] {
  const home = os.homedir();
  if (process.platform === "win32") {
    const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const localAppData = process.env["LOCALAPPDATA"] ?? path.join(home, "AppData", "Local");
    return [
      path.join(programFiles, "Codex-Workbench", "codex-workbench.exe"),
      path.join(localAppData, "Programs", "codex-workbench", "codex-workbench.exe"),
      path.join(localAppData, "Programs", "Codex", "codex.exe"),
    ];
  }
  return [
    path.join(home, ".local", "bin", "codex-workbench"),
    "/usr/local/bin/codex-workbench",
    path.join(home, ".local", "bin", "codex"),
    "/usr/local/bin/codex",
  ];
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    const stat = fs.statSync(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function findOnPath(names: string[]): string | null {
  const pathEnv = process.env["PATH"] ?? "";
  const dirs = pathEnv.split(path.delimiter).filter((dir) => dir !== "");
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const name of names) {
    for (const dir of dirs) {
      for (const extension of extensions) {
        const candidate = path.join(dir, `${name}${extension}`);
        if (isExecutable(candidate)) {
          return candidate;
        }
      }
    }
    // Absolute/relative names that already resolve (e.g. "./target/debug/codex").
    if (isExecutable(name)) {
      return name;
    }
  }
  return null;
}

/**
 * Resolve the backend executable. `explicitPath` is the machine-scoped
 * `codexWorkbench.codexExecutablePath` value read on THIS host.
 */
export function discoverBackend(explicitPath: string | undefined | null): DiscoveryResult {
  const trimmed = (explicitPath ?? "").trim();
  if (trimmed !== "") {
    if (!isExecutable(trimmed)) {
      throw new DiscoveryError(
        `codexWorkbench.codexExecutablePath points at '${trimmed}', which is not an executable file on this host (${os.hostname()}, ${process.platform}).`,
      );
    }
    return {
      executable: trimmed,
      argv: ["app-server"],
      source: "explicit-setting",
      // Unknown until the handshake inspects userAgent; assume fallback only
      // when the file name is the official one.
      isOfficialFallback: path.basename(trimmed).toLowerCase().startsWith("codex."),
    };
  }
  const workbench = findOnPath(process.platform === "win32" ? ["codex-workbench"] : ["codex-workbench"]);
  if (workbench !== null) {
    return { executable: workbench, argv: ["app-server"], source: "path-workbench", isOfficialFallback: false };
  }
  const official = findOnPath(["codex"]);
  if (official !== null) {
    return { executable: official, argv: ["app-server"], source: "path-official", isOfficialFallback: true };
  }
  for (const candidate of wellKnownCandidates()) {
    if (isExecutable(candidate)) {
      return {
        executable: candidate,
        argv: ["app-server"],
        source: "well-known-dir",
        isOfficialFallback: path.basename(candidate).toLowerCase().startsWith("codex."),
      };
    }
  }
  throw new DiscoveryError(
    "No Codex backend found on this host. Install the Codex Workbench CLI or official codex CLI on the machine running the workspace extension host, or set codexWorkbench.codexExecutablePath (machine scope).",
  );
}

/** The exact argv the extension spawns. Verified against the test client at the pinned SHA. */
export function backendSpawnArgs(): string[] {
  return ["app-server"];
}
