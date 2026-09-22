/** Compact expandable tool-activity card. Large args/results stay collapsed; full detail is explicit. */
import { escapeHtml } from "./protocol.js";
import type { ChatItem } from "./state.js";

export function toolCardHtml(item: ChatItem): string {
  const label = toolLabel(item.kind);
  const toggle = item.collapsed ? "[+]" : "[-]";
  const body = item.collapsed ? "" : `<div class="wb-tool-body">${escapeHtml(item.text).replace(/\n/g, "<br>")}</div>`;
  return `<div class="wb-tool" data-item-id="${escapeHtml(item.itemId)}">`
    + `<button class="wb-tool-head" data-action="toggle">${escapeHtml(toggle)} ${escapeHtml(label)}</button>`
    + `${body}</div>`;
}

function toolLabel(kind: string): string {
  switch (kind) {
    case "commandExecution":
      return "shell command";
    case "fileChange":
      return "file change";
    case "reasoning":
      return "reasoning";
    case "mcpCall":
      return "tool call";
    case "plan":
      return "plan";
    default:
      return kind;
  }
}
