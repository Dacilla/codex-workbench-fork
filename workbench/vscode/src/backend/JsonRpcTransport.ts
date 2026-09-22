/**
 * Newline-delimited JSON-RPC transport for `codex app-server` stdio.
 *
 * Wire facts (verified against codex-rs/app-server-protocol/src/rpc.rs at
 * pinned SHA 639d2478cc2e16d6ca715952d2e726a3aecc024e, and live against
 * official codex-cli 0.155.1 — see workbench/docs/vscode-feature-matrix.md):
 *
 * - One JSON message per line on stdout/stdin. No `jsonrpc: "2.0"` field is
 *   sent or expected (the server tolerates it, but the canonical form omits
 *   it). See `rpc.rs`: "We do not do true JSON-RPC 2.0".
 * - Client request: `{ id: string|number, method: string, params?: Value }`.
 * - Success response: `{ id, result }`. Error: `{ id, error: { code, message, data? } }`.
 * - Server-initiated approval: `{ id, method, params }` (a Request addressed
 *   to us; we answer with `{ id, result }`).
 * - Notification: `{ method, params? }`, optionally with `emittedAtMs`.
 *
 * This module is intentionally free of the `vscode` API so it can be
 * exercised by plain Node protocol tests (see src/test/).
 */

export type RequestId = string | number;

export interface RpcRequest {
  id: RequestId;
  method: string;
  params?: unknown;
}

export interface RpcNotification {
  method: string;
  params?: unknown;
  emittedAtMs?: number;
}

export interface RpcErrorInfo {
  code: number;
  message: string;
  data?: unknown;
}

export interface TransportEvents {
  onNotification?: (notification: RpcNotification) => void;
  onServerRequest?: (request: RpcRequest) => void;
  onClose?: (reason: string) => void;
}

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
/** Hard cap on concurrent in-flight client requests (backpressure). */
export const MAX_INFLIGHT_REQUESTS = 256;

export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(info: RpcErrorInfo) {
    super(`app-server error ${info.code}: ${info.message}`);
    this.name = "RpcError";
    this.code = info.code;
    this.data = info.data;
  }
}

export class TransportClosedError extends Error {
  constructor(reason: string) {
    super(`app-server transport closed: ${reason}`);
    this.name = "TransportClosedError";
  }
}

export class RequestTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`app-server request timed out: ${method} after ${timeoutMs}ms`);
    this.name = "RequestTimeoutError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === "string" || typeof value === "number";
}

/** Strict structural validation of one inbound line. Returns null when the line is blank. */
export function parseInboundLine(line: string): { kind: "request"; request: RpcRequest } | { kind: "notification"; notification: RpcNotification } | { kind: "response"; id: RequestId; result: unknown } | { kind: "error"; id: RequestId; error: RpcErrorInfo } | null {
  if (line.trim() === "") {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    throw new Error(`app-server sent non-JSON line: ${line.slice(0, 200)}`);
  }
  if (!isObject(value)) {
    throw new Error("app-server sent a non-object JSON-RPC message");
  }
  const { id, method, params, result, error } = value;
  if (isRequestId(id) && typeof method === "string") {
    return { kind: "request", request: { id, method, params } };
  }
  if (isRequestId(id) && "result" in value) {
    return { kind: "response", id, result };
  }
  if (isRequestId(id) && isObject(error)) {
    const { code, message, data } = error as Record<string, unknown>;
    if (typeof code !== "number" || typeof message !== "string") {
      throw new Error("app-server sent a malformed JSON-RPC error object");
    }
    return { kind: "error", id, error: { code, message, data } };
  }
  if (typeof method === "string") {
    const notification: RpcNotification = { method, params };
    if (typeof value["emittedAtMs"] === "number") {
      notification.emittedAtMs = value["emittedAtMs"] as number;
    }
    return { kind: "notification", notification };
  }
  throw new Error(`app-server sent an unrecognized JSON-RPC message: ${line.slice(0, 200)}`);
}

let requestCounter = 0;

/** Create a unique string request id (UUID-style not required; uniqueness per connection is). */
export function newRequestId(): string {
  requestCounter += 1;
  return `wb-${Date.now().toString(36)}-${requestCounter.toString(36)}-${Math.floor(Math.random() * 0xffff).toString(36)}`;
}

interface PendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
  onAbort?: () => void;
}

/**
 * Multiplexed JSON-RPC transport. The byte stream is injected so tests can
 * drive this class without spawning a process.
 */
export class JsonRpcTransport {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly events: TransportEvents;
  private readonly writeLine: (line: string) => void;
  private receiveBuffer = "";
  private closed = false;
  private closeReason = "";

