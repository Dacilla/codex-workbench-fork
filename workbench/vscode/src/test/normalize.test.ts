/**
 * Unit tests for the schema-aware ThreadItem normalization layer.
 *
 * Every fixture below mirrors the ACTUAL pinned generated shapes — not the
 * old simplified `{ kind, text }` literals:
 * - codex-rs/app-server-protocol/schema/typescript/v2/ThreadItem.ts
 * - codex-rs/app-server-protocol/schema/typescript/v2/UserInput.ts
 * - codex-rs/app-server-protocol/schema/typescript/v2/FileUpdateChange.ts
 * - codex-rs/app-server-protocol/schema/typescript/v2/PatchChangeKind.ts
 * - codex-rs/app-server-protocol/schema/typescript/v2/McpToolCallResult.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeThreadItem } from "../webview/normalize";
import { initialState, reduce } from "../webview/state";
import { toolCardHtml } from "../webview/ToolActivity";

describe("normalizeThreadItem", () => {
  it("concatenates text UserInput entries for userMessage (v2/UserInput.ts)", () => {
    const view = normalizeThreadItem(
      {
        type: "userMessage",
        id: "item-u-1",
        clientId: null,
        content: [
          { type: "text", text: "Hello", text_elements: [] },
          { type: "text", text: "world", text_elements: [] },
        ],
      },
      "turn-1",
    );
    assert.deepEqual(view, { id: "item-u-1", turnId: "turn-1", kind: "userMessage", text: "Hello\nworld" });
  });

  it("renders non-text UserInput entries as placeholders instead of dropping the message", () => {
    const view = normalizeThreadItem(
      {
        type: "userMessage",
        id: "item-u-2",
        clientId: null,
        content: [{ type: "image", url: "https://example.com/a.png" }],
      },
      "turn-1",
    );
    assert.equal(view?.text, "[image]");
  });

  it("passes agentMessage and plan text through", () => {
    const agent = normalizeThreadItem(
      { type: "agentMessage", id: "item-a-1", text: "done", phase: "answer", memoryCitation: null, delivery: null, questions: null },
      "turn-1",
    );
    assert.deepEqual(agent, { id: "item-a-1", turnId: "turn-1", kind: "agentMessage", text: "done" });
    const plan = normalizeThreadItem({ type: "plan", id: "item-p-1", text: "step one" }, "turn-1");
    assert.equal(plan?.kind, "plan");
    assert.equal(plan?.text, "step one");
  });

  it("joins reasoning summary, falling back to first content lines", () => {
    const summary = normalizeThreadItem({ type: "reasoning", id: "r-1", summary: ["line one", "line two"], content: ["ignored"] }, "t");
    assert.equal(summary?.kind, "reasoning");
    assert.equal(summary?.text, "line one\nline two");
    const fallback = normalizeThreadItem({ type: "reasoning", id: "r-2", summary: [], content: ["first\nsecond"] }, "t");
    assert.equal(fallback?.text, "first\nsecond");
    assert.equal(normalizeThreadItem({ type: "reasoning", id: "r-3", summary: [], content: [] }, "t"), null);
  });

  it("renders commandExecution as a one-line command · status with bounded output detail", () => {
    const view = normalizeThreadItem(
      {
        type: "commandExecution",
        id: "item-c-1",
        pluginId: null,
        scriptPath: null,
        command: "npm test",
        cwd: "/tmp",
        processId: null,
        source: "model",
        status: "completed",
        commandActions: [],
        aggregatedOutput: "ok\n".repeat(1000),
        exitCode: 0,
        durationMs: 12,
      },
      "turn-1",
    );
    assert.equal(view?.kind, "commandExecution");
    assert.equal(view?.text, "npm test · completed");
    assert.ok((view?.detail?.length ?? 0) <= 501, "output preview stays bounded");
    assert.equal(normalizeThreadItem({ type: "commandExecution", id: "c", command: "", status: "completed" }, "t"), null);
  });

  it("renders fileChange as N files changed with per-file path/kind detail (v2/FileUpdateChange.ts)", () => {
    const view = normalizeThreadItem(
      {
        type: "fileChange",
        id: "item-f-1",
        changes: [
          { path: "src/a.ts", kind: { type: "update", move_path: null }, diff: "@@ huge diff never rendered" },
          { path: "src/b.ts", kind: { type: "add" }, diff: "" },
        ],
        status: "completed",
      },
      "turn-1",
    );
    assert.equal(view?.kind, "fileChange");
    assert.equal(view?.text, "2 files changed");
    assert.equal(view?.detail, "src/a.ts (update)\nsrc/b.ts (add)");
    const single = normalizeThreadItem({ type: "fileChange", id: "f", changes: [{ path: "x", kind: { type: "delete" }, diff: "" }], status: "completed" }, "t");
    assert.equal(single?.text, "1 file changed");
    assert.equal(normalizeThreadItem({ type: "fileChange", id: "f", changes: [], status: "completed" }, "t"), null);
  });

  it("renders mcpToolCall as server.tool · status with an allowlisted argument preview", () => {
    const view = normalizeThreadItem(
      {
        type: "mcpToolCall",
        id: "item-m-1",
        server: "docs",
        tool: "update",
        status: "completed",
        arguments: { pageId: 204341250, token: "secret-value", nested: { a: [1, 2] } },
        appContext: null,
        mcpAppUi: null,
        pluginId: null,
        readOnlyHint: null,
        result: null,
        error: null,
        durationMs: null,
      },
      "turn-1",
    );
    assert.equal(view?.kind, "mcpToolCall");
    assert.equal(view?.text, "docs.update · completed");
    assert.ok(view?.detail?.includes("pageId=204341250"), "numbers render verbatim");
    assert.ok(view?.detail?.includes("token=<hidden: 12 chars>"), "strings collapse to char counts");
    assert.ok(!(view?.detail?.includes("secret-value") ?? true), "raw secret never echoes");
  });

  it("hides a 1MB MCP argument behind a char-count placeholder", () => {
    const huge = "x".repeat(1024 * 1024);
    const view = normalizeThreadItem(
      { type: "mcpToolCall", id: "m", server: "s", tool: "t", status: "inProgress", arguments: { blob: huge }, result: null, error: null },
      "turn-1",
    );
    assert.equal(view?.detail, "blob=<hidden: 1048576 chars>");
    assert.ok(!(view?.detail?.includes("x".repeat(100)) ?? true), "bulk payload never echoes");
  });

  it("counts unicode scalars like the CLI policy and surfaces MCP errors", () => {
    const emoji = normalizeThreadItem(
      { type: "mcpToolCall", id: "m", server: "s", tool: "t", status: "completed", arguments: { emoji: "👍👍👍" }, result: null, error: null },
      "t",
    );
    assert.equal(emoji?.detail, "emoji=<hidden: 3 chars>");
    const failed = normalizeThreadItem(
      { type: "mcpToolCall", id: "m", server: "s", tool: "t", status: "failed", arguments: {}, result: null, error: { message: "boom" } },
      "t",
    );
    assert.ok(failed?.detail?.includes("error: boom"));
  });

  it("returns null for empty, malformed, and unknown shapes instead of kind labels", () => {
    assert.equal(normalizeThreadItem(null, "t"), null);
    assert.equal(normalizeThreadItem("nope", "t"), null);
    assert.equal(normalizeThreadItem({ type: "agentMessage" }, "t"), null, "missing id");
    assert.equal(normalizeThreadItem({ id: "x" }, "t"), null, "missing type");
    // item/started for a streaming agent message carries empty text: dropped.
    assert.equal(
      normalizeThreadItem({ type: "agentMessage", id: "a", text: "", phase: "commentary", memoryCitation: null, delivery: null, questions: null }, "t"),
      null,
    );
    // Recognized-but-unrendered variants (e.g. webSearch) carry no text body: dropped.
    assert.equal(normalizeThreadItem({ type: "webSearch", id: "w", query: "q", action: null, results: null }, "t"), null);
    assert.equal(normalizeThreadItem({ type: "sleep", foo: 1 }, "t"), null);
  });

  it("labels unknown future types with text as unsupported (drift tolerance)", () => {
    const view = normalizeThreadItem({ type: "brandNewKind", id: "n-1", text: "hello future" }, "t");
    assert.equal(view?.kind, "unsupported");
    assert.equal(view?.text, "hello future");
    assert.equal(normalizeThreadItem({ type: "brandNewKind", id: "n-2" }, "t"), null);
  });
});

describe("normalize wiring", () => {
  it("adopts the optimistic echo when the backend echo carries real userMessage content", () => {
    // Regression test for the duplicate-message fix, using REAL backend
    // shapes (content: UserInput[]) rather than { kind, text } literals:
    // the pre-normalization matcher compared item["text"] equality, which
    // could never hold for real userMessages (they have no text field).
    let state = initialState();
    state = reduce(state, { type: "ext/item", turnId: "local", itemId: "local-1", kind: "userMessage", text: "Test" });
    const echo = normalizeThreadItem(
      { type: "userMessage", id: "backend-9", clientId: null, content: [{ type: "text", text: "Test", text_elements: [] }] },
      "t-1",
    );
    assert.ok(echo !== null);
    state = reduce(state, { type: "ext/item", turnId: echo.turnId, itemId: echo.id, kind: echo.kind, text: echo.text });
    assert.equal(state.items.length, 1, "backend echo adopts the local card");
    assert.equal(state.items[0]?.itemId, "backend-9");
  });

  it("collapses real tool kinds with friendly labels and headline previews", () => {
    let state = initialState();
    const mcp = normalizeThreadItem(
      { type: "mcpToolCall", id: "m-1", server: "docs", tool: "get", status: "completed", arguments: { id: 7 }, result: null, error: null },
      "t-1",
    );
    assert.ok(mcp !== null);
    const text = mcp.detail !== undefined ? `${mcp.text}\n${mcp.detail}` : mcp.text;
    state = reduce(state, { type: "ext/item", turnId: mcp.turnId, itemId: mcp.id, kind: mcp.kind, text });
    assert.equal(state.items[0]?.collapsed, true);
    const html = toolCardHtml(state.items[0]!);
    assert.ok(html.includes("▸"));
    assert.ok(html.includes("Tool"));
    assert.ok(html.includes("docs.get · completed"), "collapsed preview shows the headline first line");
    assert.ok(!html.includes("id=7"), "args stay out of the collapsed preview line");
    const unsupported = normalizeThreadItem({ type: "futureKind", id: "u-1", text: "x" }, "t");
    assert.ok(unsupported !== null);
    const before = state;
    state = reduce(state, { type: "ext/item", turnId: "t", itemId: "u-1", kind: unsupported.kind, text: unsupported.text });
    assert.equal(state.items.length, before.items.length + 1);
    assert.equal(state.items[state.items.length - 1]?.collapsed, true);
  });
});
