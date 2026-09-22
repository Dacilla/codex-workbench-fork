/** Unit tests: webview message validation, sanitization, reducer, IDE helpers. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, extractUserInputQuestions, sanitizeLinkUrl, validateUserInputAnswers, validateWebviewMessage } from "../webview/protocol";
import { approvalCardHtml } from "../webview/Approval";
import { renderSafeText } from "../webview/Conversation";
import { initialState, reduce } from "../webview/state";
import type { ApprovalCard } from "../webview/state";
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

  it("adopts echoes that include attachment mentions", () => {
    // The local echo carries the exact sent text (mentions included); a
    // bare-text echo could never match the backend echo and double-rendered.
    const sent = "@file:///repo/AGENTS.md#L1-L321\nHow many lines do I have selected";
    let state = initialState();
    state = reduce(state, { type: "ext/item", turnId: "local", itemId: "local-1", kind: "userMessage", text: sent });
    state = reduce(state, { type: "ext/item", turnId: "t-1", itemId: "backend-9", kind: "userMessage", text: sent });
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0]?.itemId, "backend-9");
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

function userInputParams(): Record<string, unknown> {
  return {
    threadId: "t-1",
    turnId: "turn-1",
    itemId: "item-1",
    isBlocking: true,
    questions: [
      { id: "q-color", header: "Color", question: "Pick a color?", isOther: false, isSecret: false, options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "" }] },
      { id: "q-secret", header: "Token", question: "Paste the token?", isOther: false, isSecret: true, options: [{ label: "x", description: "" }] },
      { id: "q-other", header: "Editor", question: "Which editor?", isOther: true, isSecret: false, options: null },
    ],
  };
}

function cardFor(kind: string, questions: ApprovalCard["questions"] = null): ApprovalCard {
  return { requestId: "r-1", method: `method/${kind}`, kind, summary: "s", questions, settled: false, approved: null, failClosed: false };
}

describe("approval/answer validation", () => {
  it("accepts well-formed answers", () => {
    const answers = { "q-1": { answers: ["Red"] }, "q-2": { answers: ["s3cret"] } };
    assert.deepEqual(validateUserInputAnswers(answers), answers);
    assert.deepEqual(validateWebviewMessage({ type: "approval/answer", payload: { requestId: "r-1", answers } }), {
      type: "approval/answer",
      payload: { requestId: "r-1", answers },
    });
  });

  it("rejects oversized and malformed answers", () => {
    assert.equal(validateUserInputAnswers({}), null, "empty map answers nothing");
    assert.equal(validateUserInputAnswers({ "q": { answers: [] } }), null, "empty value answers nothing");
    assert.equal(validateUserInputAnswers({ "q": { answers: [""] } }), null, "empty string is not an answer");
    assert.equal(validateUserInputAnswers({ "q": { answers: ["x".repeat(5 * 1024)] } }), null, "value over 4 KiB");
    assert.equal(validateUserInputAnswers({ "q": { answers: [42] } }), null, "non-string value");
    assert.equal(validateUserInputAnswers({ "": { answers: ["a"] } }), null, "empty question id");
    const tooMany: Record<string, { answers: string[] }> = {};
    for (let index = 0; index < 21; index += 1) {
      tooMany[`q-${index}`] = { answers: ["a"] };
    }
    assert.equal(validateUserInputAnswers(tooMany), null, "over 20 questions");
    assert.equal(validateWebviewMessage({ type: "approval/answer", payload: { requestId: "r-1", answers: tooMany } }), null);
    assert.equal(validateWebviewMessage({ type: "approval/answer", payload: { requestId: null, answers: { q: { answers: ["a"] } } } }), null);
    assert.equal(validateWebviewMessage({ type: "approval/answer", payload: { requestId: "r-1" } }), null);
  });
});

describe("user-input question extraction", () => {
  it("extracts bounded views from generated params shape", () => {
    const views = extractUserInputQuestions(userInputParams());
    assert.equal(views?.length, 3);
    assert.deepEqual(views?.[0], {
      id: "q-color",
      header: "Color",
      question: "Pick a color?",
      isOther: false,
      isSecret: false,
      options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "" }],
    });
    assert.equal(views?.[1]?.isSecret, true);
    assert.equal(views?.[2]?.options, null);
  });

  it("falls back to null on empty or malformed questions, never fabricates", () => {
    assert.equal(extractUserInputQuestions({ questions: [] }), null);
    assert.equal(extractUserInputQuestions({}), null);
    assert.equal(extractUserInputQuestions(null), null);
    assert.equal(extractUserInputQuestions({ questions: [{ nope: true }] }), null);
    assert.equal(extractUserInputQuestions({ questions: "pick one" }), null);
  });
});

describe("approval reducer per kind", () => {
  it("stores kind and questions; unknown kind when missing", () => {
    let state = initialState();
    const views = extractUserInputQuestions(userInputParams());
    state = reduce(state, { type: "ext/approval", requestId: "r-1", method: "item/tool/requestUserInput", summary: "s", kind: "userInput", questions: views });
    assert.equal(state.approvals[0]?.kind, "userInput");
    assert.equal(state.approvals[0]?.questions?.length, 3);
    state = reduce(state, { type: "ext/approval", requestId: "r-2", method: "m", summary: "s" });
    assert.equal(state.approvals[1]?.kind, "unknown", "missing kind fails closed");
    assert.equal(state.approvals[1]?.questions, null);
  });
});

describe("approval card per kind", () => {
  it("offers Approve/Deny for executable kinds", () => {
    for (const kind of ["commandExecution", "fileChange", "v1ApplyPatch", "v1ExecCommand", "elicitation"]) {
      const html = approvalCardHtml(cardFor(kind));
      assert.ok(html.includes("data-action=\"approve\""), `${kind} has Approve`);
      assert.ok(html.includes("data-action=\"deny\""), `${kind} has Deny`);
    }
  });

  it("is Deny-only with an honest reason for permissions/dynamicTool/unknown", () => {
    const permissions = approvalCardHtml(cardFor("permissions"));
    assert.ok(!permissions.includes("data-action=\"approve\""), "permissions has no Approve");
    assert.ok(permissions.includes("data-action=\"deny\""));
    assert.ok(permissions.includes("grant profiles aren&#39;t supported in this client yet"));
    const dynamic = approvalCardHtml(cardFor("dynamicTool"));
    assert.ok(!dynamic.includes("data-action=\"approve\""));
    assert.ok(dynamic.includes("unsupported request type"));
    const unknown = approvalCardHtml(cardFor("unknown"));
    assert.ok(!unknown.includes("data-action=\"approve\""));
    assert.ok(unknown.includes("unsupported request type"));
  });

  it("renders questions with radios, password for secrets, free text for other", () => {
    const views = extractUserInputQuestions(userInputParams());
    const html = approvalCardHtml(cardFor("userInput", views));
    assert.ok(!html.includes("data-action=\"approve\""), "userInput has no Approve");
    assert.ok(html.includes("data-action=\"deny\""));
    assert.ok(html.includes("Pick a color?"));
    assert.ok(html.includes('type="radio"'), "options as radio list");
    assert.ok(html.includes("Red"));
    assert.ok(html.includes('type="password"'), "secret uses password input");
    assert.ok(html.includes('data-role="other-answer"'), "isOther appends free-text field");
    assert.equal((html.match(/data-action="answer"/g) ?? []).length, 3, "one Answer control per question");
  });

  it("falls back to Deny-only when questions are missing", () => {
    const html = approvalCardHtml(cardFor("userInput", null));
    assert.ok(!html.includes("data-action=\"approve\""));
    assert.ok(!html.includes("data-action=\"answer\""));
    assert.ok(html.includes("data-action=\"deny\""));
    assert.ok(html.includes("empty or malformed"));
  });

  it("escapes rendered question text and options", () => {
    const views = extractUserInputQuestions({
      questions: [{ id: "q", header: "<b>H</b>", question: "<img src=x onerror=alert(1)>", isOther: false, isSecret: false, options: [{ label: "<script>evil</script>", description: "" }] }],
    });
    const html = approvalCardHtml(cardFor("userInput", views));
    assert.ok(!html.includes("<img src=x"), "question text escaped");
    assert.ok(!html.includes("<script>evil</script>"), "option label escaped");
    assert.ok(html.includes("&lt;img src=x"), "escaped form present");
  });
});
