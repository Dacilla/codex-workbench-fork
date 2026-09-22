/** Backend discovery: host-local resolution, explicit override, no cross-host leakage. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { backendSpawnArgs, discoverBackend, DiscoveryError } from "../backend/BackendDiscovery";

describe("BackendDiscovery", () => {
  it("spawns the documented argv", () => {
    assert.deepEqual(backendSpawnArgs(), ["app-server"]);
  });

  it("rejects a nonexistent explicit path instead of falling through", () => {
    assert.throws(() => discoverBackend("C:\\definitely\\not\\here\\codex.exe"), DiscoveryError);
    assert.throws(() => discoverBackend("/definitely/not/here/codex"), DiscoveryError);
  });

  it("accepts an existing executable as explicit override", () => {
    const result = discoverBackend(process.execPath);
    assert.equal(result.executable, process.execPath);
    assert.equal(result.source, "explicit-setting");
    assert.deepEqual(result.argv, ["app-server"]);
  });

  it("empty setting falls back to PATH discovery or throws DiscoveryError", () => {
    try {
      const result = discoverBackend("");
      assert.ok(result.executable.length > 0);
    } catch (error) {
      assert.ok(error instanceof DiscoveryError);
    }
  });
});
