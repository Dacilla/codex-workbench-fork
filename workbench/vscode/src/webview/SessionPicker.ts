/** Empty-state session picker rendered inside the webview (native Quick Pick lives extension-side). */
import { escapeHtml } from "./protocol.js";

export interface SessionSummary {
  threadId: string;
  name: string;
  preview: string;
}

export function sessionPickerHtml(sessions: SessionSummary[]): string {
  if (sessions.length === 0) {
    return `<div class="wb-empty">No previous chats in this workspace yet. Type below to start one.</div>`;
  }
  const rows = sessions.map((session) =>
    `<button class="wb-session" data-action="pick" data-thread-id="${escapeHtml(session.threadId)}">`
    + `<span class="wb-session-name">${escapeHtml(session.name)}</span>`
    + `<span class="wb-session-preview">${escapeHtml(session.preview)}</span></button>`,
  ).join("");
  return `<div class="wb-empty"><div>Resume a recent chat:</div>${rows}</div>`;
}
