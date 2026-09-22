/**
 * Collaboration-mode toggle tests:
 * - `thread/settings/update` request shape against the fake (camelCase outer
 *   keys, snake_case `settings` keys, null built-in-instructions marker —
 *   mirroring the pinned `CollaborationMode`/`Settings` generated TS).
 * - Model/effort echo-back (the server REPLACES mode+settings, so pins must
 *   ride along or they would be cleared).
 * - Fail-closed errors: unknown thread, empty threadId, unknown mode, no
 *   known model — the local mode map stays untouched on every failure.
 * - Registry mode persistence/inheritance (+ malformed restore ignored).
 * - `ext/model` header segment for the mode (never "unknown").
 * - Handshake `experimentalApi` flag (the whole settings/update method is
 *   gated on it; see sessions/CollaborationMode.ts).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { InMemoryStorage, ThreadRegistry } from "../sessions/ThreadRegistry";
import type { PersistedPanelBinding } from "../sessions/ThreadRegistry";
import {
  buildThreadModeUpdateParams,
  parsePersistedMode,
  validateCollaborationMode,
} from "../sessions/CollaborationMode";
import { formatModeSegment, initialState, reduce } from "../webview/state";
import { connectFake } from "./helpers";

function threadIdOf(started: Record<string, unknown>): string {
  return ((started["thread"] ?? {}) as Record<string, unknown>)["id"] as string;
}

function readRecordedParams(filePath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => (JSON.parse(line) as { params: Record<string, unknown> }).params);
}

function tempOutput(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), name)), `${name}.jsonl`);
}

describe("thread/settings/update mode payload (fake transport)", () => {
  it("sends the exact wire shape with echoed model and null instructions", async () => {
    const recordPath = tempOutput("wb-modes-");
    const { manager, cleanup } = await connectFake([`--record-modes=${recordPath}`]);
    try {
      const started = (await manager.startThread()) as Record<string, unknown>;
      const threadId = threadIdOf(started);
      await manager.setThreadMode(threadId, "plan");
      const [params] = readRecordedParams(recordPath);
      assert.deepEqual(params, {
        threadId,
        collaborationMode: {
          mode: "plan",
          settings: {
            // Fake thread/start reports model "fake-model"; the toggle echoes
            // it back so the REPLACE semantics cannot clobber the model.
            model: "fake-model",
            reasoning_effort: null,
            developer_instructions: null,
          },
        },
      });
      assert.equal(manager.threads.effectiveMode(threadId), "plan");
    } finally {
      await cleanup();
    }
  });

  it("echoes effort pins and honors explicit model/effort overrides", async () => {
    const recordPath = tempOutput("wb-modes-");
    const { manager, cleanup } = await connectFake([`--record-modes=${recordPath}`]);
    try {
      const threadId = threadIdOf((await manager.startThread()) as Record<string, unknown>);
      manager.threads.setThreadOverride(threadId, { effort: "high" });
      await manager.setThreadMode(threadId, "plan");
      const [pinned] = readRecordedParams(recordPath);
      assert.equal(((pinned?.["collaborationMode"] ?? {}) as Record<string, unknown>)["mode"], "plan");
      assert.deepEqual(((pinned?.["collaborationMode"] ?? {}) as Record<string, unknown>)["settings"], {
        model: "fake-model",
        reasoning_effort: "high",
        developer_instructions: null,
      });
      await manager.setThreadMode(threadId, "default", { model: "custom-m", effort: "low" });
      const [, explicit] = readRecordedParams(recordPath);
      assert.deepEqual((explicit?.["collaborationMode"] ?? {}) as Record<string, unknown>, {
        mode: "default",
        settings: { model: "custom-m", reasoning_effort: "low", developer_instructions: null },
      });
      assert.equal(manager.threads.effectiveMode(threadId), "default");
    } finally {
      await cleanup();
    }
  });

  it("fails closed on an unknown thread and keeps the local mode", async () => {
    const recordPath = tempOutput("wb-modes-");
    const { manager, cleanup } = await connectFake([`--record-modes=${recordPath}`]);
    try {
      // Explicit model so the request reaches the backend, which rejects the
      // unknown thread; the local mode map must stay untouched.
      await assert.rejects(manager.setThreadMode("thr-nope", "plan", { model: "fake-model" }), /unknown thread/);
      assert.equal(readRecordedParams(recordPath).length, 0, "rejected calls record nothing");
      assert.equal(manager.threads.effectiveMode("thr-nope"), "default");
      assert.equal(manager.threads.lastChosenMode(), "default", "failed calls never seed inheritance");
    } finally {
      await cleanup();
    }
  });
});

describe("mode validation", () => {
  it("accepts only the exact lowercase literals", () => {
    assert.deepEqual(validateCollaborationMode("default"), { ok: true, mode: "default" });
    assert.deepEqual(validateCollaborationMode("plan"), { ok: true, mode: "plan" });
    for (const bad of ["Plan", "PLAN", "", "code", "turbo", null, undefined, 42, {}, []]) {
      assert.equal(validateCollaborationMode(bad).ok, false, `must reject ${JSON.stringify(bad)}`);
    }
  });

  it("rejects empty thread ids, unknown modes, and missing models without touching the transport", async () => {
    const { manager, cleanup } = await connectFake();
    try {
      const threadId = threadIdOf((await manager.startThread()) as Record<string, unknown>);
      await assert.rejects(manager.setThreadMode("", "plan"), /threadId is empty/);
      await assert.rejects(
        manager.setThreadMode(threadId, "turbo" as unknown as "plan"),
        /unknown collaboration mode/,
      );
      assert.equal(manager.threads.effectiveMode(threadId), "default");
      // A thread with no known model (never started, never pinned) fails
      // instead of sending an empty settings.model.
      manager.threads.upsertThread({
        threadId: "t-modeless",
        displayName: "modeless",
        workspaceKey: "w",
        model: null,
        effort: null,
        cwd: null,
        status: "idle",
        lastTurnId: null,
        updatedAtMs: 1,
      });
      await assert.rejects(manager.setThreadMode("t-modeless", "plan"), /no model known/);
      assert.equal(manager.threads.effectiveMode("t-modeless"), "default");
    } finally {
      await cleanup();
    }
  });

  it("buildThreadModeUpdateParams fails closed on bad input", () => {
    assert.equal(buildThreadModeUpdateParams("", "plan", "m").ok, false);
    assert.equal(buildThreadModeUpdateParams("t", "turbo" as unknown as "plan", "m").ok, false);
    assert.equal(buildThreadModeUpdateParams("t", "plan", "").ok, false);
    assert.equal(buildThreadModeUpdateParams("t", "plan", "m", "").ok, false);
    const good = buildThreadModeUpdateParams("t", "plan", "m");
    assert.equal(good.ok, true);
    if (good.ok) {
      assert.deepEqual(good.params, {
        threadId: "t",
        collaborationMode: { mode: "plan", settings: { model: "m", reasoning_effort: null, developer_instructions: null } },
      });
    }
  });
});

describe("ThreadRegistry collaboration modes", () => {
  it("defaults to default and inherits the last explicit choice", () => {
    const registry = new ThreadRegistry(new InMemoryStorage());
    assert.equal(registry.effectiveMode("t-new"), "default");
    assert.equal(registry.lastChosenMode(), "default");
    registry.setThreadMode("t-1", "plan");
    assert.equal(registry.effectiveMode("t-1"), "plan");
    assert.equal(registry.effectiveMode("t-2"), "plan", "new threads inherit");
    registry.setThreadMode("t-2", "default");
    assert.equal(registry.effectiveMode("t-2"), "default");
    assert.equal(registry.effectiveMode("t-1"), "plan", "per-thread pins are independent");
  });

  it("pinThreadMode and rememberModeChoice do not disturb inheritance semantics", () => {
    const registry = new ThreadRegistry(new InMemoryStorage());
    registry.setThreadMode("t-1", "plan");
    // Failure fallback: this thread is honestly default, session default stays plan.
    registry.pinThreadMode("t-9", "default");
    assert.equal(registry.effectiveMode("t-9"), "default");
    assert.equal(registry.lastChosenMode(), "plan");
    assert.equal(registry.effectiveMode("t-fresh"), "plan");
    // Pre-thread choice seeds inheritance with no thread attached.
    const empty = new ThreadRegistry(new InMemoryStorage());
    empty.rememberModeChoice("plan");
    assert.equal(empty.effectiveMode("t-any"), "plan");
  });

  it("persists non-default modes and ignores malformed restores", () => {
    // Mirrors the extension.ts persist/restore flow without the vscode API:
    // persistBindings writes `mode` only for non-default effective modes;
    // restoreThreadPins re-applies only values parsePersistedMode accepts.
    const storage = new InMemoryStorage();
    const registry = new ThreadRegistry(storage);
    registry.setThreadMode("t-1", "plan");
    const binding: PersistedPanelBinding = {
      panelId: "p-1",
      threadId: "t-1",
      displayName: "chat",
      workspaceKey: "w-1",
      ...(registry.effectiveMode("t-1") !== "default" ? { mode: registry.effectiveMode("t-1") } : {}),
    };
    assert.deepEqual(binding.mode, "plan");
    const restored = parsePersistedMode(binding.mode);
    assert.equal(restored, "plan");
    const reloaded = new ThreadRegistry(new InMemoryStorage());
    if (restored !== null) {
      reloaded.setThreadMode("t-1", restored);
    }
    assert.equal(reloaded.effectiveMode("t-1"), "plan");
    // Malformed or absent values never apply.
    for (const bad of ["Turbo", "", "PLAN", null, undefined, 42]) {
      assert.equal(parsePersistedMode(bad), null, `must ignore ${JSON.stringify(bad)}`);
    }
    const untouched: PersistedPanelBinding = { panelId: "p-2", threadId: "t-2", displayName: "chat", workspaceKey: "w-1" };
    assert.equal(parsePersistedMode(untouched.mode), null, "absent mode stays backend-default");
    assert.ok(!("mode" in untouched), "untouched threads persist no mode key");
  });
});

describe("ext/model mode header state", () => {
  it("reducer stores the posted mode and keeps it when absent", () => {
    let state = initialState();
    assert.equal(state.mode, "default");
    state = reduce(state, { type: "ext/model", model: null, effort: null, displayName: null, mode: "plan" });
    assert.equal(state.mode, "plan");
    // Older host messages without the field preserve the current mode.
    state = reduce(state, { type: "ext/model", model: "m-a", effort: null, displayName: null });
    assert.equal(state.mode, "plan");
    assert.equal(state.model, "m-a");
    state = reduce(state, { type: "ext/model", model: null, effort: null, displayName: null, mode: "default" });
    assert.equal(state.mode, "default");
  });

  it("header segment always renders, never 'unknown'", () => {
    assert.equal(formatModeSegment("plan"), " · mode: plan");
    assert.equal(formatModeSegment("default"), " · mode: default");
    for (const fallback of [null, "", "turbo", "Plan"]) {
      const segment = formatModeSegment(fallback);
      assert.equal(segment, " · mode: default", `must fall back to default: ${JSON.stringify(fallback)}`);
      assert.ok(!segment.includes("unknown"), `must never render "unknown": ${segment}`);
    }
  });
});

describe("experimental handshake flag", () => {
  it("forwards experimentalApi: true when requested, false by default", async () => {
    const recordPath = tempOutput("wb-init-");
    const optedIn = await connectFake([`--record-init=${recordPath}`], { experimentalApi: true });
    try {
      await optedIn.manager.startThread();
    } finally {
      await optedIn.cleanup();
    }
    const [params] = readRecordedParams(recordPath);
    assert.deepEqual((params?.["capabilities"] ?? {}) as Record<string, unknown>, {
      experimentalApi: true,
      requestAttestation: false,
    });

    const recordPathDefault = tempOutput("wb-init-");
    const defaulted = await connectFake([`--record-init=${recordPathDefault}`]);
    try {
      await defaulted.manager.startThread();
    } finally {
      await defaulted.cleanup();
    }
    const [defaultParams] = readRecordedParams(recordPathDefault);
    assert.equal(
      ((defaultParams?.["capabilities"] ?? {}) as Record<string, unknown>)["experimentalApi"],
      false,
      "SessionManager must not opt in unless asked (extension.ts opts in explicitly)",
    );
  });
});
