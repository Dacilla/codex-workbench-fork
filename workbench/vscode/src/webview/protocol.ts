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

export const MAX_COMPOSER_TEXT = 64 * 1024;
export const MAX_MENTIONS = 20;
// Explicit approval results (e.g. permissions grants) ride the approval/decide
// channel by design; bound them like composer text so a compromised renderer
// cannot smuggle unbounded payloads into a backend response.
export const MAX_APPROVAL_RESULT = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
