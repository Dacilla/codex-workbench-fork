/**
 * Orchestrates one backend connection: lifecycle, threads, turns, approvals.
 *
 * One SessionManager owns one `codex app-server` child (spec 4.2 starting
 * hypothesis: a single App Server multiplexes multiple threads; request IDs
 * and the EventRouter keep turns/approvals correlation-safe).
 *
 * Reconnect semantics (spec 4.5): reconnect re-runs discovery + spawn +
 * handshake, then re-resumes known threads metadata-only
 * (`excludeTurns: true`) and hydrates via `thread/turns/list` +
 * `thread/items/list`. Turns that were in-flight across the drop are
 * reported as interrupted — never as still running.
 */

import { JsonRpcTransport } from "../backend/JsonRpcTransport";
import { BackendSource, BackendWritePolicy, classifyBackendWritePolicy } from "../backend/BackendPolicy";
import { ProcessManager } from "../backend/ProcessManager";
import { HandshakeResult, performHandshake } from "../backend/ProtocolVersion";
import { ApprovalHandler, ApprovalHandlerEvents } from "./Approvals";
import { buildThreadModeUpdateParams, validateCollaborationMode } from "./CollaborationMode";
import type { CollaborationModeKind } from "./CollaborationMode";
import { EventRouter, ThreadSink } from "./EventRouter";
import { ThreadRegistry } from "./ThreadRegistry";
import { RpcNotification, RpcRequest } from "../backend/JsonRpcTransport";

export type ConnectionState = "stopped" | "starting" | "ready" | "crashed";

export interface SessionManagerEvents {
  onConnectionState?: (state: ConnectionState, detail: string) => void;
  onHandshake?: (handshake: HandshakeResult) => void;
}

export interface ThreadStartOptions {
  cwd?: string;
  model?: string;
  approvalPolicy?: string;
}

export interface TurnOptions {
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * Override the model for this turn and subsequent turns (protocol pins
   * the thread). Forwarded only when set — never as null.
   */
  model?: string;
  /**
   * Override the reasoning effort for this turn and subsequent turns
   * (protocol pins the thread). Forwarded only when set — never as null.
   */
  effort?: string;
}

export interface ThreadModeOptions {
  /**
   * Explicit model for `collaboration_mode.settings.model`. Defaults to the
   * thread's effective model pin, then the backend-reported thread model.
   * When no model is known the call throws instead of sending an empty
   * `settings.model` (fail closed).
   */
  model?: string;
  /**
   * Explicit reasoning effort for `collaboration_mode.settings.
   * reasoning_effort`. Defaults to the thread's effective effort pin, then
   * the backend-reported thread effort, else null.
   */
  effort?: string;
}

export class SessionManager {
  private readonly processes: ProcessManager;
  private transport: JsonRpcTransport | null = null;
  private approvals: ApprovalHandler | null = null;
  private state: ConnectionState = "stopped";
  private lastDetail = "stopped";
  private handshake: HandshakeResult | null = null;
  private writePolicy: BackendWritePolicy = { mode: "full" };
  private writesOverridden = false;
  private readonly events: SessionManagerEvents;
  private readonly approvalEvents: ApprovalHandlerEvents;

  readonly router = new EventRouter();
  readonly threads = new ThreadRegistry();

