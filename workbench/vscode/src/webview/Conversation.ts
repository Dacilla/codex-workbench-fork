/** Safe text rendering: escaped HTML + a tiny markdown subset (code, bold, links). */
import { escapeHtml, sanitizeLinkUrl } from "./protocol.js";

export function renderSafeText(text: string): string {
  // Escape first; then re-introduce a minimal safe subset.
  const escaped = escapeHtml(text);
  return escaped
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match: string, label: string, url: string) => {
      const safe = sanitizeLinkUrl(url);
      return safe !== null ? `<a href="${safe}">${label}</a>` : label;
    })
    .replace(/\n/g, "<br>");
}
