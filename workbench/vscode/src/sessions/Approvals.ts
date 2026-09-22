/**
 * Approval ownership and fail-closed decisions.
 *
 * Server-initiated methods handled (from the pinned ServerRequest union):
 *   item/commandExecution/requestApproval  -> { decision: "accept"|"acceptForSession"|…|"decline"|"cancel" }
 *   item/fileChange/requestApproval        -> { decision: "accept"|"acceptForSession"|"decline"|"cancel" }
 *   item/permissions/requestApproval       -> { permissions: {...}, scope: "turn"|"session" }
 *   item/tool/requestUserInput             -> { answers: { [questionId]: { answers: string[] } } }
 *   mcpServer/elicitation/request          -> { action: "accept"|"decline"|"cancel", content, _meta }
 *   item/tool/call (dynamic tool)          -> { contentItems, success }
 *   applyPatchApproval (v1)                -> { decision: ReviewDecision }
 *   execCommandApproval (v1)               -> { decision: ReviewDecision }
 *
 * Rules:
 * - Exactly one response per server-request id. Double decisions are
 *   rejected locally and never touch the wire twice.
 * - Fail closed: when the owning panel is disposed, the connection drops,
 *   or no decision arrives before `decisionTimeoutMs`, the handler answers
 *   with the DENYING variant (never an approval), exactly once.
 * - Unknown server-request methods are denied when a denying shape is known,
 *   otherwise left unanswered and reported (the server times out its own
 *   wait; we never fabricate an approval for an unknown shape).
 */

import { JsonRpcTransport, RpcRequest } from "../backend/JsonRpcTransport";

export type ApprovalKind =
  | "commandExecution"
  | "fileChange"
  | "permissions"
  | "userInput"
  | "elicitation"
  | "dynamicTool"
  | "v1ApplyPatch"
  | "v1ExecCommand"
  | "unknown";

export interface PendingApproval {
  requestId: string | number;
  method: string;
  kind: ApprovalKind;
  threadId: string | null;
  turnId: string | null;
  itemId: string | null;
  /** Exact command/diff/target excerpt shown to the user. */
  summary: string;
  params: unknown;
  receivedAtMs: number;
}

export interface ApprovalDecision {
  approved: boolean;
  /** Extra payload for approvals that carry amendments/answers (user-confirmed). */
  result?: unknown;
}

const METHOD_KINDS: Array<[string, ApprovalKind]> = [
  ["item/commandExecution/requestApproval", "commandExecution"],
  ["item/fileChange/requestApproval", "fileChange"],
  ["item/permissions/requestApproval", "permissions"],
  ["item/tool/requestUserInput", "userInput"],
  ["mcpServer/elicitation/request", "elicitation"],
  ["item/tool/call", "dynamicTool"],
  ["applyPatchApproval", "v1ApplyPatch"],
  ["execCommandApproval", "v1ExecCommand"],
];

export function classifyApproval(method: string): ApprovalKind {
  for (const [name, kind] of METHOD_KINDS) {
    if (name === method) {
      return kind;
    }
  }
  return "unknown";
}

function fields(params: unknown): Record<string, unknown> {
  if (params !== null && typeof params === "object" && !Array.isArray(params)) {
    return params as Record<string, unknown>;
  }
  return {};
}

/** Human-readable, bounded excerpt of what is being approved. Never includes full bodies. */
export function summarizeApproval(method: string, params: unknown): string {
  const record = fields(params);
  const clip = (value: unknown, max = 300): string => {
    const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
    return text.length > max ? `${text.slice(0, max)}…` : text;
  };
  switch (classifyApproval(method)) {
    case "commandExecution":
      return `command: ${clip(record["command"])} (cwd: ${clip(record["cwd"], 120)})`;
    case "fileChange":
      return `file change${typeof record["grantRoot"] === "string" && record["grantRoot"] !== "" ? ` (grant root: ${clip(record["grantRoot"], 160)})` : ""}${typeof record["reason"] === "string" && record["reason"] !== "" ? ` — ${clip(record["reason"])}` : ""}`;
    case "permissions":
      return `permissions: ${clip(record["permissions"])} (cwd: ${clip(record["cwd"], 120)})`;
    case "userInput": {
      const questions = Array.isArray(record["questions"]) ? record["questions"].length : 0;
      return `user input: ${questions} question(s)${record["isBlocking"] === true ? " (blocking)" : ""}`;
    }
    case "elicitation":
      return `elicitation from '${clip(record["serverName"], 120)}': ${clip(record["message"])}`;
    case "dynamicTool":
      return `dynamic tool '${clip(record["tool"], 120)}' (namespace: ${clip(record["namespace"], 120)})`;
    case "v1ApplyPatch":
      return `apply patch (${typeof record["callId"] === "string" ? record["callId"] : "?"})`;
    case "v1ExecCommand":
      return `exec: ${clip(record["command"])} (cwd: ${clip(record["cwd"], 120)})`;
    case "unknown":
      return `unknown approval method '${method}'`;
  }
}

/** The denying (fail-closed) response for each known kind. Null = no safe shape; leave unanswered. */
export function failClosedResult(kind: ApprovalKind): unknown {
  switch (kind) {
    case "commandExecution":
      return { decision: "decline" };
    case "fileChange":
      return { decision: "decline" };
    case "permissions":
      return { permissions: {}, scope: "turn" };
    case "userInput":
      return { answers: {} };
    case "elicitation":
      return { action: "cancel", content: null, _meta: null };
    case "dynamicTool":
      return { contentItems: [{ type: "inputText", text: "declined by Codex Workbench: no dynamic-tool handler" }], success: false };
    case "v1ApplyPatch":
    case "v1ExecCommand":
      return { decision: { denied: { rejection: "declined by Codex Workbench (fail closed)" } } };
    case "unknown":
      return null;
  }
}

