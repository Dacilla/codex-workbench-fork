/**
 * Write-gating for backends whose mutation APIs are unproven.
 *
 * Reads (thread/list/resume, turns/items, model/list) always work: unknown
 * methods error honestly. Writes (turn/start) can burn usage or misbehave on
 * drifted servers, so they require either a deliberate binary choice or a
 * live-validated version:
 * - explicit-setting / path-workbench: the user pointed at this binary (or it
 *   is our product binary), so intent is clear — full operation.
 * - path-official / well-known-dir: full only when the handshake userAgent
 *   carries a version in KNOWN_COMPATIBLE_BACKEND_VERSIONS; otherwise gated.
 * - no origin info (unit tests driving SessionManager directly): full, so
 *   fake-transport tests are unaffected.
 *
 * Add a version here ONLY after a live validation loop (real turn + approval
 * shape check), never by guessing from release notes.
 */

export type BackendSource =
  | "explicit-setting"
  | "path-workbench"
  | "path-official"
  | "well-known-dir";

/** Official backend versions validated live against this client. */
export const KNOWN_COMPATIBLE_BACKEND_VERSIONS: readonly string[] = ["0.155.1"];

/** First MAJOR.MINOR.PATCH in a userAgent like "codex-workbench/0.155.1 (Windows ...)". */
export function extractBackendVersion(userAgent: string): string | null {
  const match = /\/(\d+\.\d+\.\d+)/.exec(userAgent);
  return match !== null ? (match[1] as string) : null;
}

export type BackendWritePolicy =
  | { readonly mode: "full" }
  | { readonly mode: "gated"; readonly reason: string };

export function classifyBackendWritePolicy(input: {
  source?: BackendSource;
  userAgent: string;
}): BackendWritePolicy {
  if (input.source === undefined || input.source === "explicit-setting" || input.source === "path-workbench") {
    return { mode: "full" };
  }
  const version = extractBackendVersion(input.userAgent);
  if (version !== null && (KNOWN_COMPATIBLE_BACKEND_VERSIONS as readonly string[]).includes(version)) {
    return { mode: "full" };
  }
  const found = version === null ? "an unparseable version" : `version ${version}`;
  return {
    mode: "gated",
    reason:
      `backend reports ${found} (userAgent: ${input.userAgent.slice(0, 120)}), ` +
      `which this client has not validated. Reads work; turns are disabled.`,
  };
}
