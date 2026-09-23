/** Unit tests: thread/fork creates an independent thread carrying pins. */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../sessions/SessionManager";
import { connectFake } from "./helpers";

describe("thread/fork", () => {
  let manager: SessionManager;
  let cleanup: () => Promise<void>;
  before(async () => {
    ({ manager, cleanup } = await connectFake());
  });
  after(async () => {
    await cleanup();
  });

  it("forks into a new independent thread id", async () => {
    const started = (await manager.startThread()) as Record<string, unknown>;
    const sourceId = ((started["thread"] ?? {}) as Record<string, unknown>)["id"] as string;
    const forkId = await manager.forkThread(sourceId);
    assert.notEqual(forkId, sourceId);
    assert.ok(manager.threads.getThread(sourceId) !== undefined, "source survives");
    assert.ok(manager.threads.getThread(forkId) !== undefined, "fork registered");
  });

  it("carries explicit model/effort pins to the fork", async () => {
    const started = (await manager.startThread()) as Record<string, unknown>;
    const sourceId = ((started["thread"] ?? {}) as Record<string, unknown>)["id"] as string;
    manager.threads.setThreadOverride(sourceId, { model: "pinned-model", effort: "high" });
    const forkId = await manager.forkThread(sourceId);
    assert.deepEqual(manager.threads.effectiveOverride(forkId), { model: "pinned-model", effort: "high" });
  });

  it("rejects unknown source threads honestly", async () => {
    await assert.rejects(manager.forkThread("thr-nope"), /unknown thread/);
  });
});
