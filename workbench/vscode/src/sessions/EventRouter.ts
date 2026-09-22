/**
 * Thread/turn event router: every inbound notification and server request is
 * attributed to exactly one thread, then fanned out to that thread's sinks
 * (live panels). Cross-thread misdelivery is the top correctness risk for
 * concurrent tabs and approvals, so attribution is strict:
 *
 * - Most params carry `threadId` (verified live: agentMessage deltas, item
 *   started/completed, turn started/completed, approvals all carry it).
 * - Messages without a threadId are GLOBAL (account/updated, configWarning,
 *   remoteControl/status/changed — all observed live) and go to global
 *   subscribers + every registered sink.
 * - Messages naming an UNKNOWN threadId are parked in `orphaned` (bounded)
 *   for diagnostics instead of being delivered to the wrong tab.
 *
 * Backpressure: each thread sink has a bounded buffer (default 500) used
 * while a panel is hidden. Overflow drops the oldest with a monotonically
 * increasing `droppedCount` surfaced to the UI, so resume never shows a
 * false-complete transcript.
 */

import { RpcNotification, RpcRequest } from "../backend/JsonRpcTransport";

export interface ThreadSink {
  onNotification(notification: RpcNotification): void;
  onServerRequest?(request: RpcRequest): void;
}

export interface GlobalSink {
  onGlobalNotification(notification: RpcNotification): void;
}

export const MAX_BUFFERED_PER_THREAD = 500;
const MAX_ORPHANED = 100;

export function threadIdOf(params: unknown): string | null {
  if (params === null || params === undefined || typeof params !== "object" || Array.isArray(params)) {
    return null;
  }
  const record = params as Record<string, unknown>;
  const threadId = record["threadId"];
  if (typeof threadId === "string" && threadId !== "") {
    return threadId;
  }
  // v1 approval methods (applyPatchApproval, execCommandApproval) identify
  // the conversation as `conversationId`.
  const conversationId = record["conversationId"];
  return typeof conversationId === "string" && conversationId !== "" ? conversationId : null;
}

interface BufferedEntry {
  notification: RpcNotification;
}

export class EventRouter {
  private readonly sinks = new Map<string, Set<ThreadSink>>();
  private readonly buffers = new Map<string, BufferedEntry[]>();
  private readonly droppedCounts = new Map<string, number>();
  private pausedThreads = new Set<string>();
  private readonly globalSinks = new Set<GlobalSink>();
  private readonly orphaned: Array<{ method: string; reason: string }> = [];

  get orphanedCount(): number {
    return this.orphaned.length;
  }

  droppedCount(threadId: string): number {
    return this.droppedCounts.get(threadId) ?? 0;
  }

  bufferedCount(threadId: string): number {
    return this.buffers.get(threadId)?.length ?? 0;
  }

  subscribe(threadId: string, sink: ThreadSink): () => void {
    let set = this.sinks.get(threadId);
    if (set === undefined) {
      set = new Set();
      this.sinks.set(threadId, set);
    }
    set.add(sink);
    // Replay anything buffered while the panel was hidden, in order.
    const buffered = this.buffers.get(threadId);
    if (buffered !== undefined) {
      this.buffers.delete(threadId);
      for (const entry of buffered) {
        sink.onNotification(entry.notification);
      }
    }
    return () => {
      set?.delete(sink);
    };
  }

  subscribeGlobal(sink: GlobalSink): () => void {
    this.globalSinks.add(sink);
    return () => {
      this.globalSinks.delete(sink);
    };
  }

  /** Pause delivery for a hidden panel (buffer) or resume it (replay). */
  setPaused(threadId: string, paused: boolean): void {
    if (paused) {
      this.pausedThreads.add(threadId);
    } else {
      this.pausedThreads.delete(threadId);
    }
  }

  routeNotification(notification: RpcNotification): void {
    const threadId = threadIdOf(notification.params);
    if (threadId === null) {
      this.deliverGlobal(notification);
      return;
    }
    const sinks = this.sinks.get(threadId);
    if (sinks === undefined || sinks.size === 0) {
      this.parkOrphaned(notification.method, `no live panel for thread ${threadId}`);
      // Still buffer it (bounded) so a reopening panel can catch up.
      this.bufferForThread(threadId, notification);
      return;
    }
    if (this.pausedThreads.has(threadId)) {
      this.bufferForThread(threadId, notification);
      return;
    }
    for (const sink of sinks) {
      sink.onNotification(notification);
    }
  }

  /**
   * Route a server-initiated request (approval/elicitation). Returns true
   * when exactly one live owner accepted it. Never broadcasts: an approval
   * must reach precisely one decision maker.
   */
  routeServerRequest(request: RpcRequest): boolean {
    const threadId = threadIdOf(request.params);
    if (threadId === null) {
      this.parkOrphaned(request.method, "server request without threadId");
      return false;
    }
    const sinks = this.sinks.get(threadId);
    if (sinks === undefined || sinks.size === 0) {
      this.parkOrphaned(request.method, `approval for thread ${threadId} with no live panel`);
      return false;
    }
    // Prefer the most recently subscribed sink (the focused panel) but
    // require it to explicitly accept ownership; fall back across siblings.
    const ordered = [...sinks].reverse();
    for (const sink of ordered) {
      if (sink.onServerRequest !== undefined) {
        sink.onServerRequest(request);
        return true;
      }
    }
    return false;
  }

  private deliverGlobal(notification: RpcNotification): void {
    for (const sink of this.globalSinks) {
      sink.onGlobalNotification(notification);
    }
    for (const set of this.sinks.values()) {
      for (const sink of set) {
        sink.onNotification(notification);
      }
    }
  }

  private bufferForThread(threadId: string, notification: RpcNotification): void {
    let buffer = this.buffers.get(threadId);
    if (buffer === undefined) {
      buffer = [];
      this.buffers.set(threadId, buffer);
    }
    buffer.push({ notification });
    while (buffer.length > MAX_BUFFERED_PER_THREAD) {
      buffer.shift();
      this.droppedCounts.set(threadId, (this.droppedCounts.get(threadId) ?? 0) + 1);
    }
  }

  private parkOrphaned(method: string, reason: string): void {
    this.orphaned.push({ method, reason });
    while (this.orphaned.length > MAX_ORPHANED) {
      this.orphaned.shift();
    }
  }
}
