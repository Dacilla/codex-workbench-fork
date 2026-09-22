/**
 * Approval unit tests (no backend) + owned-approval integration test.
 * Invariants: explicit decisions only, exactly-once responses, fail closed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ApprovalHandler, classifyApproval, failClosedResult, summarizeApproval } from "../sessions/Approvals";
import { JsonRpcTransport } from "../backend/JsonRpcTransport";
import { collectSink, CollectedEvent, connectFake, tempRecordPath, waitFor } from "./helpers";

function stubTransport(): { transport: JsonRpcTransport; sent: Array<{ id: unknown; result: unknown }> } {
  const sent: Array<{ id: unknown; result: unknown }> = [];
  const transport = new JsonRpcTransport(() => undefined);
  const original = transport.respond.bind(transport);
  transport.respond = (id: unknown, result: unknown): void => {
    sent.push({ id, result });
    original(id as never, result);
  };
  return { transport, sent };
}

function approvalRequest(id: string, method: string, threadId: string): { id: string; method: string; params: Record<string, unknown> } {
  return { id, method, params: { threadId, turnId: "turn-1", itemId: "item-1", startedAtMs: 1, command: "rm -rf /tmp/x", cwd: "/tmp" } };
}

describe("approval classification and summaries", () => {
  it("classifies every known server-request method", () => {
    assert.equal(classifyApproval("item/commandExecution/requestApproval"), "commandExecution");
    assert.equal(classifyApproval("item/fileChange/requestApproval"), "fileChange");
    assert.equal(classifyApproval("item/permissions/requestApproval"), "permissions");
    assert.equal(classifyApproval("item/tool/requestUserInput"), "userInput");
    assert.equal(classifyApproval("mcpServer/elicitation/request"), "elicitation");
    assert.equal(classifyApproval("item/tool/call"), "dynamicTool");
    assert.equal(classifyApproval("applyPatchApproval"), "v1ApplyPatch");
    assert.equal(classifyApproval("execCommandApproval"), "v1ExecCommand");
    assert.equal(classifyApproval("something/else"), "unknown");
  });

  it("summaries show the exact command/target, bounded", () => {
    const summary = summarizeApproval("item/commandExecution/requestApproval", { command: "rm -rf /tmp/x", cwd: "/tmp" });
    assert.match(summary, /rm -rf \/tmp\/x/);
    assert.match(summary, /\/tmp/);
    const long = summarizeApproval("item/commandExecution/requestApproval", { command: `yes ${"x".repeat(1000)}`, cwd: "/" });
    assert.ok(long.length < 500);
  });

  it("fail-closed responses deny; unknown has no safe shape", () => {
    assert.deepEqual(failClosedResult("commandExecution"), { decision: "decline" });
    assert.deepEqual(failClosedResult("fileChange"), { decision: "decline" });
    assert.deepEqual(failClosedResult("permissions"), { permissions: {}, scope: "turn" });
    assert.deepEqual(failClosedResult("userInput"), { answers: {} });
    assert.deepEqual(failClosedResult("elicitation"), { action: "cancel", content: null, _meta: null });
    assert.equal((failClosedResult("dynamicTool") as { success: boolean }).success, false);
    assert.equal(failClosedResult("unknown"), null);
  });
});

describe("ApprovalHandler exactly-once + fail-closed", () => {
  it("decide sends one response; a second decide is rejected", () => {
    const { transport, sent } = stubTransport();
    const settled: Array<{ approved: boolean; failClosed: boolean }> = [];
    const handler = new ApprovalHandler(transport, { onApprovalSettled: (_approval, approved, failClosed) => settled.push({ approved, failClosed }) }, 0);
    handler.handleServerRequest(approvalRequest("a-1", "item/commandExecution/requestApproval", "t-1"));
    assert.equal(handler.decide("a-1", { approved: true }), true);
    assert.equal(handler.decide("a-1", { approved: true }), false);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]?.result, { decision: "accept" });
    assert.deepEqual(settled, [{ approved: true, failClosed: false }]);
  });

  it("duplicate server delivery of the same id registers once", () => {
    const { transport } = stubTransport();
    const handler = new ApprovalHandler(transport, {}, 0);
    handler.handleServerRequest(approvalRequest("a-2", "item/commandExecution/requestApproval", "t-1"));
    handler.handleServerRequest(approvalRequest("a-2", "item/commandExecution/requestApproval", "t-1"));
    assert.equal(handler.pendingCount, 1);
  });

  it("decision timeout fails closed with decline", async () => {
    const { transport, sent } = stubTransport();
    const settled: boolean[] = [];
    const handler = new ApprovalHandler(transport, { onApprovalSettled: (_approval, _approved, failClosed) => settled.push(failClosed) }, 50);
    handler.handleServerRequest(approvalRequest("a-3", "item/fileChange/requestApproval", "t-1"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]?.result, { decision: "decline" });
    assert.deepEqual(settled, [true]);
  });

  it("approving a permissions request without grants fails closed", () => {    const { transport, sent } = stubTransport();
    const settled: Array<{ approved: boolean; failClosed: boolean }> = [];
    const handler = new ApprovalHandler(transport, { onApprovalSettled: (_approval, approved, failClosed) => settled.push({ approved, failClosed }) }, 0);
    handler.handleServerRequest({ id: "a-4", method: "item/permissions/requestApproval", params: { threadId: "t-1", turnId: "turn-1", itemId: "item-1" } });
    assert.equal(handler.decide("a-4", { approved: true }), true);
    assert.deepEqual(sent[0]?.result, { permissions: {}, scope: "turn" });
    assert.deepEqual(settled, [{ approved: false, failClosed: true }]);
  });

  it("user-input answers ride the existing decide channel exactly once", () => {
    // Pure-shape coverage for the host approval/answer path: extension.ts
    // calls manager.decideApproval(requestId, { approved: true,
    // result: { answers } }), which delegates to this decide call.
    const { transport, sent } = stubTransport();
    const settled: Array<{ approved: boolean; failClosed: boolean }> = [];
    const handler = new ApprovalHandler(transport, { onApprovalSettled: (_approval, approved, failClosed) => settled.push({ approved, failClosed }) }, 0);
    handler.handleServerRequest({
      id: "a-user",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "t-1",
        turnId: "turn-1",
        itemId: "item-1",
        isBlocking: true,
        questions: [{ id: "q-1", header: "Color", question: "Pick?", isOther: false, isSecret: false, options: [{ label: "Red", description: "" }] }],
      },
    });
    const answers = { "q-1": { answers: ["Red"] } };
    assert.equal(handler.decide("a-user", { approved: true, result: { answers } }), true);
    assert.equal(handler.decide("a-user", { approved: true, result: { answers } }), false, "second answer rejected");
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]?.result, { answers });
    assert.deepEqual(settled, [{ approved: true, failClosed: false }]);
  });

  it("failClosedForThread only settles the disposed thread", () => {
    const { transport, sent } = stubTransport();
    const handler = new ApprovalHandler(transport, {}, 0);
    handler.handleServerRequest(approvalRequest("a-5", "item/commandExecution/requestApproval", "t-keep"));
    handler.handleServerRequest(approvalRequest("a-6", "item/commandExecution/requestApproval", "t-gone"));
    assert.equal(handler.failClosedForThread("t-gone", "panel disposed"), 1);
    assert.equal(handler.pendingCount, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.id, "a-6");
  });

  it("failClosedAll is idempotent", () => {
    const { transport, sent } = stubTransport();
    const handler = new ApprovalHandler(transport, {}, 0);
    handler.handleServerRequest(approvalRequest("a-7", "item/commandExecution/requestApproval", "t-1"));
    assert.equal(handler.failClosedAll("bye"), 1);
    assert.equal(handler.failClosedAll("bye"), 0);
    assert.equal(sent.length, 1);
  });
});

describe("owned approval integration", () => {
  it("approve answers accept exactly once; UI double-click is ignored", async () => {
    const record = tempRecordPath();
    const { manager, cleanup } = await connectFake([`--record=${record.path}`]);
    try {
      const started = (await manager.startThread()) as Record<string, unknown>;
      const threadId = ((started["thread"] ?? {}) as Record<string, unknown>)["id"] as string;
      const events: CollectedEvent[] = [];
      const sink = collectSink(events);
      const unsub = manager.subscribe(threadId, sink);
      try {
        await manager.startTurn(threadId, "do it [ask-approval]");
        await waitFor(() => manager.approvalsFor(threadId).length === 1, 10000, "approval to arrive");
        const pending = manager.approvalsFor(threadId)[0];
        assert.ok(pending !== undefined);
        assert.match(pending.summary, /rm -rf \/tmp\/wb-test-target/);
        assert.equal(sink.requests.length, 1, "owning panel received the approval");
        assert.equal(manager.decideApproval(pending.requestId, { approved: true }), true);
        assert.equal(manager.decideApproval(pending.requestId, { approved: true }), false);
        await waitFor(() => record.readLines().length === 1, 10000, "approval answer recorded");
        await new Promise((resolve) => setTimeout(resolve, 400));
        const lines = record.readLines();
        assert.equal(lines.length, 1, `exactly one wire response, got ${lines.length}`);
        assert.equal((JSON.parse(lines[0] as string) as { result: { decision: string } }).result.decision, "accept");
        await waitFor(() => events.some((event) => event.method === "turn/completed"), 10000, "turn completes after approval");
      } finally {
        unsub();
      }
    } finally {
      await cleanup();
    }
  });
});
