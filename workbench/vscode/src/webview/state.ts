/**
 * Pure conversation state reducer shared by the webview and unit tests.
 * No DOM, no vscode API: given extension messages, produce render state.
 *
 * Streaming deltas (`ext/delta`) append to the in-progress item keyed by
 * (turnId, itemId); finalized `ext/item` snapshots REPLACE the item so a
 * resume re-hydration never duplicates streamed text (spec 4.3).
 */

export interface ChatItem {
  itemId: string;
  turnId: string;
  kind: string;
  text: string;
  status: "streaming" | "final";
  collapsed: boolean;
}

export interface ApprovalCard {
  requestId: string | number;
  method: string;
  summary: string;
  settled: boolean;
  approved: boolean | null;
  failClosed: boolean;
}

export interface ConversationState {
  items: ChatItem[];
  approvals: ApprovalCard[];
  turnStatus: string;
  activeTurnId: string | null;
  connection: string;
  error: string | null;
  droppedEvents: number;
  /** Compact per-server MCP status (update-in-place, never timeline cards). */
  mcp: Record<string, { status: string; hasError: boolean }>;
  /**
   * Effective model for the next turn: the user-pinned id when set, else the
   * backend-reported thread model. Null = backend default (header shows
   * "default", never "unknown").
   */
  model: string | null;
  /** Effective reasoning effort for the next turn; null = backend default. */
  effort: string | null;
  /** Catalog display name for `model` where known; null = show the raw id. */
  modelLabel: string | null;
}

export function initialState(): ConversationState {
  return { items: [], approvals: [], turnStatus: "idle", activeTurnId: null, connection: "connecting", error: null, droppedEvents: 0, mcp: {}, model: null, effort: null, modelLabel: null };
}

export type ExtensionEvent =
  | { type: "ext/state"; items: ChatItem[]; turnStatus: string }
  | { type: "ext/delta"; turnId: string; itemId: string; kind: string; delta: string }
  | { type: "ext/item"; turnId: string; itemId: string; kind: string; text: string }
  | { type: "ext/turnStatus"; turnId: string | null; status: string }
  | { type: "ext/approval"; requestId: string | number; method: string; summary: string }
  | { type: "ext/approvalSettled"; requestId: string | number; approved: boolean; failClosed: boolean }
  | { type: "ext/error"; message: string }
  | { type: "ext/connection"; state: string; detail: string; droppedEvents?: number }
  | { type: "ext/mcpStatus"; server: string; status: string; hasError: boolean }
  | { type: "ext/model"; model: string | null; effort: string | null; displayName: string | null };

const MAX_ITEMS = 2000;
const MAX_TEXT_PER_ITEM = 256 * 1024;

function clipText(text: string): string {
  return text.length > MAX_TEXT_PER_ITEM ? `${text.slice(0, MAX_TEXT_PER_ITEM)}…[truncated]` : text;
}

export function reduce(state: ConversationState, event: ExtensionEvent): ConversationState {
  switch (event.type) {
    case "ext/state": {
      return { ...state, items: event.items.slice(-MAX_ITEMS), turnStatus: event.turnStatus };
    }
    case "ext/delta": {
      const items = [...state.items];
      const index = items.findIndex((item) => item.itemId === event.itemId);
      if (index === -1) {
        items.push({ itemId: event.itemId, turnId: event.turnId, kind: event.kind, text: clipText(event.delta), status: "streaming", collapsed: false });
      } else {
        const current = items[index] as ChatItem;
        // A finalized item must not grow from a stale delta (resume race).
        if (current.status === "final") {
          return state;
        }
        items[index] = { ...current, text: clipText(current.text + event.delta) };
      }
      return { ...state, items: items.slice(-MAX_ITEMS) };
    }
    case "ext/item": {
      const items = [...state.items];
      const finalized: ChatItem = { itemId: event.itemId, turnId: event.turnId, kind: event.kind, text: clipText(event.text), status: "final", collapsed: isCollapsibleKind(event.kind) };
      const index = items.findIndex((item) => item.itemId === event.itemId);
      if (index !== -1) {
        items[index] = finalized;
        return { ...state, items: items.slice(-MAX_ITEMS) };
      }
      // Adopt the optimistic local echo: the backend re-emits our sent
      // message as its own item, which would otherwise double-render.
      if (event.kind === "userMessage") {
        const local = items.findIndex((item) => item.kind === "userMessage" && item.turnId === "local" && item.text === finalized.text);
        if (local !== -1) {
          items[local] = finalized;
          return { ...state, items: items.slice(-MAX_ITEMS) };
        }
      }
      items.push(finalized);
      return { ...state, items: items.slice(-MAX_ITEMS) };
    }
    case "ext/turnStatus": {
      return { ...state, turnStatus: event.status, activeTurnId: event.turnId, error: event.status === "failed" ? state.error : null };
    }
    case "ext/approval": {
      if (state.approvals.some((card) => String(card.requestId) === String(event.requestId))) {
        return state;
      }
      return { ...state, approvals: [...state.approvals, { requestId: event.requestId, method: event.method, summary: event.summary, settled: false, approved: null, failClosed: false }] };
    }
    case "ext/approvalSettled": {
      return {
        ...state,
        approvals: state.approvals.map((card) => (String(card.requestId) === String(event.requestId) ? { ...card, settled: true, approved: event.approved, failClosed: event.failClosed } : card)),
      };
    }
    case "ext/error": {
      return { ...state, error: event.message };
    }
    case "ext/connection": {
      return { ...state, connection: event.state, error: event.state === "ready" ? null : event.detail, droppedEvents: event.droppedEvents ?? state.droppedEvents };
    }
    case "ext/mcpStatus": {
      // Update-in-place per server; bounded so a pathological server list
      // cannot grow webview state without limit.
      const server = event.server.slice(0, 200);
      const status = event.status.slice(0, 100);
      if (server.length === 0) {
        return state;
      }
      const mcp = { ...state.mcp };
      if (mcp[server] === undefined && Object.keys(mcp).length >= 64) {
        return state;
      }
      mcp[server] = { status, hasError: event.hasError };
      return { ...state, mcp };
    }
    case "ext/model": {
      // Bounded like mcpStatus: a pathological backend must not grow state.
      const model = event.model !== null && event.model.length > 0 ? event.model.slice(0, 200) : null;
      const effort = event.effort !== null && event.effort.length > 0 ? event.effort.slice(0, 100) : null;
      const displayName = event.displayName !== null && event.displayName.length > 0 ? event.displayName.slice(0, 200) : null;
      return { ...state, model, effort, modelLabel: displayName };
    }
    default: {
      return state;
    }
  }
}

/**
 * Header segment for the model/effort line. Shows the catalog display name
 * where known, else the raw model id, else the honest backend default.
 * Never renders "unknown": an unset model is the backend default, not a
 * missing value. Rendered via textContent only (no HTML).
 */
export function formatModelSegment(model: string | null, effort: string | null, displayName: string | null): string {
  if (model === null && effort === null) {
    return " · model: default";
  }
  const label = displayName ?? model ?? "default";
  return ` · model: ${label}${effort !== null ? ` · effort: ${effort}` : ""}`;
}

function isCollapsibleKind(kind: string): boolean {
  return kind === "commandExecution" || kind === "fileChange" || kind === "reasoning" || kind === "mcpToolCall" || kind === "plan" || kind === "unsupported";
}