  constructor(events: SessionManagerEvents = {}, approvalEvents: ApprovalHandlerEvents = {}) {
    this.events = events;
    this.approvalEvents = approvalEvents;
    this.processes = new ProcessManager({
      onExit: ({ code, signal }) => {
        this.approvals?.failClosedAll(`backend exited (code=${code}, signal=${signal})`);
        this.transport = null;
        this.setState("crashed", `backend exited (code=${code}, signal=${signal})`);
      },
    });
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get lastHandshake(): HandshakeResult | null {
    return this.handshake;
  }

  get backendLog(): string[] {
    return this.processes.stderrLog.snapshot();
  }

  /** Spawn + handshake. The caller resolved `executable` via BackendDiscovery on this host. */
  async connect(
    executable: string,
    argv: string[],
    options: { cwd?: string; experimentalApi?: boolean; backendSource?: BackendSource } = {},
  ): Promise<HandshakeResult> {
    if (this.state === "starting") {
      throw new Error("backend connection already in progress");
    }
    await this.disconnect("reconnecting");
    this.setState("starting", `spawning ${executable}`);
    const transport = this.processes.start(executable, argv, {
      onNotification: (notification: RpcNotification) => this.router.routeNotification(notification),
      onServerRequest: (request: RpcRequest) => this.routeServerRequest(request),
      onClose: () => {
        this.approvals?.failClosedAll("transport closed");
      },
    }, { cwd: options.cwd });
    this.transport = transport;
    this.approvals = new ApprovalHandler(transport, this.approvalEvents);
    try {
      this.handshake = await performHandshake(transport, { experimentalApi: options.experimentalApi });
    } catch (error) {
      await this.disconnect("handshake failed");
      throw error;
    }
    this.setState("ready", `connected to ${this.handshake.response.userAgent}`);
    this.writePolicy = classifyBackendWritePolicy({ source: options.backendSource, userAgent: this.handshake.response.userAgent });
    this.writesOverridden = false;
    if (this.writePolicy.mode === "gated") {
      this.events.onConnectionState?.("ready", `${this.lastDetail} — ${this.writePolicy.reason}`);
    }
    this.events.onHandshake?.(this.handshake);
    return this.handshake;
  }

  /** Current write policy (reads always work; turns may be gated). */
  get writePolicySnapshot(): BackendWritePolicy {
    return this.writePolicy;
  }

  /**
   * Session-only override for gated backends: re-affirmed every reconnect,
   * never persisted. Reads are unaffected either way.
   */
  allowWritesAnyway(): void {
    this.writesOverridden = true;
  }

  async disconnect(reason: string): Promise<void> {
    this.approvals?.failClosedAll(reason);
    this.transport?.close(reason);
    this.transport = null;
    this.approvals = null;
    await this.processes.stop();
    if (this.state !== "stopped") {
      this.setState("stopped", reason);
    }
  }

  subscribe(threadId: string, sink: ThreadSink): () => void {
    return this.router.subscribe(threadId, sink);
  }

  /**
   * Close-tab path: fail closed prompts owned by the panel, drop the
   * binding, keep the thread on the backend. Never calls thread/delete.
   */
  panelDisposed(panelId: string, threadId: string | null): void {
    if (threadId !== null) {
      this.approvals?.failClosedForThread(threadId, "owning panel disposed");
      this.router.setPaused(threadId, false);
    }
    this.threads.unbindPanel(panelId);
  }

  approvalsFor(threadId: string): ReturnType<ApprovalHandler["pendingForThread"]> {
    return this.approvals?.pendingForThread(threadId) ?? [];
  }

  decideApproval(requestId: string | number, decision: { approved: boolean; result?: unknown }): boolean {
    if (this.approvals === null) {
      return false;
    }
    return this.approvals.decide(requestId, decision);
  }

  private requireTransport(): JsonRpcTransport {
    if (this.transport === null || this.state !== "ready") {
      throw new Error(`backend is not connected (state=${this.state})`);
    }
    return this.transport;
  }

  async startThread(options: ThreadStartOptions = {}): Promise<Record<string, unknown>> {
    const transport = this.requireTransport();
    const params: Record<string, unknown> = {};
    if (options.cwd !== undefined) {
      params["cwd"] = options.cwd;
    }
    if (options.model !== undefined) {
      params["model"] = options.model;
    }
    if (options.approvalPolicy !== undefined) {
      params["approvalPolicy"] = options.approvalPolicy;
    }
    const result = (await transport.request("thread/start", params)) as Record<string, unknown>;
    const thread = (result["thread"] ?? {}) as Record<string, unknown>;
    if (typeof thread["id"] === "string") {
      this.threads.upsertThread({
        threadId: thread["id"] as string,
        displayName: typeof thread["name"] === "string" ? (thread["name"] as string) : (thread["id"] as string),
        workspaceKey: "",
        model: typeof result["model"] === "string" ? (result["model"] as string) : null,
        effort: typeof result["reasoningEffort"] === "string" ? (result["reasoningEffort"] as string) : null,
        cwd: typeof result["cwd"] === "string" ? (result["cwd"] as string) : null,
        status: "idle",
        lastTurnId: null,
        updatedAtMs: Date.now(),
      });
    }
    return result;
  }

  /**
   * Resume metadata-only (excludeTurns) so large histories never hydrate in
   * one blob; callers page with listThreadTurns/listThreadItems.
   */
  async resumeThread(threadId: string, options: { cwd?: string } = {}): Promise<Record<string, unknown>> {
    const transport = this.requireTransport();
    const params: Record<string, unknown> = { threadId, excludeTurns: true };
    if (options.cwd !== undefined) {
      params["cwd"] = options.cwd;
    }
    const result = (await transport.request("thread/resume", params)) as Record<string, unknown>;
    // Refresh the backend-known model/effort so the header stays truthful
    // across resume. Preserves the local display name / workspace binding and
    // never touches user pins (those live in the override map).
    const thread = (result["thread"] ?? {}) as Record<string, unknown>;
    if (typeof thread["id"] === "string") {
      const existing = this.threads.getThread(thread["id"] as string);
      this.threads.upsertThread({
        threadId: thread["id"] as string,
        displayName: existing?.displayName ?? (typeof thread["name"] === "string" ? (thread["name"] as string) : (thread["id"] as string)),
        workspaceKey: existing?.workspaceKey ?? "",
        model: typeof result["model"] === "string" ? (result["model"] as string) : (existing?.model ?? null),
        effort: typeof result["reasoningEffort"] === "string" ? (result["reasoningEffort"] as string) : (existing?.effort ?? null),
        cwd: typeof result["cwd"] === "string" ? (result["cwd"] as string) : (existing?.cwd ?? null),
        status: existing?.status ?? "idle",
        lastTurnId: existing?.lastTurnId ?? null,
        updatedAtMs: Date.now(),
      });
    }
    return result;
  }

  async listThreads(params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return (await this.requireTransport().request("thread/list", params)) as Record<string, unknown>;
  }

  async listThreadTurns(threadId: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return (await this.requireTransport().request("thread/turns/list", { threadId, ...params })) as Record<string, unknown>;
  }

  async listThreadItems(threadId: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return (await this.requireTransport().request("thread/items/list", { threadId, ...params })) as Record<string, unknown>;
  }

  async startTurn(threadId: string, text: string, options: TurnOptions = {}): Promise<Record<string, unknown>> {
    const transport = this.requireTransport();
    if (this.writePolicy.mode === "gated" && !this.writesOverridden) {
      throw new Error(
        `${this.writePolicy.reason} Run the 'Codex Workbench: Allow Writes Anyway (Session)' command to enable turns for this session only.`,
      );
    }
    const params: Record<string, unknown> = {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
    };
    if (options.cwd !== undefined) {
      params["cwd"] = options.cwd;
    }
    // Overrides are forwarded only when explicitly set. The backend treats a
    // present model/effort as a pin for this turn and subsequent turns; an
    // absent key preserves the thread default. Nulls are never sent.
    if (options.model !== undefined && options.model.length > 0) {
      params["model"] = options.model;
    }
    if (options.effort !== undefined && options.effort.length > 0) {
      params["effort"] = options.effort;
    }
    return (await transport.request("turn/start", params, { signal: options.signal, timeoutMs: options.timeoutMs ?? 0 })) as Record<string, unknown>;
  }

  async interruptTurn(threadId: string, turnId: string): Promise<unknown> {
    return this.requireTransport().request("turn/interrupt", { threadId, turnId });
  }

  async listModels(): Promise<Record<string, unknown>> {
    return (await this.requireTransport().request("model/list", {})) as Record<string, unknown>;
  }

  /**
   * Set a thread's collaboration mode for this turn and subsequent turns via
   * the experimental `thread/settings/update` escape hatch (see
   * `sessions/CollaborationMode.ts` for the gating analysis: the whole
   * method requires the `experimentalApi` handshake capability, so callers
   * must connect with `experimentalApi: true` or this throws the backend's
   * honest error).
   *
   * Only `collaborationMode` is sent — every other settings key is omitted
   * so nothing else changes. `settings.model`/`reasoning_effort` echo the
   * thread's current values because a `Some(collaboration_mode)` REPLACES
   * the mode+settings server-side; sending blanks would clobber model/effort
   * pins. `settings.developer_instructions` is null ("use the built-in
   * instructions for the selected mode").
   *
   * Fail-closed: validation errors and backend rejections throw and leave
   * the local mode map untouched (the registry records the mode only after
   * the transport confirms success). Callers surface the error, never a
   * faked success.
   */
  async setThreadMode(threadId: string, mode: CollaborationModeKind, options: ThreadModeOptions = {}): Promise<Record<string, unknown>> {
    const modeCheck = validateCollaborationMode(mode);
    if (!modeCheck.ok) {
      throw new Error(`Codex Workbench: ${modeCheck.error}`);
    }
    if (typeof threadId !== "string" || threadId.length === 0) {
      throw new Error("Codex Workbench: cannot set collaboration mode: threadId is empty");
    }
    const pins = this.threads.effectiveOverride(threadId);
    const record = this.threads.getThread(threadId);
    const model = options.model ?? pins.model ?? record?.model ?? null;
    if (model === null || model.length === 0) {
      throw new Error(`Codex Workbench: cannot set collaboration mode for thread ${threadId}: no model known for this thread (settings.model is required)`);
    }
    const rawEffort = options.effort ?? pins.effort ?? record?.effort ?? null;
    const effort = rawEffort !== null && rawEffort.length > 0 ? rawEffort : null;
    const built = buildThreadModeUpdateParams(threadId, modeCheck.mode, model, effort);
    if (!built.ok) {
      throw new Error(`Codex Workbench: ${built.error}`);
    }
    const transport = this.requireTransport();
    const result = (await transport.request("thread/settings/update", built.params)) as Record<string, unknown>;
    this.threads.setThreadMode(threadId, modeCheck.mode);
    return result;
  }

  private routeServerRequest(request: RpcRequest): void {
    const owned = this.router.routeServerRequest(request);
    this.approvals?.handleServerRequest(request);
    if (!owned) {
      // No live panel owns this thread right now: fail closed immediately so
      // the agent never hangs on an invisible prompt, and never auto-approves.
      // Only this request is settled; other threads' prompts are untouched.
      this.approvals?.failClosedOne(request.id, "approval arrived with no owning panel");
    }
  }

  private setState(state: ConnectionState, detail: string): void {
    this.state = state;
    this.lastDetail = detail;
    this.events.onConnectionState?.(state, detail);
  }

  /**
   * Current connection snapshot for late-joining webviews: ready broadcasts
   * fire while the webview is still loading and are lost, leaving the header
   * stuck at "connecting". Replayed on webview/ready.
   */
  connectionSnapshot(): { state: ConnectionState; detail: string } {
    return { state: this.state, detail: this.lastDetail };
  }
}
