/** Unit tests: archive/unarchive/delete thread lifecycle. */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../sessions/SessionManager";
import { ThreadRegistry, InMemoryStorage } from "../sessions/ThreadRegistry";
import { connectFake } from "./helpers";

async function startThreadId(manager: SessionManager): Promise<string> {
  const started = (await manager.startThread()) as Record<string, unknown>;
  return ((started["thread"] ?? {}) as Record<string, unknown>)["id"] as string;
}

function threadIds(result: unknown): string[] {
  const record = (result ?? {}) as Record<string, unknown>;
  const data = Array.isArray(record["data"]) ? (record["data"] as Array<Record<string, unknown>>) : [];
  return data.map((entry) => String(entry["id"] ?? ""));
}

describe("thread archive/unarchive/delete", () => {
  let manager: SessionManager;
  let cleanup: () => Promise<void>;
  before(async () => {
    ({ manager, cleanup } = await connectFake());
  });
  after(async () => {
    await cleanup();
  });

  it("archive hides the thread until unarchived, then it returns", async () => {
    const threadId = await startThreadId(manager);
    await manager.archiveThread(threadId);
    assert.ok(!threadIds(await manager.listThreads({})).includes(threadId), "archived away from default list");
    assert.ok(threadIds(await manager.listThreads({ archived: true })).includes(threadId), "visible in archived list");
    assert.equal(manager.threads.getThread(threadId), undefined, "registry record dropped");
    await manager.unarchiveThread(threadId);
    assert.ok(threadIds(await manager.listThreads({})).includes(threadId), "back in default list");
  });

  it("delete removes the thread permanently", async () => {
    const threadId = await startThreadId(manager);
    await manager.deleteThread(threadId);
    assert.ok(!threadIds(await manager.listThreads({})).includes(threadId));
    assert.equal(manager.threads.getThread(threadId), undefined);
    await assert.rejects(manager.resumeThread(threadId), /unknown thread/);
  });

  it("unknown threads fail honestly on all three methods", async () => {
    await assert.rejects(manager.archiveThread("thr-nope"), /unknown thread/);
    await assert.rejects(manager.unarchiveThread("thr-nope"), /unknown thread/);
    await assert.rejects(manager.deleteThread("thr-nope"), /unknown thread/);
  });
});

describe("ThreadRegistry.removeThread", () => {
  it("drops the record, pins, mode, and panel bindings", () => {
    const registry = new ThreadRegistry(new InMemoryStorage());
    registry.upsertThread({
      threadId: "t-1", displayName: "chat", workspaceKey: "w", model: null,
      effort: null, cwd: null, status: "idle", lastTurnId: null, updatedAtMs: 1,
    });
    registry.setThreadOverride("t-1", { model: "m" });
    registry.bindPanel("p-1", "t-1", "chat", "w");
    assert.equal(registry.removeThread("t-1"), true);
    assert.equal(registry.getThread("t-1"), undefined);
    // The per-thread pin is gone; the session default (also recorded by
    // setThreadOverride) correctly survives for future new threads.
    assert.deepEqual(registry.effectiveOverride("t-1"), { model: "m", effort: null });
    assert.deepEqual(registry.panelsForThread("t-1"), []);
    assert.equal(registry.removeThread("t-1"), false);
  });
});
