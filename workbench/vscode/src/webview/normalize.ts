/**
 * Schema-aware ThreadItem normalization for the VS Code extension.
 *
 * Real App Server ThreadItem objects do NOT look like `{ kind, text }`.
 * Shapes below mirror the pinned generated schema — do not invent fields:
 * - codex-rs/app-server-protocol/schema/typescript/v2/ThreadItem.ts
 *   (the `type` discriminators and per-variant fields)
 * - codex-rs/app-server-protocol/schema/typescript/v2/UserInput.ts
 *   (userMessage `content` entries; only `text` entries carry text)
 * - codex-rs/app-server-protocol/schema/typescript/v2/FileUpdateChange.ts
 *   (`changes` entries carry `path`/`kind`/`diff`; diffs are never rendered)
 * - codex-rs/app-server-protocol/schema/typescript/v2/PatchChangeKind.ts
 *   (`kind` is `{ type: "add" | "delete" | "update" }`)
 * - codex-rs/app-server-protocol/schema/typescript/v2/McpToolCallStatus.ts,
 *   CommandExecutionStatus.ts, PatchApplyStatus.ts (status vocabularies)
 * - codex-rs/app-server-protocol/schema/typescript/v2/McpToolCallResult.ts
 *   (`result` is `{ content, structuredContent, _meta }` opaque JSON)
 * - codex-rs/app-server-protocol/schema/typescript/v2/McpToolCallError.ts
 *   (`error` is `{ message }`)
 *
 * Items with no renderable content return null so the caller drops them
 * instead of emitting raw kind labels. Variants outside the rendered set
 * (functionCallOutput, dynamicToolCall, collabAgentToolCall,
 * subAgentActivity, webSearch, imageView, sleep, imageGeneration,
 * enteredReviewMode, exitedReviewMode, contextCompaction, hookPrompt) also
 * return null: they carry no plain-text body this view renders. Unknown
 * future `type` values with a non-empty `text` field normalize to
 * `unsupported` (protocol-drift tolerance for reads); unknown shapes
 * without text return null.
 *
 * The MCP argument preview mirrors the CLI compact policy in
 * codex-rs/tui/src/history_cell/mcp_display_policy.rs: JSON numbers,
 * booleans, and nulls render verbatim; strings, arrays, and objects
 * collapse to `key=<hidden: N chars>` (N = Unicode scalar count); at most 8
 * pairs render with a `+N more` suffix; control characters in keys are
 * replaced. Secrets and bulky bodies never echo.
 *
 * Pure module: no Node/vscode imports, shared by the extension host
 * (CommonJS) and the webview bundle (ESM).
 */

export type ViewKind =
  | "userMessage"
  | "agentMessage"
  | "reasoning"
  | "commandExecution"
  | "fileChange"
  | "mcpToolCall"
  | "plan"
  | "unsupported";

export interface ViewItem {
  id: string;
  turnId: string;
  kind: ViewKind;
  text: string;
  detail?: string;
}

/** Item-text ceiling: same 256 KiB philosophy as state.ts MAX_TEXT_PER_ITEM. */
const MAX_TEXT = 256 * 1024;
/** Previews/details stay small enough for a collapsed card body. */
const MAX_SNIPPET = 500;
/** Mirrors MAX_PREVIEW_ARG_PAIRS in the CLI mcp_display_policy.rs. */
const MAX_PREVIEW_ARG_PAIRS = 8;
/** Cap on per-file rows in a fileChange detail block. */
const MAX_FILE_ROWS = 10;
/** Cap on fallback content lines for reasoning without a summary. */
const MAX_REASONING_FALLBACK_LINES = 10;
/** Cap on a single rendered file path inside fileChange detail. */
const MAX_PATH_CHARS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Unicode scalar count, matching Rust `str::chars().count()` in the CLI policy. */
function charCount(text: string): number {
  return [...text].length;
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function collapseToOneLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ").trim();
}

/**
 * Render one UserInput entry (v2/UserInput.ts) as display text.
 * Non-text entries become bracketed placeholders so an image/audio-only
 * message still renders as something honest instead of vanishing.
 */
