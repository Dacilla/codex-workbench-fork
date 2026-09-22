/**
 * Model + reasoning-effort picker tests:
 * - turn/start param forwarding against the fake (overrides present when set,
 *   keys absent — never null — when unset), mirroring the composer/send path
 *   (SessionManager.startTurn + ThreadRegistry.overrideParams).
 * - Override resolution + new-thread inheritance in ThreadRegistry.
 * - ext/model reducer state + header segment formatting (never "unknown").
 * - Catalog parsing/validation: hidden skipped, unknown ids rejected,
 *   effort options from the catalog, static fallback otherwise.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { InMemoryStorage, ThreadRegistry } from "../sessions/ThreadRegistry";
import { FALLBACK_EFFORTS, defaultModel, displayLabelFor, effortOptionsFor, findModel, parseModelList, validateModelChoice, visibleModels } from "../sessions/ModelCatalog";
import { formatModelSegment, initialState, reduce } from "../webview/state";
import { connectFake } from "./helpers";

function threadIdOf(started: Record<string, unknown>): string {
  return ((started["thread"] ?? {}) as Record<string, unknown>)["id"] as string;
}

function readTurnParams(path: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(path)) {
    return [];
  }
  return fs
    .readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => (JSON.parse(line) as { params: Record<string, unknown> }).params);
}

describe("turn/start override forwarding (fake transport)", () => {
  it("forwards model+effort when set; omits the keys when unset", async () => {
    const recordPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wb-turns-")), "turns.jsonl");
    const { manager, cleanup } = await connectFake([`--record-turns=${recordPath}`]);
    try {
      const started = (await manager.startThread()) as Record<string, unknown>;
      const threadId = threadIdOf(started);
      await manager.startTurn(threadId, "pinned", { model: "fake-model", effort: "high" });
      await manager.startTurn(threadId, "default");
      const [pinned, plain] = readTurnParams(recordPath);
      assert.equal(pinned?.["model"], "fake-model");
      assert.equal(pinned?.["effort"], "high");
      assert.ok(plain !== undefined && !("model" in plain) && !("effort" in plain), "unset overrides must be absent, never null");
    } finally {
      await cleanup();
    }
  });

  it("thread override pins flow through overrideParams into startTurn", async () => {
    const recordPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wb-turns-")), "turns.jsonl");
    const { manager, cleanup } = await connectFake([`--record-turns=${recordPath}`]);
    try {
      const started = (await manager.startThread()) as Record<string, unknown>;
      const threadId = threadIdOf(started);
      // Same shape extension.ts composer/send uses: overrideParams spread.
      manager.threads.setThreadOverride(threadId, { model: "fake-model", effort: "low" });
      await manager.startTurn(threadId, "hello", { ...manager.threads.overrideParams(threadId) });
      const [params] = readTurnParams(recordPath);
      assert.equal(params?.["model"], "fake-model");
      assert.equal(params?.["effort"], "low");
    } finally {
      await cleanup();
    }
  });
});

describe("ThreadRegistry model/effort overrides", () => {
  it("resolves per-thread pins with last-chosen inheritance", () => {
    const registry = new ThreadRegistry(new InMemoryStorage());
    assert.deepEqual(registry.effectiveOverride("t-new"), { model: null, effort: null });
    registry.setThreadOverride("t-1", { model: "m-a", effort: "high" });
    assert.deepEqual(registry.effectiveOverride("t-1"), { model: "m-a", effort: "high" });
    // A new thread inherits the last explicitly chosen values (inherit-and-send).
    assert.deepEqual(registry.effectiveOverride("t-2"), { model: "m-a", effort: "high" });
    // A thread-specific patch overrides only the keys it sets.
    registry.setThreadOverride("t-2", { effort: "low" });
    assert.deepEqual(registry.effectiveOverride("t-2"), { model: "m-a", effort: "low" });
    assert.deepEqual(registry.effectiveOverride("t-1"), { model: "m-a", effort: "high" });
  });

  it("overrideParams omits unset keys; rememberChoice seeds inheritance", () => {
    const registry = new ThreadRegistry(new InMemoryStorage());
    assert.deepEqual(registry.overrideParams("t-1"), {});
    registry.rememberChoice({ model: "m-b" });
    assert.deepEqual(registry.overrideParams("t-1"), { model: "m-b" });
    assert.deepEqual(registry.lastChosenOverride(), { model: "m-b", effort: null });
  });
});

describe("ext/model header state", () => {
  it("reducer stores the posted model/effort/label", () => {
    let state = initialState();
    assert.equal(state.model, null);
    state = reduce(state, { type: "ext/model", model: "m-a", effort: "high", displayName: "Model A" });
    assert.equal(state.model, "m-a");
    assert.equal(state.effort, "high");
    assert.equal(state.modelLabel, "Model A");
    state = reduce(state, { type: "ext/model", model: null, effort: null, displayName: null });
    assert.equal(state.model, null);
    assert.equal(state.effort, null);
  });

  it("header segment shows display names, else raw ids, never 'unknown'", () => {
    assert.equal(formatModelSegment(null, null, null), " · model: default");
    assert.equal(formatModelSegment("m-a", null, "Model A"), " · model: Model A");
    assert.equal(formatModelSegment("m-a", null, null), " · model: m-a");
    assert.equal(formatModelSegment("m-a", "high", "Model A"), " · model: Model A · effort: high");
    assert.equal(formatModelSegment(null, "low", null), " · model: default · effort: low");
    for (const segment of [formatModelSegment(null, null, null), formatModelSegment("m-a", "high", null), formatModelSegment(null, "low", null)]) {
      assert.ok(!segment.includes("unknown"), `must never render "unknown": ${segment}`);
    }
  });
});

describe("ModelCatalog", () => {
  const catalog = parseModelList({
    data: [
      {
        id: "fake-model",
        displayName: "Fake Model",
        description: "default test model",
        hidden: false,
        isDefault: true,
        supportedReasoningEfforts: [{ reasoningEffort: "low", description: "fast" }],
        defaultReasoningEffort: "low",
      },
      { id: "fake-hidden", displayName: "Hidden", description: "", hidden: true, isDefault: false, supportedReasoningEfforts: [], defaultReasoningEffort: null },
      { garbage: true },
    ],
  });

  it("parses tolerantly, skips hidden, finds the default", () => {
    assert.equal(catalog.length, 2);
    assert.deepEqual(visibleModels(catalog).map((entry) => entry.id), ["fake-model"]);
    assert.equal(defaultModel(catalog)?.id, "fake-model");
    assert.equal(findModel(catalog, "fake-model")?.efforts.length, 1);
    assert.equal(displayLabelFor(catalog, "fake-model"), "Fake Model");
    assert.equal(displayLabelFor(catalog, "nope"), null);
  });

  it("rejects unknown and hidden model ids", () => {
    assert.equal(validateModelChoice(catalog, "fake-model").ok, true);
    const unknown = validateModelChoice(catalog, "ghost-model");
    assert.equal(unknown.ok, false);
    if (!unknown.ok) {
      assert.match(unknown.error, /not advertised/);
    }
    assert.equal(validateModelChoice(catalog, "fake-hidden").ok, false);
  });

  it("serves catalog effort options, falls back only when the model is lacking", () => {
    const catalogued = effortOptionsFor(catalog, "fake-model");
    assert.equal(catalogued.fromFallback, false);
    assert.deepEqual(catalogued.options.map((option) => option.effort), ["low"]);
    for (const modelId of ["ghost-model", null]) {
      const fallback = effortOptionsFor(catalog, modelId);
      assert.equal(fallback.fromFallback, true);
      assert.deepEqual(fallback.options, FALLBACK_EFFORTS);
      assert.ok(fallback.options.length > 0);
    }
  });
});
