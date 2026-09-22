/**
 * Extension-host ↔ webview message contract. Shared by both sides:
 * - The extension host imports this module directly.
 * - The webview bundle compiles it from the same source (tsconfig.webview.json).
 *
 * Every inbound webview message is validated with the `is*` guards before
 * use. The webview is treated as untrusted input (it renders untrusted model
 * output too); only well-formed, bounded messages reach the backend.
 */

export const WEBVIEW_MESSAGE_TYPES = [
  "webview/ready",
  "composer/send",
  "composer/cancel",
  "composer/saveDraft",
  "approval/decide",
  "approval/answer",
  "tool/expand",
  "session/pick",
  "session/rename",
  "file/openDiff",
  "panel/focus",
] as const;

export const EXTENSION_MESSAGE_TYPES = [
  "ext/state",
  "ext/delta",
  "ext/item",
  "ext/turnStatus",
  "ext/approval",
  "ext/approvalSettled",
  "ext/threads",
  "ext/error",
  "ext/connection",
  "ext/model",
] as const;

export type WebviewMessageType = (typeof WEBVIEW_MESSAGE_TYPES)[number];
export type ExtensionMessageType = (typeof EXTENSION_MESSAGE_TYPES)[number];

export interface WebviewMessage {
  type: WebviewMessageType;
  payload?: unknown;
}

export interface ComposerSendPayload {
  text: string;
  mentions: string[];
}

export interface ApprovalDecidePayload {
  requestId: string | number;
  approved: boolean;
  /** Optional explicit result (permissions grants, answers). */
  result?: unknown;
}

/**
 * Per-question answer submission for `item/tool/requestUserInput` cards.
 * The host forwards it via the existing decide channel as
 * `decideApproval(requestId, { approved: true, result: { answers } })`
 * (see `src/sessions/Approvals.ts` `decide`); this message only carries
 * what the user typed/clicked, never a fabricated approval.
 */
export interface ApprovalAnswerPayload {
  requestId: string | number;
  answers: Record<string, { answers: string[] }>;
}

export const MAX_COMPOSER_TEXT = 64 * 1024;
export const MAX_MENTIONS = 20;
// Explicit approval results (e.g. permissions grants) ride the approval/decide
// channel by design; bound them like composer text so a compromised renderer
// cannot smuggle unbounded payloads into a backend response.
export const MAX_APPROVAL_RESULT = 64 * 1024;
// Bounds for per-question user-input answers (approval/answer channel).
// Shapes mirror the generated
// codex-rs/app-server-protocol/schema/typescript/v2/ToolRequestUserInput{Response,Answer}.ts:
// `{ answers: { [questionId]: { answers: string[] } } }`.
export const MAX_USER_INPUT_QUESTIONS = 20;
export const MAX_USER_INPUT_ANSWERS_PER_QUESTION = 10;
export const MAX_USER_INPUT_ANSWER_VALUE = 4 * 1024;
export const MAX_USER_INPUT_QUESTION_ID = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Strict validation of a user-input answers map. Returns a typed copy or
 * null. Bounds: at most MAX_USER_INPUT_QUESTIONS questions, each a
 * `{ answers: string[] }` with 1..MAX_USER_INPUT_ANSWERS_PER_QUESTION
 * non-empty values of at most MAX_USER_INPUT_ANSWER_VALUE chars. Used by
 * both the webview message validator and the extension host (defense in
 * depth: the host re-checks before calling decideApproval).
 */