function userInputText(entry: unknown): string | null {
  if (!isRecord(entry) || typeof entry["type"] !== "string") {
    return null;
  }
  switch (entry["type"] as string) {
    case "text":
      return typeof entry["text"] === "string" ? (entry["text"] as string) : null;
    case "image":
    case "localImage":
      return "[image]";
    case "audio":
    case "localAudio":
      return "[audio]";
    case "skill":
      return typeof entry["name"] === "string" ? `[skill: ${truncate(entry["name"] as string, 100)}]` : "[skill]";
    case "mention":
      return typeof entry["name"] === "string" ? (entry["name"] as string) : "[mention]";
    default:
      return null;
  }
}

function normalizeUserMessage(item: Record<string, unknown>, id: string, turnId: string): ViewItem | null {
  if (!Array.isArray(item["content"])) {
    return null;
  }
  const parts: string[] = [];
  for (const entry of item["content"] as unknown[]) {
    const text = userInputText(entry);
    if (text !== null && text.trim() !== "") {
      parts.push(text);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return { id, turnId, kind: "userMessage", text: truncate(parts.join("\n"), MAX_TEXT) };
}

function normalizePlainText(item: Record<string, unknown>, id: string, turnId: string, kind: ViewKind): ViewItem | null {
  if (!nonBlank(item["text"])) {
    return null;
  }
  return { id, turnId, kind, text: truncate(item["text"] as string, MAX_TEXT) };
}

function normalizeReasoning(item: Record<string, unknown>, id: string, turnId: string): ViewItem | null {
  const summary = Array.isArray(item["summary"])
    ? (item["summary"] as unknown[]).filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    : [];
  if (summary.length > 0) {
    return { id, turnId, kind: "reasoning", text: truncate(summary.join("\n"), MAX_TEXT) };
  }
  // No summary (older history): fall back to the first content lines.
  const content = Array.isArray(item["content"]) ? (item["content"] as unknown[]) : [];
  const lines: string[] = [];
  for (const entry of content) {
    if (typeof entry !== "string") {
      continue;
    }
    for (const line of entry.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed !== "") {
        lines.push(trimmed);
      }
      if (lines.length >= MAX_REASONING_FALLBACK_LINES) {
        break;
      }
    }
    if (lines.length >= MAX_REASONING_FALLBACK_LINES) {
      break;
    }
  }
  if (lines.length === 0) {
    return null;
  }
  return { id, turnId, kind: "reasoning", text: truncate(lines.join("\n"), MAX_TEXT) };
}

function normalizeCommandExecution(item: Record<string, unknown>, id: string, turnId: string): ViewItem | null {
  if (!nonBlank(item["command"])) {
    return null;
  }
  const command = truncate(collapseToOneLine(item["command"] as string), MAX_SNIPPET);
  const status = typeof item["status"] === "string" ? (item["status"] as string) : "unknown";
  const view: ViewItem = { id, turnId, kind: "commandExecution", text: `${command} · ${status}` };
  // Tail-truncated: the last lines of terminal output are the most useful;
  // head would bury the result under scrollback.
  if (nonBlank(item["aggregatedOutput"])) {
    const output = item["aggregatedOutput"] as string;
    view.detail = output.length > MAX_SNIPPET ? `…${output.slice(-MAX_SNIPPET)}` : output;
  }
  return view;
}

function normalizeFileChange(item: Record<string, unknown>, id: string, turnId: string): ViewItem | null {
  if (!Array.isArray(item["changes"]) || (item["changes"] as unknown[]).length === 0) {
    return null;
  }
  const changes = item["changes"] as unknown[];
  const count = changes.length;
  const rows: string[] = [];
  for (const change of changes.slice(0, MAX_FILE_ROWS)) {
    if (!isRecord(change) || typeof change["path"] !== "string") {
      continue;
    }
    const path = truncate(change["path"] as string, MAX_PATH_CHARS);
    const kind = isRecord(change["kind"]) && typeof change["kind"]["type"] === "string" ? (change["kind"]["type"] as string) : "change";
    rows.push(`${path} (${kind})`);
  }
  if (rows.length === 0) {
    return null;
  }
  if (count > MAX_FILE_ROWS) {
    rows.push(`+${count - MAX_FILE_ROWS} more`);
  }
  // Diffs (`diff` per v2/FileUpdateChange.ts) are unbounded blobs: never rendered.
  const view: ViewItem = { id, turnId, kind: "fileChange", text: `${count} file${count === 1 ? "" : "s"} changed` };
  view.detail = truncate(rows.join("\n"), MAX_SNIPPET);
  return view;
}

/** One `key=value` pair per the CLI allowlist policy (see module doc). */
function previewPair(key: string, value: unknown): string {
  const clean = key.replace(/[\u0000-\u001F\u007F-\u009F]/g, "�");
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return `${clean}=${String(value)}`;
  }
  if (typeof value === "string") {
    return `${clean}=<hidden: ${charCount(value)} chars>`;
  }
  let chars = 0;
  try {
    chars = charCount(JSON.stringify(value) ?? "");
  } catch {
    chars = 0;
  }
  return `${clean}=<hidden: ${chars} chars>`;
}

