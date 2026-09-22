/**
 * Webview entry point (runs inside the WebviewPanel, no Node, no vscode import).
 * Extension host injects `window.__wbInitial` before this module loads:
 *   { threadId, draft, nonce-safe base state }
 */
import { approvalCardHtml } from "./Approval.js";
import { mountComposer, setComposerContext } from "./Composer.js";
import { renderSafeText } from "./Conversation.js";
import { sessionPickerHtml } from "./SessionPicker.js";
import { toolCardHtml } from "./ToolActivity.js";
import type { ApprovalCard, ChatItem, ConversationState, ExtensionEvent } from "./state.js";
import { formatModelSegment, formatModeSegment, initialState, reduce } from "./state.js";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): unknown; setState(state: unknown): void };

interface InitialData {
  threadId: string;
  draft: string;
}

const vscode = acquireVsCodeApi();
let state: ConversationState = initialState();
let mentions: string[] = [];
let sessions: Array<{ threadId: string; name: string; preview: string }> = [];
let decidedRequests = new Set<string>();

const initial = (window as unknown as { __wbInitial?: InitialData }).__wbInitial;
const threadId = initial?.threadId ?? "";

function post(type: string, payload?: unknown): void {
  vscode.postMessage(payload === undefined ? { type } : { type, payload });
}

function render(): void {
  const convo = document.getElementById("wb-convo");
  const status = document.getElementById("wb-status");
  if (status !== null) {
    const turn = state.turnStatus === "idle" ? "idle" : state.turnStatus;
    status.textContent = `${state.connection} · ${turn}${state.activeTurnId !== null ? ` (${state.activeTurnId.slice(0, 8)})` : ""}${formatModelSegment(state.model, state.effort, state.modelLabel)}${formatModeSegment(state.mode)}${mcpSegment()}${state.droppedEvents > 0 ? ` · ${state.droppedEvents} buffered events dropped` : ""}${state.error !== null ? ` · ${state.error}` : ""}`;
  }
  if (convo === null) {
    return;
  }
  if (state.items.length === 0 && state.approvals.length === 0) {
    convo.innerHTML = sessionPickerHtml(sessions);
    return;
  }
  const parts: string[] = [];
  for (const item of state.items) {
    parts.push(renderItem(item));
  }
  if (state.awaitingFirstToken) {
    parts.push(`<div class="wb-pending" aria-live="polite"><span class="wb-pending-dot"></span>Working…</div>`);
  }
  for (const card of state.approvals) {
    parts.push(approvalCardHtml(card));
  }
  convo.innerHTML = parts.join("");
  convo.scrollTop = convo.scrollHeight;
}

function mcpSegment(): string {
  const entries = Object.entries(state.mcp);
  if (entries.length === 0) {
    return "";
  }
  const shown = entries.slice(0, 4).map(([server, info]) => `${server} ${info.status}${info.hasError ? "!" : ""}`);
  const extra = entries.length > 4 ? ` +${entries.length - 4} more` : "";
  return ` · MCP: ${shown.join(", ")}${extra}`;
}

function renderItem(item: ChatItem): string {
  if (item.kind === "userMessage") {
    return `<div class="wb-user">${renderSafeText(item.text)}</div>`;
  }
  if (item.kind === "agentMessage" || item.kind === "commentary") {
    return `<div class="wb-agent">${renderSafeText(item.text)}${item.status === "streaming" ? "▍" : ""}</div>`;
  }
  return toolCardHtml(item);
}

function applyEvent(event: ExtensionEvent): void {
  state = reduce(state, event);
  render();
}

