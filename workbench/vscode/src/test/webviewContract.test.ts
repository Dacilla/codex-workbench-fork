/** Unit tests: webview message validation, sanitization, reducer, IDE helpers. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, sanitizeLinkUrl, validateWebviewMessage } from "../webview/protocol";
import { renderSafeText } from "../webview/Conversation";
import { initialState, reduce } from "../webview/state";
import { toolCardHtml } from "../webview/ToolActivity";
import { isRemoteUri, referenceFromEditorContext, renderReferenceAsMention } from "../ide/UriContext";
import { diffCandidateFor } from "../ide/DiffProvider";
import { parseInboundLine } from "../backend/JsonRpcTransport";

describe("validateWebviewMessage", () => {
  it("accepts a well-formed send", () => {
    assert.deepEqual(validateWebviewMessage({ type: "composer/send", payload: { text: "hi", mentions: ["@a", 42] } }), {
      type: "composer/send",
      payload: { text: "hi", mentions: ["@a"] },
    });
  });

  it("rejects unknown types, oversized text, and bad approval ids", () => {
    assert.equal(validateWebviewMessage({ type: "ext/state" }), null);
    assert.equal(validateWebviewMessage({ type: "composer/send", payload: { text: "" } }), null);
    assert.equal(validateWebviewMessage({ type: "composer/send", payload: { text: "x".repeat(70 * 1024) } }), null);
    assert.equal(validateWebviewMessage({ type: "approval/decide", payload: { requestId: null, approved: true } }), null);
    assert.equal(validateWebviewMessage("nope"), null);
    assert.equal(validateWebviewMessage({ type: "session/rename", payload: { name: "x".repeat(500) } }), null);
  });

  it("bounds explicit approval results, accepts small ones", () => {
    const small = validateWebviewMessage({ type: "approval/decide", payload: { requestId: "r-1", approved: true, result: { decision: "accept" } } });
    assert.deepEqual(small, { type: "approval/decide", payload: { requestId: "r-1", approved: true, result: { decision: "accept" } } });
    assert.equal(validateWebviewMessage({ type: "approval/decide", payload: { requestId: "r-1", approved: true, result: { blob: "x".repeat(70 * 1024) } } }), null);
    assert.equal(validateWebviewMessage({ type: "approval/decide", payload: { requestId: "r-1", approved: false } })?.type, "approval/decide");
  });
});

describe("sanitization", () => {
  it("escapes HTML and allows only http(s) links", () => {
    assert.equal(escapeHtml(`<img src=x onerror=alert(1)>`), "&lt;img src=x onerror=alert(1)&gt;");
    assert.equal(sanitizeLinkUrl("https://example.com/a"), "https://example.com/a");
    assert.equal(sanitizeLinkUrl("javascript:alert(1)"), null);
    assert.equal(sanitizeLinkUrl("vscode-remote://host/x"), null);
  });

  it("renders fenced code blocks with language labels, never as markup", () => {
    const html = renderSafeText("Here:\n```cpp\n#include <x>\nint main() {}\n```\nDone `y`.");
    assert.ok(html.includes('<div class="wb-codeblock">'));
    assert.ok(html.includes('<div class="wb-codeblock-lang">cpp</div>'));
    assert.ok(html.includes("#include &lt;x&gt;"), "fence body stays escaped");
    assert.ok(!html.includes("<x>"));
    assert.ok(html.includes("<code>y</code>"), "inline code still works outside fences");
    const unclosed = renderSafeText("Start\n```py\nprint(1)");
    assert.ok(unclosed.includes('<div class="wb-codeblock-lang">py</div>'));
    assert.ok(unclosed.includes("print(1)"));
    const fencedInline = renderSafeText("```\n**not bold** and `not code`\n```");
    assert.ok(!fencedInline.includes("<strong>"), "no inline markdown inside fences");
    assert.ok(!fencedInline.includes("<code>not code</code>"));
  });

  it("rejects non-JSON and non-object wire lines", () => {
    assert.equal(parseInboundLine("   "), null);
    assert.throws(() => parseInboundLine("not json{"), /non-JSON/);
    assert.throws(() => parseInboundLine("[1,2]"), /non-object/);
  });

  it("parses all four wire shapes without a jsonrpc field", () => {
    assert.deepEqual(parseInboundLine(`{"id":"1","method":"m","params":{"a":1}}`), {
      kind: "request",
      request: { id: "1", method: "m", params: { a: 1 } },
    });
    assert.deepEqual(parseInboundLine(`{"id":"1","result":{"ok":true}}`), { kind: "response", id: "1", result: { ok: true } });
    const errored = parseInboundLine(`{"id":7,"error":{"code":-32601,"message":"nope"}}`);
    assert.equal(errored?.kind, "error");
    const notified = parseInboundLine(`{"method":"account/updated","params":{},"emittedAtMs":5}`);
    assert.equal(notified?.kind, "notification");
  });
});

describe("conversation reducer", () => {
  it("appends deltas, replaces on finalize, ignores stale deltas", () => {
    let state = initialState();
    state = reduce(state, { type: "ext/delta", turnId: "turn-1", itemId: "item-1", kind: "agentMessage", delta: "hello " });
    state = reduce(state, { type: "ext/delta", turnId: "turn-1", itemId: "item-1", kind: "agentMessage", delta: "world" });
    assert.equal(state.items[0]?.text, "hello world");
    state = reduce(state, { type: "ext/item", turnId: "turn-1", itemId: "item-1", kind: "agentMessage", text: "final" });
    assert.equal(state.items.length, 1, "no duplicate item after finalize");
    assert.equal(state.items[0]?.text, "final");
    const before = state;
    state = reduce(state, { type: "ext/delta", turnId: "turn-1", itemId: "item-1", kind: "agentMessage", delta: "stale" });
    assert.equal(state, before, "stale delta after finalize is ignored");
  });

  it("dedups approval cards and records settlement", () => {
    let state = initialState();
    state = reduce(state, { type: "ext/approval", requestId: "r-1", method: "m", summary: "s" });
    state = reduce(state, { type: "ext/approval", requestId: "r-1", method: "m", summary: "s" });
    assert.equal(state.approvals.length, 1);
    state = reduce(state, { type: "ext/approvalSettled", requestId: "r-1", approved: false, failClosed: true });
    assert.equal(state.approvals[0]?.settled, true);
    assert.equal(state.approvals[0]?.failClosed, true);
  });

  it("adopts the optimistic local echo instead of duplicating", () => {
    let state = initialState();
    state = reduce(state, { type: "ext/item", turnId: "local", itemId: "local-1", kind: "userMessage", text: "Test" });
    assert.equal(state.items.length, 1);
    state = reduce(state, { type: "ext/item", turnId: "t-1", itemId: "backend-9", kind: "userMessage", text: "Test" });
    assert.equal(state.items.length, 1, "backend echo adopts the local card");
    assert.equal(state.items[0]?.itemId, "backend-9");
    assert.equal(state.items[0]?.turnId, "t-1");
    // A genuinely different message still appends.
    state = reduce(state, { type: "ext/item", turnId: "t-1", itemId: "backend-10", kind: "userMessage", text: "Other" });
    assert.equal(state.items.length, 2);
  });

  it("renders friendly collapsed tool cards with previews", () => {
    const html = toolCardHtml({ itemId: "r-1", turnId: "t-1", kind: "reasoning", text: "First line\nSecond line", status: "final", collapsed: true });
    assert.ok(html.includes("▸"));
    assert.ok(html.includes("Thinking"));
    assert.ok(html.includes("First line"));
    assert.ok(!html.includes("Second line"));
    assert.ok(!html.includes("<br>"));
    const open = toolCardHtml({ itemId: "r-1", turnId: "t-1", kind: "commandExecution", text: "a\nb", status: "final", collapsed: false });
    assert.ok(open.includes("▾"));
    assert.ok(open.includes("Terminal"));
    assert.ok(open.includes("a<br>b"));
  });

  it("tracks MCP status per server without timeline items", () => {
    let state = initialState();
    state = reduce(state, { type: "ext/mcpStatus", server: "docs", status: "starting", hasError: false });
    state = reduce(state, { type: "ext/mcpStatus", server: "docs", status: "connected", hasError: false });
    state = reduce(state, { type: "ext/mcpStatus", server: "other", status: "failed", hasError: true });
    assert.deepEqual(state.mcp, {
      docs: { status: "connected", hasError: false },
      other: { status: "failed", hasError: true },
    });
    assert.equal(state.items.length, 0, "status updates never append timeline items");
    state = reduce(state, { type: "ext/mcpStatus", server: "", status: "connected", hasError: false });
    assert.equal(Object.keys(state.mcp).length, 2, "empty server names ignored");
  });

  it("arms a first-token placeholder on turn start, clears on content", () => {
    let state = initialState();
    assert.equal(state.awaitingFirstToken, false);
    state = reduce(state, { type: "ext/turnStatus", turnId: "t-1", status: "inProgress" });
    assert.equal(state.awaitingFirstToken, true);
    state = reduce(state, { type: "ext/delta", turnId: "t-1", itemId: "i-1", kind: "agentMessage", delta: "hi" });
    assert.equal(state.awaitingFirstToken, false);
    state = reduce(state, { type: "ext/turnStatus", turnId: "t-2", status: "inProgress" });
    state = reduce(state, { type: "ext/turnStatus", turnId: "t-2", status: "completed" });
    assert.equal(state.awaitingFirstToken, false, "terminal status clears the placeholder");
  });

  it("keeps the placeholder through our own echo, clears on agent content", () => {
    let state = initialState();
    state = reduce(state, { type: "ext/item", turnId: "local", itemId: "local-1", kind: "userMessage", text: "hi" });
    state = reduce(state, { type: "ext/turnStatus", turnId: "t-1", status: "inProgress" });
    assert.equal(state.awaitingFirstToken, true);
    state = reduce(state, { type: "ext/item", turnId: "t-1", itemId: "backend-1", kind: "userMessage", text: "hi" });
    assert.equal(state.items.length, 1, "echo adopted");
    assert.equal(state.awaitingFirstToken, true, "backend echo is not agent content");
    state = reduce(state, { type: "ext/item", turnId: "t-1", itemId: "backend-2", kind: "agentMessage", text: "hello" });
    assert.equal(state.awaitingFirstToken, false);
  });
});

describe("IDE helpers", () => {
  it("preserves remote authority and truncates excerpts", () => {
    assert.equal(isRemoteUri("vscode-remote://ssh-host/home/a.ts"), true);
    assert.equal(isRemoteUri("file:///c%3A/a.ts"), false);
    const reference = referenceFromEditorContext(
      { uri: "vscode-remote://ssh-host/home/a.ts", scheme: "vscode-remote", fileName: "a.ts", languageId: "typescript", selection: { startLine: 3, endLine: 5, text: "x".repeat(9000) } },
      true,
    );
    assert.ok((reference.excerpt?.length ?? 0) <= 4100);
    assert.equal(renderReferenceAsMention(reference), "@vscode-remote://ssh-host/home/a.ts#L3-L5");
  });

  it("only real file paths become diff candidates", () => {
    assert.equal(diffCandidateFor("w", { path: "https://example.com/x" }), null);
    assert.equal(diffCandidateFor("w", { path: "untitled:1" }), null);
    assert.equal(diffCandidateFor("w", {}), null);
    const candidate = diffCandidateFor("vscode-remote://h/work", { path: "src/a.ts" });
    assert.ok(candidate !== null && candidate.uri.includes("src/a.ts"));
  });
});
