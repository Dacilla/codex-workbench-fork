/**
 * `initialize` handshake and backend compatibility gate.
 *
 * Field shapes below mirror the pinned generated protocol
 * (codex-rs/app-server-protocol/schema/typescript/InitializeParams.ts,
 * InitializeResponse.ts, InitializeCapabilities.ts at UPSTREAM_SHA
 * 639d2478cc2e16d6ca715952d2e726a3aecc024e). Live-verified against
 * official codex-cli 0.155.1: the response carries exactly
 * `{ userAgent, codexHome, platformFamily, platformOs }`.
 *
 * Unknown extra keys are IGNORED (not rejected): the live 0.155.1
 * `thread/resume` response already carries keys absent from the pinned
 * schema (`runtimeWorkspaceRoots`, `activePermissionProfile`,
 * `multiAgentMode`, `initialTurnsPage`), and vice versa. Strict-shape
 * decoding would brick the extension on every server upgrade; required
 * fields are checked, everything else is tolerated.
 */

import { JsonRpcTransport } from "./JsonRpcTransport";

export const WORKBENCH_CLIENT_NAME = "codex-workbench";
export const WORKBENCH_CLIENT_TITLE = "Codex Workbench";
export const WORKBENCH_VERSION = "0.1.0";

/** Pinned upstream commit whose generated TS protocol this client speaks. */
export const PINNED_UPSTREAM_SHA = "639d2478cc2e16d6ca715952d2e726a3aecc024e";

export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
  raw: unknown;
}

export interface HandshakeResult {
  response: InitializeResponse;
  /** True when the backend does not identify as a workbench build. */
  isOfficialFallback: boolean;
}

export class HandshakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandshakeError";
  }
}

/**
 * Perform `initialize` + `initialized` and gate on compatibility.
 * Throws HandshakeError when the backend response is missing required
 * fields. Never throws on version skew beyond that — skew is reported via
 * `isOfficialFallback` and the `userAgent` string so the UI can show an
 * honest banner instead of failing outright.
 */
export async function performHandshake(
  transport: JsonRpcTransport,
  options: { experimentalApi?: boolean; timeoutMs?: number } = {},
): Promise<HandshakeResult> {
  const raw = (await transport.request(
    "initialize",
    {
      clientInfo: {
        name: WORKBENCH_CLIENT_NAME,
        title: WORKBENCH_CLIENT_TITLE,
        version: WORKBENCH_VERSION,
      },
      capabilities: {
        experimentalApi: options.experimentalApi ?? false,
        requestAttestation: false,
      },
    },
    { timeoutMs: options.timeoutMs ?? 30_000 },
  )) as Record<string, unknown> | null | undefined;

  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HandshakeError("initialize: backend returned a non-object response");
  }
  const { userAgent, codexHome, platformFamily, platformOs } = raw as Record<string, unknown>;
  if (typeof userAgent !== "string" || userAgent === "") {
    throw new HandshakeError("initialize: backend response is missing required string field 'userAgent'");
  }
  if (typeof codexHome !== "string" || codexHome === "") {
    throw new HandshakeError("initialize: backend response is missing required string field 'codexHome'");
  }
  if (typeof platformFamily !== "string" || typeof platformOs !== "string") {
    throw new HandshakeError("initialize: backend response is missing platform identification");
  }
  transport.notify("initialized");
  const response: InitializeResponse = { userAgent, codexHome, platformFamily, platformOs, raw };
  return {
    response,
    isOfficialFallback: !userAgent.toLowerCase().includes(WORKBENCH_CLIENT_NAME),
  };
}
