/** Explicit approval card: exact command/diff/target, Approve/Deny, single-shot buttons. */
import { escapeHtml } from "./protocol.js";
import type { ApprovalCard } from "./state.js";

export function approvalCardHtml(card: ApprovalCard): string {
  const status = card.settled
    ? (card.failClosed ? "denied automatically (connection lost)" : card.approved ? "approved" : "denied")
    : "awaiting decision";
  const buttons = card.settled
    ? ""
    : `<button data-action="approve" data-request-id="${escapeHtml(String(card.requestId))}">Approve</button>`
    + `<button data-action="deny" data-request-id="${escapeHtml(String(card.requestId))}">Deny</button>`;
  return `<div class="wb-approval" data-request-id="${escapeHtml(String(card.requestId))}">`
    + `<div class="wb-approval-title">Approval required — ${escapeHtml(status)}</div>`
    + `<div class="wb-approval-summary">${escapeHtml(card.summary)}</div>`
    + `<div class="wb-approval-method">${escapeHtml(card.method)}</div>`
    + `<div class="wb-approval-actions">${buttons}</div></div>`;
}
