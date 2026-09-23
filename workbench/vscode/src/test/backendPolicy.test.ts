/** Unit tests: backend write-policy classification (pure, no transport). */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyBackendWritePolicy,
  extractBackendVersion,
  KNOWN_COMPATIBLE_BACKEND_VERSIONS,
} from "../backend/BackendPolicy";
import { SessionManager } from "../sessions/SessionManager";
import { FAKE_PATH } from "./helpers";

describe("extractBackendVersion", () => {
  it("parses semver from official-style userAgents", () => {
    assert.equal(extractBackendVersion("codex-workbench/0.155.1 (Windows 10.0.26200; x86_64)"), "0.155.1");
    assert.equal(extractBackendVersion("codex-app-server/1.2.3"), "1.2.3");
  });

  it("returns null when no version is present", () => {
    assert.equal(extractBackendVersion("codex-workbench-fake"), null);
    assert.equal(extractBackendVersion(""), null);
  });
});

describe("classifyBackendWritePolicy", () => {
  it("deliberate binary choices always get full operation", () => {
    for (const source of ["explicit-setting", "path-workbench"] as const) {
      assert.deepEqual(
        classifyBackendWritePolicy({ source, userAgent: "codex-workbench/9.9.9 (x)" }),
        { mode: "full" },
      );
    }
  });

  it("live-validated versions get full operation", () => {
    for (const version of KNOWN_COMPATIBLE_BACKEND_VERSIONS) {
      assert.deepEqual(
        classifyBackendWritePolicy({ source: "path-official", userAgent: `codex-workbench/${version} (x)` }),
        { mode: "full" },
      );
    }
  });

  it("gates unvalidated official backends with an actionable reason", () => {
    const policy = classifyBackendWritePolicy({ source: "well-known-dir", userAgent: "codex-workbench/0.999.0 (x)" });
    assert.equal(policy.mode, "gated");
    if (policy.mode === "gated") {
      assert.ok(policy.reason.includes("0.999.0"));
    }
  });

  it("unit-test sessions without origin info stay fully operational", () => {
    assert.deepEqual(classifyBackendWritePolicy({ userAgent: "codex-workbench-fake" }), { mode: "full" });
  });
});

describe("session write gate", () => {
  it("blocks turns on unvalidated backends until overridden", async () => {
    const manager = new SessionManager();
    await manager.connect(process.execPath, [FAKE_PATH], { backendSource: "path-official" });
    try {
      assert.equal(manager.writePolicySnapshot.mode, "gated");
      await assert.rejects(manager.startTurn("thread-x", "hi"), /Allow Writes Anyway/);
      manager.allowWritesAnyway();
      // Past the gate the request dispatches: the fake answers instead of
      // the policy rejecting.
      const response = await manager.startTurn("thread-x", "hi", { timeoutMs: 5000 });
      assert.ok(typeof response === "object" && response !== null);
    } finally {
      await manager.disconnect("test cleanup");
    }
  });

  it("validated versions and deliberate binaries are never gated", async () => {
    const known = new SessionManager();
    await known.connect(process.execPath, [FAKE_PATH], { backendSource: "explicit-setting" });
    try {
      assert.equal(known.writePolicySnapshot.mode, "full");
    } finally {
      await known.disconnect("test cleanup");
    }
  });
});