window.addEventListener("message", (event: MessageEvent) => {
  const message = event.data as { type?: string } & Record<string, unknown>;
  if (message === null || typeof message !== "object" || typeof message["type"] !== "string") {
    return;
  }
  switch (message["type"]) {
    case "ext/state":
    case "ext/delta":
    case "ext/item":
    case "ext/turnStatus":
    case "ext/approval":
    case "ext/approvalSettled":
    case "ext/error":
    case "ext/connection":
    case "ext/mcpStatus":
    case "ext/model":
      applyEvent(message as unknown as ExtensionEvent);
      break;
    case "ext/threads":
      sessions = Array.isArray(message["threads"]) ? (message["threads"] as typeof sessions) : [];
      render();
      break;
    case "ext/mentions":
      mentions = Array.isArray(message["mentions"]) ? (message["mentions"] as string[]) : [];
      setComposerContext(document.getElementById("wb-composer") as HTMLElement, mentions);
      break;
    default:
      break;
  }
});

/**
 * Read the user's answer for one question block. Returns the single chosen
 * value or null when nothing usable is entered (the card stays active).
 * Secret inputs are read as-is (never trimmed, never logged); free text
 * wins over a checked radio when both are set (explicit typing is the
 * stronger signal). Free text is only read when the field exists, i.e.
 * isOther or no options — matching what the card rendered.
 */
function collectAnswer(container: Element): string | null {
  const secret = container.querySelector('input[data-role="secret-answer"]') as HTMLInputElement | null;
  if (secret !== null) {
    return secret.value === "" ? null : secret.value;
  }
  const other = container.querySelector('input[data-role="other-answer"]') as HTMLInputElement | null;
  if (other !== null && other.value.trim() !== "") {
    return other.value.trim();
  }
  const checked = container.querySelector('input[type="radio"]:checked') as HTMLInputElement | null;
  const label = checked?.getAttribute("data-label") ?? "";
  return label === "" ? null : label;
}

document.addEventListener("click", (event: Event) => {
  const target = event.target as HTMLElement | null;
  const button = target?.closest("button") as HTMLButtonElement | null;
  if (button === null) {
    return;
  }
  const action = button.getAttribute("data-action");
  if (action === "toggle") {
    const card = button.closest("[data-item-id]");
    card?.querySelector(".wb-tool-body")?.classList.toggle("wb-hidden");
    return;
  }
  if ((action === "approve" || action === "deny") && button.dataset["requestId"] !== undefined) {
    const requestId = button.dataset["requestId"] as string;
    if (decidedRequests.has(requestId)) {
      return; // UI-level double-send guard (the host enforces it too).
    }
    decidedRequests.add(requestId);
    button.disabled = true;
    const sibling = button.parentElement?.querySelectorAll("button");
    sibling?.forEach((other) => {
      other.disabled = true;
    });
    post("approval/decide", { requestId, approved: action === "approve" });
    return;
  }
  if (action === "answer" && button.dataset["requestId"] !== undefined) {
    const requestId = button.dataset["requestId"] as string;
    if (decidedRequests.has(requestId)) {
      return; // Same single-shot guard as approve/deny (extended, not duplicated).
    }
    const container = button.closest("[data-question-id]");
    const questionId = container?.getAttribute("data-question-id") ?? "";
    const answer = container !== null ? collectAnswer(container) : null;
    if (questionId === "" || answer === null) {
      return; // Incomplete: leave the card active, decide nothing.
    }
    decidedRequests.add(requestId);
    button.closest(".wb-approval")?.querySelectorAll("button").forEach((other) => {
      other.disabled = true;
    });
    post("approval/answer", { requestId, answers: { [questionId]: { answers: [answer] } } });
    return;
  }
  if (action === "pick" && button.dataset["threadId"] !== undefined) {
    post("session/pick", { threadId: button.dataset["threadId"] });
  }
});

const composerRoot = document.getElementById("wb-composer");
if (composerRoot !== null) {
  mountComposer(composerRoot, {
    onSend: (text: string) => post("composer/send", { text, mentions }),
    onCancel: () => post("composer/cancel"),
    onDraft: (text: string) => post("composer/saveDraft", { text }),
  }, initial?.draft ?? "");
}

post("webview/ready", { threadId });
render();
