/** Safe text rendering: escaped HTML + fenced code blocks + a tiny inline subset (code, bold, links). */
import { escapeHtml, sanitizeLinkUrl } from "./protocol.js";

const MAX_FENCE_CHARS = 64 * 1024;

export function renderSafeText(text: string): string {
  // Escape first so fence bodies can never inject markup; backticks and
  // language tags survive escaping untouched.
  const escaped = escapeHtml(text);
  const parts: string[] = [];
  let rest = escaped;
  for (;;) {
    const open = rest.indexOf("```");
    if (open === -1) {
      parts.push(renderInline(rest));
      break;
    }
    parts.push(renderInline(rest.slice(0, open)));
    const afterOpen = rest.slice(open + 3);
    const newline = afterOpen.indexOf("\n");
    const language = (newline === -1 ? afterOpen : afterOpen.slice(0, newline)).trim().slice(0, 32);
    const bodyStart = newline === -1 ? afterOpen.length : newline + 1;
    const body = afterOpen.slice(bodyStart);
    const close = body.indexOf("```");
    // Unclosed fences render to the end rather than leaking raw backticks.
    const code = (close === -1 ? body : body.slice(0, close)).slice(0, MAX_FENCE_CHARS);
    parts.push(codeBlockHtml(language, code));
    if (close === -1) {
      break;
    }
    rest = body.slice(close + 3);
  }
  return parts.join("");
}

function codeBlockHtml(language: string, code: string): string {
  // Both inputs are already HTML-escaped slices; embedding them raw avoids
  // double-escaping entities, and neither can carry live markup.
  const label = language !== "" ? `<div class="wb-codeblock-lang">${language}</div>` : "";
  return `<div class="wb-codeblock">${label}<pre><code>${code}</code></pre></div>`;
}

function renderInline(text: string): string {
  return text
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match: string, label: string, url: string) => {
      const safe = sanitizeLinkUrl(url);
      return safe !== null ? `<a href="${safe}">${label}</a>` : label;
    })
    .replace(/\n/g, "<br>");
}
