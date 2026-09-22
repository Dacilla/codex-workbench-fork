/** Unit tests: ThreadRegistry, EventRouter, PanelRegistry, threadIdOf. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventRouter, MAX_BUFFERED_PER_THREAD, threadIdOf } from "../sessions/EventRouter";
import { InMemoryStorage, ThreadRegistry } from "../sessions/ThreadRegistry";
import { PanelRegistry, PanelLike } from "../sessions/PanelRegistry";
import { RpcNotification } from "../backend/JsonRpcTransport";

function notification(method: string, params: unknown): RpcNotification {
  return { method, params };
}

function fakePanel(panelId: string): { panel: PanelLike; disposed: boolean } {
  let listener: (() => void) | null = null;
  const state = { disposed: false } as { disposed: boolean; panel: PanelLike };
  state.panel = {
    panelId,
    reveal: () => undefined,
    postMessage: () => undefined,
    dispose: () => {
      state.disposed = true;
      listener?.();
    },
    onDidDispose: (callback: () => void) => {
      listener = callback;
    },
    setTitle: () => undefined,
  };
  return state as { panel: PanelLike; disposed: boolean };
}

describe("threadIdOf", () => {
  it("reads threadId and v1 conversationId", () => {
    assert.equal(threadIdOf({ threadId: "t-1" }), "t-1");
    assert.equal(threadIdOf({ conversationId: "c-1" }), "c-1");
    assert.equal(threadIdOf({}), null);
    assert.equal(threadIdOf(null), null);
    assert.equal(threadIdOf("t-1"), null);
  });
});

describe("ThreadRegistry", () => {
  it("unbinding a panel keeps the thread (close tab != delete thread)", () => {
    const registry = new ThreadRegistry(new InMemoryStorage());
    registry.upsertThread({ threadId: "t-1", displayName: "chat", workspaceKey: "w", model: null, effort: null, cwd: null, status: "idle", lastTurnId: null, updatedAtMs: 1 });
    registry.bindPanel("p-1", "t-1", "chat", "w");
    assert.equal(registry.unbindPanel("p-1"), "t-1");
    assert.ok(registry.getThread("t-1") !== undefined, "thread record survives panel close");
    assert.equal(registry.threadForPanel("p-1"), null);
  });

  it("persists only metadata + drafts", () => {
    const storage = new InMemoryStorage();
    const registry = new ThreadRegistry(storage);
    registry.bindPanel("p-1", "t-1", "chat", "w-1");
    registry.saveDraft("p-1", "half-typed…");
    const reloaded = new ThreadRegistry(storage);
    assert.deepEqual(reloaded.bindingForPanel("p-1"), { panelId: "p-1", threadId: "t-1", displayName: "chat", workspaceKey: "w-1", draft: "half-typed…" });
    assert.equal(reloaded.bindingsForWorkspace("w-1").length, 1);
    assert.equal(reloaded.bindingsForWorkspace("other").length, 0);
  });
});

describe("PanelRegistry", () => {
  it("tracks panels until disposed", () => {
    const registry = new PanelRegistry();
    const a = fakePanel("p-a");
    const b = fakePanel("p-b");
    registry.register(a.panel);
    registry.register(b.panel);
    assert.equal(registry.count(), 2);
    a.panel.dispose();
    assert.equal(registry.count(), 1);
    assert.equal(registry.get("p-b"), b.panel);
  });
});

describe("EventRouter", () => {
  it("routes to the owning thread only", () => {
    const router = new EventRouter();
    const gotA: string[] = [];
    const gotB: string[] = [];
    router.subscribe("t-a", { onNotification: (event) => gotA.push(event.method) });
    router.subscribe("t-b", { onNotification: (event) => gotB.push(event.method) });
    router.routeNotification(notification("item/agentMessage/delta", { threadId: "t-a", delta: "hi" }));
    assert.deepEqual(gotA, ["item/agentMessage/delta"]);
    assert.deepEqual(gotB, []);
  });

  it("broadcasts global (thread-less) notifications to every sink", () => {
    const router = new EventRouter();
    const gotA: string[] = [];
    const globals: string[] = [];
    router.subscribe("t-a", { onNotification: (event) => gotA.push(event.method) });
    router.subscribeGlobal({ onGlobalNotification: (event) => globals.push(event.method) });
    router.routeNotification(notification("account/updated", { reason: "x" }));
    assert.deepEqual(gotA, ["account/updated"]);
    assert.deepEqual(globals, ["account/updated"]);
  });

  it("parks unknown threads as orphaned and replays the buffer on subscribe", () => {
    const router = new EventRouter();
    router.routeNotification(notification("item/agentMessage/delta", { threadId: "t-new", delta: "one" }));
    assert.equal(router.orphanedCount, 1);
    const got: string[] = [];
    router.subscribe("t-new", { onNotification: (event) => got.push(event.method) });
    assert.deepEqual(got, ["item/agentMessage/delta"]);
  });

  it("pauses buffer while hidden with a bounded cap and drop counter", () => {
    const router = new EventRouter();
    const got: string[] = [];
    const unsub = router.subscribe("t-a", { onNotification: (event) => got.push(event.method) });
    router.setPaused("t-a", true);
    for (let index = 0; index < MAX_BUFFERED_PER_THREAD + 50; index += 1) {
      router.routeNotification(notification("item/agentMessage/delta", { threadId: "t-a", delta: String(index) }));
    }
    assert.equal(router.bufferedCount("t-a"), MAX_BUFFERED_PER_THREAD);
    assert.equal(router.droppedCount("t-a"), 50);
    unsub();
    // Re-subscribing replays the bounded buffer in order (oldest dropped).
    const replayed: string[] = [];
    router.subscribe("t-a", { onNotification: (event) => replayed.push(((event.params ?? {}) as { delta?: string }).delta ?? "") });
    assert.equal(replayed.length, MAX_BUFFERED_PER_THREAD);
    assert.equal(replayed[0], "50");
    void got;
  });

  it("server requests go to exactly one owner (most recent first)", () => {
    const router = new EventRouter();
    const order: string[] = [];
    router.subscribe("t-a", { onNotification: () => undefined, onServerRequest: () => order.push("first") });
    router.subscribe("t-a", { onNotification: () => undefined, onServerRequest: () => order.push("second") });
    assert.equal(router.routeServerRequest({ id: "r-1", method: "item/commandExecution/requestApproval", params: { threadId: "t-a" } }), true);
    assert.deepEqual(order, ["second"]);
    assert.equal(router.routeServerRequest({ id: "r-2", method: "item/commandExecution/requestApproval", params: { threadId: "t-zzz" } }), false);
  });
});
