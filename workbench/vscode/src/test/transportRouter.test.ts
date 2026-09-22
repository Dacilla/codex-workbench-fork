/**
 * Transport + routing tests against the fake app-server over real stdio:
 * handshake shape, two-thread independent routing, global broadcast,
 * timeout/cancel, RpcError surfacing, crash settlement, paginated resume.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { RequestTimeoutError, RpcError, TransportClosedError } from "../backend/JsonRpcTransport";
import { SessionManager } from "../sessions/SessionManager";
import { collectSink, CollectedEvent, connectFake, tempRecordPath, threadIdOfParams, waitFor, FAKE_PATH } from "./helpers";

describe("handshake", () => {
  let manager: SessionManager;
  let cleanup: () => Promise<void>;
  before(async () => {
    ({ manager, cleanup } = await connectFake());
  });
  after(async () => {
    await cleanup();
  });

  it("initialize returns the required fields and sends initialized", () => {
    const handshake = manager.lastHandshake;
    assert.ok(handshake !== null);
    assert.match(handshake.response.userAgent, /codex-workbench-fake/);
    assert.equal(typeof handshake.response.codexHome, "string");
    assert.equal(typeof handshake.response.platformFamily, "string");
    assert.equal(typeof handshake.response.platformOs, "string");
    assert.equal(handshake.isOfficialFallback, false);
    assert.equal(manager.connectionState, "ready");
  });

  it("unknown methods surface as RpcError", async () => {
    const transport = (manager as unknown as { transport: { request: (method: string, params: unknown) => Promise<unknown> } }).transport;
    await assert.rejects(transport.request("nope/method", {}), (error: unknown) => error instanceof RpcError && error.code === -32601);
  });
});

describe("two-thread routing", () => {
  let manager: SessionManager;
  let cleanup: () => Promise<void>;
  before(async () => {
    ({ manager, cleanup } = await connectFake());
  });
  after(async () => {
    await cleanup();
  });

  it("streams deltas to the owning thread only", async () => {
    const startA = (await manager.startThread()) as Record<string, unknown>;
    const startB = (await manager.startThread()) as Record<string, unknown>;
    const threadA = ((startA["thread"] ?? {}) as Record<string, unknown>)["id"] as string;
    const threadB = ((startB["thread"] ?? {}) as Record<string, unknown>)["id"] as string;
    assert.notEqual(threadA, threadB);

    const eventsA: CollectedEvent[] = [];
    const eventsB: CollectedEvent[] = [];
    const sinkA = collectSink(eventsA);
    const sinkB = collectSink(eventsB);
    const unsubA = manager.subscribe(threadA, sinkA);
    const unsubB = manager.subscribe(threadB, sinkB);
    try {
      await Promise.all([manager.startTurn(threadA, "hello-a"), manager.startTurn(threadB, "hello-b")]);
      await waitFor(
        () => eventsA.some((event) => event.method === "turn/completed") && eventsB.some((event) => event.method === "turn/completed"),
        10000,
        "both turns to complete",
      );
      for (const event of eventsA) {
        const owner = threadIdOfParams(event.params);
        assert.ok(owner === null || owner === threadA, `thread A sink received event for ${owner} (${event.method})`);
      }
      for (const event of eventsB) {
        const owner = threadIdOfParams(event.params);
        assert.ok(owner === null || owner === threadB, `thread B sink received event for ${owner} (${event.method})`);
      }
      const deltasA = eventsA.filter((event) => event.method === "item/agentMessage/delta").map((event) => (event.params as Record<string, unknown>)["delta"]);
      assert.ok(deltasA.join("").includes(`echo[${threadA}]`), `A deltas carry A's marker: ${deltasA.join("")}`);
      assert.ok(!deltasA.join("").includes(threadB), "A deltas never mention B");
    } finally {
      unsubA();
      unsubB();
    }
  });

  it("global notifications reach every subscribed thread", async () => {
    const startA = (await manager.startThread()) as Record<string, unknown>;
    const startB = (await manager.startThread()) as Record<string, unknown>;
    const threadA = ((startA["thread"] ?? {}) as Record<string, unknown>)["id"] as string;
    const threadB = ((startB["thread"] ?? {}) as Record<string, unknown>)["id"] as string;
    const eventsA: CollectedEvent[] = [];
    const eventsB: CollectedEvent[] = [];
    const unsubA = manager.subscribe(threadA, collectSink(eventsA));
    const unsubB = manager.subscribe(threadB, collectSink(eventsB));
    try {
      await manager.listModels();
      await waitFor(
        () => eventsA.some((event) => event.method === "account/updated") && eventsB.some((event) => event.method === "account/updated"),
        5000,
        "account/updated broadcast",
      );
    } finally {
      unsubA();
      unsubB();
    }
  });
});

describe("timeout and cancellation", () => {
  it("hanging turn/start rejects with RequestTimeoutError", async () => {
    const { manager, cleanup } = await connectFake(["--hang=turn/start"]);
    try {
      const started = (await manager.startThread()) as Record<string, unknown>;
      const threadId = ((started["thread"] ?? {}) as Record<string, unknown>)["id"] as string;
      await assert.rejects(manager.startTurn(threadId, "hello", { timeoutMs: 300 }), (error: unknown) => error instanceof RequestTimeoutError);
    } finally {
      await cleanup();
    }
  });

  it("abort signal rejects the pending request", async () => {
    const { manager, cleanup } = await connectFake(["--hang=turn/start"]);
    try {
      const started = (await manager.startThread()) as Record<string, unknown>;
      const threadId = ((started["thread"] ?? {}) as Record<string, unknown>)["id"] as string;
      const controller = new AbortController();
      const pending = manager.startTurn(threadId, "hello", { signal: controller.signal, timeoutMs: 10000 });
      controller.abort();
      await assert.rejects(pending, /aborted/);
    } finally {
      await cleanup();
    }
  });
});

describe("crash and resume", () => {
  it("process death rejects pending requests and reports crashed", async () => {
    const manager = new SessionManager();
    await manager.connect(process.execPath, [FAKE_PATH, "--hang=turn/start", "--die-after-ms=400"]);
    try {
      const started = (await manager.startThread()) as Record<string, unknown>;
      const threadId = ((started["thread"] ?? {}) as Record<string, unknown>)["id"] as string;
      const pending = manager.startTurn(threadId, "hello", { timeoutMs: 15000 });
      await assert.rejects(pending, (error: unknown) => error instanceof TransportClosedError);
      await waitFor(() => manager.connectionState === "crashed", 5000, "crashed state");
    } finally {
      await manager.disconnect("test cleanup");
    }
  });

  it("resume on the same backend returns cursors; pagination hydrates without duplicates", async () => {
    const { manager, cleanup } = await connectFake();
    try {
      const started = (await manager.startThread()) as Record<string, unknown>;
      const threadId = ((started["thread"] ?? {}) as Record<string, unknown>)["id"] as string;
      const events: CollectedEvent[] = [];
      const unsub = manager.subscribe(threadId, collectSink(events));
      await manager.startTurn(threadId, "seed message");
      await waitFor(() => events.some((event) => event.method === "turn/completed"), 10000, "seed turn completes");
      unsub();

      // Metadata-only resume (excludeTurns), then paginated hydration.
      const resumed = (await manager.resumeThread(threadId)) as Record<string, unknown>;
      assert.equal(typeof resumed["turnsBackwardsCursor"], "string");
      assert.equal(typeof resumed["itemsBackwardsCursor"], "string");
      const items = (await manager.listThreadItems(threadId, { limit: 10 })) as Record<string, unknown>;
      const data = items["data"] as Array<{ turnId: string; item: { id: string } }>;
      const ids = data.map((entry) => entry.item.id);
      assert.equal(new Set(ids).size, ids.length, "hydrated items contain no duplicates");
    } finally {
      await cleanup();
    }
  });

  it("resume of an unknown thread on a fresh backend fails honestly", async () => {
    const first = await connectFake();
    const started = (await first.manager.startThread()) as Record<string, unknown>;
    const threadId = ((started["thread"] ?? {}) as Record<string, unknown>)["id"] as string;
    await first.cleanup();

    const second = await connectFake();
    try {
      // A fresh fake has no persisted threads: resume must fail honestly, not hang.
      await assert.rejects(second.manager.resumeThread(threadId), /unknown thread/);
    } finally {
      await second.cleanup();
    }
  });

  it("paginated items carry turnId and hydrate one turn into user+agent items", async () => {
    const { manager, cleanup } = await connectFake();
    try {
      const started = (await manager.startThread()) as Record<string, unknown>;
      const threadId = ((started["thread"] ?? {}) as Record<string, unknown>)["id"] as string;
      await manager.startTurn(threadId, "seed");
      const turns = (await manager.listThreadTurns(threadId, { limit: 5, sortDirection: "desc" })) as Record<string, unknown>;
      assert.equal((turns["data"] as unknown[]).length, 1);
      const items = (await manager.listThreadItems(threadId, { limit: 10 })) as Record<string, unknown>;
      const data = items["data"] as Array<Record<string, unknown>>;
      assert.equal(data.length, 2);
      assert.ok(data.every((entry) => typeof entry["turnId"] === "string"));
    } finally {
      await cleanup();
    }
  });
});

describe("orphaned approval fails closed", () => {
  it("approval with no owning panel is declined exactly once", async () => {
    const record = tempRecordPath();
    const { manager, cleanup } = await connectFake([`--record=${record.path}`]);
    try {
      const started = (await manager.startThread()) as Record<string, unknown>;
      const threadId = ((started["thread"] ?? {}) as Record<string, unknown>)["id"] as string;
      // Deliberately NOT subscribing: no panel owns this thread.
      await manager.startTurn(threadId, "please [ask-approval]");
      await waitFor(() => record.readLines().length >= 1, 10000, "fail-closed approval response");
      await new Promise((resolve) => setTimeout(resolve, 300));
      const lines = record.readLines();
      assert.equal(lines.length, 1, `exactly one approval response, got ${lines.length}`);
      const response = JSON.parse(lines[0] as string) as { result: { decision: string } };
      assert.equal(response.result.decision, "decline");
      assert.equal(manager.router.orphanedCount >= 1, true);
    } finally {
      await cleanup();
    }
  });
});