/** Allowlisted argument summary, or null when there are no object arguments. */
function previewArgsSummary(args: unknown): string | null {
  if (!isRecord(args)) {
    return null;
  }
  const keys = Object.keys(args);
  if (keys.length === 0) {
    return null;
  }
  const pairs = keys.slice(0, MAX_PREVIEW_ARG_PAIRS).map((key) => previewPair(key, (args as Record<string, unknown>)[key]));
  let summary = pairs.join(" · ");
  if (keys.length > MAX_PREVIEW_ARG_PAIRS) {
    summary += ` · +${keys.length - MAX_PREVIEW_ARG_PAIRS} more`;
  }
  return summary;
}

function normalizeMcpToolCall(item: Record<string, unknown>, id: string, turnId: string): ViewItem | null {
  if (!nonBlank(item["server"]) || !nonBlank(item["tool"])) {
    return null;
  }
  const server = item["server"] as string;
  const tool = item["tool"] as string;
  const status = typeof item["status"] === "string" ? (item["status"] as string) : "unknown";
  const view: ViewItem = { id, turnId, kind: "mcpToolCall", text: `${server}.${tool} · ${status}` };
  const lines: string[] = [];
  const argsSummary = previewArgsSummary(item["arguments"]);
  if (argsSummary !== null) {
    lines.push(argsSummary);
  }
  if (isRecord(item["error"]) && nonBlank(item["error"]["message"])) {
    lines.push(`error: ${truncate(item["error"]["message"] as string, MAX_SNIPPET)}`);
  } else if (item["result"] !== null && item["result"] !== undefined) {
    // Opaque result JSON (v2/McpToolCallResult.ts): collapse large payloads
    // instead of echoing tool output into the timeline.
    let chars = 0;
    try {
      chars = charCount(JSON.stringify(item["result"]) ?? "");
    } catch {
      chars = 0;
    }
    lines.push(`result <hidden: ${chars} chars>`);
  }
  if (lines.length > 0) {
    view.detail = truncate(lines.join("\n"), MAX_SNIPPET);
  }
  return view;
}

/**
 * Normalize one raw ThreadItem into render-ready view data.
 * Returns null when the item carries no renderable content.
 */
export function normalizeThreadItem(raw: unknown, turnId: string): ViewItem | null {
  if (!isRecord(raw) || typeof raw["type"] !== "string") {
    return null;
  }
  if (typeof raw["id"] !== "string" || (raw["id"] as string) === "") {
    return null;
  }
  const id = raw["id"] as string;
  switch (raw["type"] as string) {
    case "userMessage":
      return normalizeUserMessage(raw, id, turnId);
    case "agentMessage":
      return normalizePlainText(raw, id, turnId, "agentMessage");
    case "plan":
      return normalizePlainText(raw, id, turnId, "plan");
    case "reasoning":
      return normalizeReasoning(raw, id, turnId);
    case "commandExecution":
      return normalizeCommandExecution(raw, id, turnId);
    case "fileChange":
      return normalizeFileChange(raw, id, turnId);
    case "mcpToolCall":
      return normalizeMcpToolCall(raw, id, turnId);
    default: {
      // Unknown future variant: render an honest unsupported card only when
      // it carries plain text; otherwise drop it instead of a kind label.
      if (nonBlank(raw["text"])) {
        return { id, turnId, kind: "unsupported", text: truncate(raw["text"] as string, MAX_TEXT) };
      }
      return null;
    }
  }
}