export interface ApprovalHandlerEvents {
  onApprovalRequested?: (approval: PendingApproval) => void;
  onApprovalSettled?: (approval: PendingApproval, approved: boolean, failClosed: boolean) => void;
}

export const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

export class ApprovalHandler {
  private readonly pending = new Map<string, { approval: PendingApproval; timer: NodeJS.Timeout | undefined }>();
  private readonly transport: JsonRpcTransport;
  private readonly events: ApprovalHandlerEvents;
  private readonly decisionTimeoutMs: number;

  constructor(transport: JsonRpcTransport, events: ApprovalHandlerEvents = {}, decisionTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS) {
    this.transport = transport;
    this.events = events;
    this.decisionTimeoutMs = decisionTimeoutMs;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  pendingForThread(threadId: string): PendingApproval[] {
    const result: PendingApproval[] = [];
    for (const { approval } of this.pending.values()) {
      if (approval.threadId === threadId) {
        result.push(approval);
      }
    }
    return result;
  }

  /** Entry point for server-initiated requests routed by thread. */
  handleServerRequest(request: RpcRequest): void {
    const key = String(request.id);
    if (this.pending.has(key)) {
      return; // Duplicate delivery; the first registration owns the id.
    }
    const record = fields(request.params);
    const approval: PendingApproval = {
      requestId: request.id,
      method: request.method,
      kind: classifyApproval(request.method),
      threadId: typeof record["threadId"] === "string" ? (record["threadId"] as string) : typeof record["conversationId"] === "string" ? (record["conversationId"] as string) : null,
      turnId: typeof record["turnId"] === "string" ? (record["turnId"] as string) : null,
      itemId: typeof record["itemId"] === "string" ? (record["itemId"] as string) : typeof record["callId"] === "string" ? (record["callId"] as string) : null,
      summary: summarizeApproval(request.method, request.params),
      params: request.params,
      receivedAtMs: Date.now(),
    };
    let timer: NodeJS.Timeout | undefined;
    if (this.decisionTimeoutMs > 0) {
      timer = setTimeout(() => this.settleFailClosed(key, "decision timeout"), this.decisionTimeoutMs);
      timer.unref?.();
    }
    this.pending.set(key, { approval, timer });
    this.events.onApprovalRequested?.(approval);
  }

  /**
   * Record the user's explicit decision. Returns false when the approval is
   * already settled (prevents double-send on double-click/retry).
   */
  decide(requestId: string | number, decision: ApprovalDecision): boolean {
    const key = String(requestId);
    const entry = this.pending.get(key);
    if (entry === undefined) {
      return false;
    }
    this.pending.delete(key);
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
    }
    let result: unknown;
    let effectivelyApproved = decision.approved;
    let failClosed = false;
    if (decision.approved) {
      result = decision.result ?? approveResult(entry.approval.kind);
      if (result === null || result === undefined) {
        // Approved in the UI but no safe approval payload exists for this
        // kind (e.g. permissions grants, user-input answers must be supplied
        // explicitly). Fail closed rather than hanging the server wait.
        result = failClosedResult(entry.approval.kind);
        effectivelyApproved = false;
        failClosed = true;
      }
    } else {
      result = failClosedResult(entry.approval.kind);
    }
    if (result !== null && result !== undefined) {
      this.transport.respond(entry.approval.requestId, result);
    }
    this.events.onApprovalSettled?.(entry.approval, effectivelyApproved, failClosed);
    return true;
  }

  /** Fail closed every pending approval for a disposed panel / dead thread. */
  failClosedForThread(threadId: string, reason: string): number {
    let count = 0;
    for (const key of [...this.pending.keys()]) {
      const entry = this.pending.get(key);
      if (entry !== undefined && entry.approval.threadId === threadId) {
        this.settleFailClosed(key, reason);
        count += 1;
      }
    }
    return count;
  }

  /** Fail closed one specific server request (no owning panel). */
  failClosedOne(requestId: string | number, reason: string): boolean {
    const key = String(requestId);
    if (!this.pending.has(key)) {
      return false;
    }
    this.settleFailClosed(key, reason);
    return true;
  }

  /** Fail closed everything (transport drop). Safe to call multiple times. */
  failClosedAll(reason: string): number {
    let count = 0;
    for (const key of [...this.pending.keys()]) {
      this.settleFailClosed(key, reason);
      count += 1;
    }
    return count;
  }

  private settleFailClosed(key: string, _reason: string): void {
    const entry = this.pending.get(key);
    if (entry === undefined) {
      return;
    }
    this.pending.delete(key);
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
    }
    const result = failClosedResult(entry.approval.kind);
    if (result !== null) {
      // Best effort: transport may already be closed; respond() is a no-op then.
      this.transport.respond(entry.approval.requestId, result);
    }
    this.events.onApprovalSettled?.(entry.approval, false, true);
  }
}

function approveResult(kind: ApprovalKind): unknown {
  switch (kind) {
    case "commandExecution":
    case "fileChange":
      return { decision: "accept" };
    case "permissions":
      // Approving a permissions request still requires the granted profile;
      // the UI must supply it via decide(..., { result }). Without it, deny.
      return null;
    case "userInput":
      return null;
    case "elicitation":
      return { action: "accept", content: null, _meta: null };
    case "dynamicTool":
      return null;
    case "v1ApplyPatch":
    case "v1ExecCommand":
      return { decision: "approved" };
    case "unknown":
      return null;
  }
}