export function validateUserInputAnswers(value: unknown): Record<string, { answers: string[] }> | null {
  if (!isRecord(value)) {
    return null;
  }
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > MAX_USER_INPUT_QUESTIONS) {
    return null;
  }
  const out: Record<string, { answers: string[] }> = {};
  for (const [questionId, answer] of entries) {
    if (questionId.length === 0 || questionId.length > MAX_USER_INPUT_QUESTION_ID) {
      return null;
    }
    if (!isRecord(answer) || !Array.isArray(answer["answers"])) {
      return null;
    }
    const values = answer["answers"] as unknown[];
    if (values.length === 0 || values.length > MAX_USER_INPUT_ANSWERS_PER_QUESTION) {
      return null;
    }
    const checked: string[] = [];
    for (const entry of values) {
      if (typeof entry !== "string" || entry.length === 0 || entry.length > MAX_USER_INPUT_ANSWER_VALUE) {
        return null;
      }
      checked.push(entry);
    }
    out[questionId] = { answers: checked };
  }
  return out;
}

/**
 * Bounded display view of one `item/tool/requestUserInput` question for the
 * approval card. Raw params shape per generated
 * codex-rs/app-server-protocol/schema/typescript/v2/ToolRequestUserInput{Params,Question,Option}.ts:
 * `{ questions: Array<{ id, header, question, isOther, isSecret,
 * options: Array<{ label, description }> | null }> }`.
 * All strings are clipped here AND escaped at render time (protocol.ts
 * escapeHtml); secret answers are never logged or echoed.
 */
export interface UserInputOptionView {
  label: string;
  description: string;
}

export interface UserInputQuestionView {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: UserInputOptionView[] | null;
}

const MAX_QUESTION_TEXT = 2000;
const MAX_QUESTION_OPTIONS = 20;
const MAX_OPTION_TEXT = 500;

/** Display label for an option; tolerant of drift beyond generated `{label, description}`. */
function optionLabel(option: Record<string, unknown>): string | null {
  for (const key of ["label", "name", "text", "title", "value"]) {
    const candidate = option[key];
    if (typeof candidate === "string" && candidate !== "") {
      return candidate.slice(0, MAX_OPTION_TEXT);
    }
  }
  return null;
}

function clipField(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value === "") {
    return null;
  }
  return value.slice(0, max);
}

/** Normalize one raw question to its bounded view; null when malformed. */
export function normalizeUserInputQuestion(raw: unknown): UserInputQuestionView | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = clipField(raw["id"], MAX_USER_INPUT_QUESTION_ID);
  const header = clipField(raw["header"], MAX_QUESTION_TEXT);
  const question = clipField(raw["question"], MAX_QUESTION_TEXT);
  if (id === null || header === null || question === null) {
    return null;
  }
  let options: UserInputOptionView[] | null = null;
  const rawOptions = raw["options"];
  if (rawOptions !== null && rawOptions !== undefined) {
    if (!Array.isArray(rawOptions)) {
      return null;
    }
    options = [];
    for (const entry of rawOptions.slice(0, MAX_QUESTION_OPTIONS)) {
      if (!isRecord(entry)) {
        continue;
      }
      const label = optionLabel(entry);
      if (label === null) {
        continue;
      }
      const description = typeof entry["description"] === "string" ? (entry["description"] as string).slice(0, MAX_OPTION_TEXT) : "";
      options.push({ label, description });
    }
  }
  return {
    id,
    header,
    question,
    isOther: raw["isOther"] === true,
    isSecret: raw["isSecret"] === true,
    options,
  };
}

/**
 * Extract bounded question views from raw `item/tool/requestUserInput`
 * params. Returns null when the questions array is empty or nothing in it
 * is well-formed — the card then falls back to Deny-only (never fabricates
 * answers).
 */
export function extractUserInputQuestions(params: unknown): UserInputQuestionView[] | null {
  if (!isRecord(params) || !Array.isArray(params["questions"])) {
    return null;
  }
  const views: UserInputQuestionView[] = [];
  for (const raw of (params["questions"] as unknown[]).slice(0, MAX_USER_INPUT_QUESTIONS)) {
    const view = normalizeUserInputQuestion(raw);
    if (view !== null) {
      views.push(view);
    }
  }
  return views.length > 0 ? views : null;
}

