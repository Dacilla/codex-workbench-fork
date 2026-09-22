/**
 * Per-kind approval cards.
 *
 * Kinds come from `classifyApproval` in `src/sessions/Approvals.ts`
 * (forwarded by the host on `ext/approval`); question views are shaped in
 * `src/webview/protocol.ts` (`extractUserInputQuestions`, mirroring generated
 * codex-rs/app-server-protocol/schema/typescript/v2/ToolRequestUserInput{Params,Question,Option}.ts).
 *
 * - commandExecution, fileChange, v1ApplyPatch, v1ExecCommand, elicitation:
 *   Approve/Deny (their `approveResult` shapes exist).
 * - permissions, dynamicTool, unknown: Deny ONLY with an honest one-line
 *   reason. Approve would fail closed into a silent deny
 *   (`approveResult` is null), so no Approve button is offered.
 * - userInput: one block per question (header + question, single-select
 *   radio options; password input when isSecret; extra free-text field when
 *   isOther) with a per-question Answer button that posts
 *   `approval/answer` { requestId, answers: { [id]: { answers: [chosen] } } }
 *   (response shape per generated ToolRequestUserInput{Response,Answer}.ts),
 *   plus Deny. Empty/malformed questions fall back to Deny-only.
 *
 * All rendered question/option text is escaped; secret inputs are never
 * echoed or logged.
 */
import { escapeHtml } from "./protocol.js";
import type { UserInputQuestionView } from "./protocol.js";
import type { ApprovalCard } from "./state.js";

/** Kinds whose approve payload exists (`approveResult` non-null). */
const APPROVE_KINDS = new Set([
  "commandExecution",
  "fileChange",
  "v1ApplyPatch",
  "v1ExecCommand",
  "elicitation",
]);

const DENY_ONLY_REASONS: Record<string, string> = {
  permissions: "grant profiles aren't supported in this client yet — deny only",
  dynamicTool: "unsupported request type — deny only",
  unknown: "unsupported request type — deny only",
};

const USER_INPUT_FALLBACK_REASON = "question list was empty or malformed — deny only (no answers fabricated)";

function denyButton(requestId: string | number): string {
  return `<button data-action="deny" data-request-id="${escapeHtml(String(requestId))}">Deny</button>`;
}

function settledStatus(card: ApprovalCard): string {
  if (card.failClosed) {
    return "denied automatically (connection lost)";
  }
  if (card.approved === true) {
    return "approved";
  }
  return "denied";
}

function questionBlock(requestId: string | number, question: UserInputQuestionView, index: number): string {
  const group = `wb-answer-${escapeHtml(String(requestId))}-${index}`;
  const containerOpen = `<div class="wb-approval-question" data-question-id="${escapeHtml(question.id)}">`
    + `<div class="wb-approval-qheader">${escapeHtml(question.header)}</div>`
    + `<div class="wb-approval-qtext">${escapeHtml(question.question)}</div>`;
  if (question.isSecret) {
    // Secret answers use a password input (never radio, never echoed).
    return containerOpen
      + `<input type="password" data-role="secret-answer" maxlength="4096" autocomplete="off" data-1p-ignore="true" aria-label="${escapeHtml(question.header)}">`
      + `<button data-action="answer" data-request-id="${escapeHtml(String(requestId))}">Answer</button></div>`;
  }
  let body = "";
  if (question.options !== null) {
    body += question.options.map((option, optionIndex) =>
      `<label><input type="radio" name="${group}" value="opt-${optionIndex}" data-label="${escapeHtml(option.label)}">`
      + `${escapeHtml(option.label)}${option.description !== "" ? ` — ${escapeHtml(option.description)}` : ""}</label>`,
    ).join("");
  }
  if (question.isOther || question.options === null) {
    // Free text is allowed only when isOther or when no options exist.
    body += `<input type="text" data-role="other-answer" maxlength="4096" autocomplete="off" placeholder="Other…">`;
  }
  return containerOpen + body
    + `<button data-action="answer" data-request-id="${escapeHtml(String(requestId))}">Answer</button></div>`;
}

export function approvalCardHtml(card: ApprovalCard): string {
  const status = card.settled ? settledStatus(card) : "awaiting decision";
  const head = `<div class="wb-approval" data-request-id="${escapeHtml(String(card.requestId))}">`
    + `<div class="wb-approval-title">Approval required — ${escapeHtml(status)}</div>`
    + `<div class="wb-approval-summary">${escapeHtml(card.summary)}</div>`
    + `<div class="wb-approval-method">${escapeHtml(card.method)}</div>`;
  if (card.settled) {
    return `${head}<div class="wb-approval-actions"></div></div>`;
  }
  if (card.kind === "userInput") {
    if (card.questions === null) {
      return `${head}<div class="wb-approval-reason">${escapeHtml(USER_INPUT_FALLBACK_REASON)}</div>`
        + `<div class="wb-approval-actions">${denyButton(card.requestId)}</div></div>`;
    }
    const blocks = card.questions.map((question, index) => questionBlock(card.requestId, question, index)).join("");
    return `${head}${blocks}<div class="wb-approval-actions">${denyButton(card.requestId)}</div></div>`;
  }
  if (APPROVE_KINDS.has(card.kind)) {
    return `${head}<div class="wb-approval-actions">`
      + `<button data-action="approve" data-request-id="${escapeHtml(String(card.requestId))}">Approve</button>`
      + denyButton(card.requestId)
      + `</div></div>`;
  }
  const reason = DENY_ONLY_REASONS[card.kind] ?? DENY_ONLY_REASONS["unknown"] as string;
  return `${head}<div class="wb-approval-reason">${escapeHtml(reason)}</div>`
    + `<div class="wb-approval-actions">${denyButton(card.requestId)}</div></div>`;
}
