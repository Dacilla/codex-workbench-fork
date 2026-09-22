/** Unit tests: webview message validation, sanitization, reducer, IDE helpers. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, sanitizeLinkUrl, validateWebviewMessage } from "../webview/protocol";
import { initialState, reduce } from "../webview/state";
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