/** Strict validation of extension←webview messages. Returns a typed copy or null. */
export function validateWebviewMessage(raw: unknown): WebviewMessage | null {
  if (!isRecord(raw) || typeof raw["type"] !== "string") {
    return null;
  }
  const type = raw["type"] as string;
  if (!(WEBVIEW_MESSAGE_TYPES as readonly string[]).includes(type)) {
    return null;
  }
  const payload = raw["payload"];
  switch (type) {
    case "composer/send": {
      if (!isRecord(payload) || typeof payload["text"] !== "string") {
        return null;
      }
      const text = payload["text"] as string;
      if (text.length === 0 || text.length > MAX_COMPOSER_TEXT) {
        return null;
      }
      const mentions = Array.isArray(payload["mentions"]) ? (payload["mentions"] as unknown[]).filter((entry): entry is string => typeof entry === "string").slice(0, MAX_MENTIONS) : [];
      return { type, payload: { text, mentions } as ComposerSendPayload };
    }
    case "composer/cancel":
    case "webview/ready":
    case "panel/focus":
      return { type };
    case "composer/saveDraft": {
      if (!isRecord(payload) || typeof payload["text"] !== "string" || (payload["text"] as string).length > MAX_COMPOSER_TEXT) {
        return null;
      }
      return { type, payload: { text: payload["text"] as string } };
    }
    case "approval/decide": {
      if (!isRecord(payload)) {
        return null;
      }
      const requestId = payload["requestId"];
      if (typeof requestId !== "string" && typeof requestId !== "number") {
        return null;
      }
      if (typeof payload["approved"] !== "boolean") {
        return null;
      }
      const decisionResult = payload["result"];
      if (decisionResult !== undefined) {
        let serialized: string;
        try {
          serialized = JSON.stringify(decisionResult) ?? "";
        } catch {
          return null;
        }
        if (serialized.length > MAX_APPROVAL_RESULT) {
          return null;
        }
      }
      return { type, payload: { requestId, approved: payload["approved"] as boolean, result: payload["result"] } as ApprovalDecidePayload };
    }
    case "approval/answer": {
      if (!isRecord(payload)) {
        return null;
      }
      const requestId = payload["requestId"];
      if (typeof requestId !== "string" && typeof requestId !== "number") {
        return null;
      }
      const answers = validateUserInputAnswers(payload["answers"]);
      if (answers === null) {
        return null;
      }
      return { type, payload: { requestId, answers } as ApprovalAnswerPayload };
    }
    case "tool/expand": {
      if (!isRecord(payload) || typeof payload["itemId"] !== "string") {
        return null;
      }
      return { type, payload: { itemId: payload["itemId"] as string } };
    }
    case "session/pick": {
      if (!isRecord(payload) || typeof payload["threadId"] !== "string") {
        return null;
      }
      return { type, payload: { threadId: payload["threadId"] as string } };
    }
    case "session/rename": {
      if (!isRecord(payload) || typeof payload["name"] !== "string" || (payload["name"] as string).length > 200) {
        return null;
      }
      return { type, payload: { name: payload["name"] as string } };
    }
    case "file/openDiff": {
      if (!isRecord(payload) || typeof payload["uri"] !== "string" || typeof payload["title"] !== "string") {
        return null;
      }
      return { type, payload: { uri: payload["uri"] as string, title: payload["title"] as string } };
    }
    default:
      return null;
  }
}

/**
 * Minimal HTML escaping used by the webview before inserting model/tool
 * text. The webview renders markdown through this escape + a tiny safe
 * subset (code spans, bold, links with http(s) only); raw HTML from the
 * model is never interpreted.
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Allow only http(s) links; everything else renders as plain text. */
export function sanitizeLinkUrl(url: string): string | null {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed) && !/[\s<>"]/.test(trimmed) && trimmed.length <= 2048) {
    return trimmed;
  }
  return null;
}
