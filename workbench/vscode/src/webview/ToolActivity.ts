/** Compact expandable tool-activity card. Large args/results stay collapsed; full detail is explicit. */
import { escapeHtml } from "./protocol.js";
import type { ChatItem } from "./state.js";

const COLLAPSED_PREVIEW_CHARS = 120;

export function toolCardHtml(item: ChatItem): string {
  const label = toolLabel(item.kind);
  const toggle = item.collapsed ? "▸" : "▾";
  const preview = item.collapsed ? collapsedPreview(item.text) : "";
  const body = item.collapsed ? "" : `<div class="wb-tool-body">${escapeHtml(item.text).replace(/\n/g, "<br>")}</div>`;
  return `<div class="wb-tool" data-item-id="${escapeHtml(item.itemId)}">`
    + `<button class="wb-tool-head" data-action="toggle">${escapeHtml(toggle)} ${escapeHtml(label)}${preview}</button>`
    + `${body}</div>`;
}

function collapsedPreview(text: string): string {
  const firstLine = text.split("\n", 1)[0] ?? "";
  const trimmed = firstLine.trim();
  if (trimmed.length === 0) {
    return "";
  }
  const short = trimmed.length > COLLAPSED_PREVIEW_CHARS ? `${trimmed.slice(0, COLLAPSED_PREVIEW_CHARS)}…` : trimmed;
  return ` <span class="wb-tool-preview">${escapeHtml(short)}</span>`;
}

function toolLabel(kind: string): string {
  switch (kind) {
    case "commandExecution":
      return "Terminal";
    case "fileChange":
      return "Edit";
    case "reasoning":
      return "Thinking";
    case "mcpCall":
      return "Tool";
    case "plan":
      return "Plan";
    default:
      return kind;
  }
}