  constructor(writeLine: (line: string) => void, events: TransportEvents = {}) {
    this.writeLine = writeLine;
    this.events = events;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Feed a raw stdout chunk into the line parser. */
  feedData(chunk: string): void {
    if (this.closed) {
      return;
    }
    this.receiveBuffer += chunk;
    let newlineIndex = this.receiveBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.receiveBuffer.slice(0, newlineIndex);
      this.receiveBuffer = this.receiveBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.receiveBuffer.indexOf("\n");
    }
    // Guard against an unbounded line (a corrupt peer streaming garbage).
    if (this.receiveBuffer.length > 16 * 1024 * 1024) {
      this.close("inbound line exceeded 16 MiB; assuming corrupt stream");
    }
  }

  request(method: string, params?: unknown, options: RequestOptions = {}): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new TransportClosedError(this.closeReason || "transport closed"));
    }
    if (this.pending.size >= MAX_INFLIGHT_REQUESTS) {
      return Promise.reject(new Error(`too many in-flight app-server requests (${this.pending.size})`));
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const id = newRequestId();
    const payload: Record<string, unknown> = { id, method };
    if (params !== undefined) {
      payload["params"] = params;
    }
    return new Promise<unknown>((resolve, reject) => {
      const entry: PendingRequest = { method, resolve, reject };
      this.pending.set(idKey(id), entry);
      const cleanup = (): void => {
        if (entry.timer !== undefined) {
          clearTimeout(entry.timer);
        }
        this.pending.delete(idKey(id));
        if (entry.onAbort !== undefined && options.signal !== undefined) {
          options.signal.removeEventListener("abort", entry.onAbort);
        }
      };
      const onSettle = (fn: () => void): void => {
        cleanup();
        fn();
      };
      entry.resolve = (result: unknown) => onSettle(() => resolve(result));
      entry.reject = (error: Error) => onSettle(() => reject(error));
      if (options.signal !== undefined) {
        if (options.signal.aborted) {
          entry.reject(new Error(`request aborted: ${method}`));
          return;
        }
        entry.onAbort = () => entry.reject(new Error(`request aborted: ${method}`));
        options.signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          entry.reject(new RequestTimeoutError(method, timeoutMs));
        }, timeoutMs);
        entry.timer.unref?.();
      }
      try {
        this.writeLine(JSON.stringify(payload));
      } catch (error) {
        entry.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Fire-and-forget notification (e.g. `initialized`). Never rejects on close. */
  notify(method: string, params?: unknown): void {
    if (this.closed) {
      return;
    }
    const payload: Record<string, unknown> = { method };
    if (params !== undefined) {
      payload["params"] = params;
    }
    try {
      this.writeLine(JSON.stringify(payload));
    } catch {
      // Best effort: notifications carry no delivery guarantee.
    }
  }

  /** Answer a server-initiated request (approvals, elicitation). Exactly-once per id is enforced by the caller. */
  respond(id: RequestId, result: unknown): void {
    if (this.closed) {
      return;
    }
    try {
      this.writeLine(JSON.stringify({ id, result }));
    } catch {
      // Best effort; the peer will time out server-side if the pipe is dead.
    }
  }

  close(reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeReason = reason;
    const error = new TransportClosedError(reason);
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      if (entry.timer !== undefined) {
        clearTimeout(entry.timer);
      }
      entry.reject(error);
    }
    this.events.onClose?.(reason);
  }

  private handleLine(line: string): void {
    let parsed: ReturnType<typeof parseInboundLine>;
    try {
      parsed = parseInboundLine(line);
    } catch (error) {
      // A malformed line must not kill the connection; surface it and continue.
      this.events.onNotification?.({
        method: "$/malformedLine",
        params: { line: line.slice(0, 500), error: error instanceof Error ? error.message : String(error) },
      });
      return;
    }
    if (parsed === null) {
      return;
    }
    switch (parsed.kind) {
      case "response": {
        const entry = this.pending.get(idKey(parsed.id));
        if (entry !== undefined) {
          entry.resolve(parsed.result);
        }
        break;
      }
      case "error": {
        const entry = this.pending.get(idKey(parsed.id));
        if (entry !== undefined) {
          entry.reject(new RpcError(parsed.error));
        }
        break;
      }
      case "request": {
        this.events.onServerRequest?.(parsed.request);
        break;
      }
      case "notification": {
        this.events.onNotification?.(parsed.notification);
        break;
      }
    }
  }
}

function idKey(id: RequestId): string {
  return `${typeof id}:${String(id)}`;
}
