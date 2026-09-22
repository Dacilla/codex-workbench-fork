/** Unit tests: concurrent connect attempts share one flight. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConnectGate } from "../sessions/ConnectGate";

function deferred(): { promise: Promise<boolean>; resolve: (value: boolean) => void } {
  let resolve = (_value: boolean): void => undefined;
  const promise = new Promise<boolean>((inner) => {
    resolve = inner;
  });
  return { promise, resolve };
}

describe("ConnectGate", () => {
  it("coalesces concurrent attempts into one flight", async () => {
    const gate = new ConnectGate();
    let attempts = 0;
    const first = deferred();
    const attempt = (): Promise<boolean> => {
      attempts += 1;
      return first.promise;
    };
    const a = gate.run(attempt);
    const b = gate.run(attempt);
    assert.equal(attempts, 1);
    first.resolve(true);
    assert.deepEqual(await Promise.all([a, b]), [true, true]);
  });

  it("starts a fresh attempt after the flight settles", async () => {
    const gate = new ConnectGate();
    let attempts = 0;
    assert.equal(await gate.run(async () => {
      attempts += 1;
      return true;
    }), true);
    assert.equal(await gate.run(async () => {
      attempts += 1;
      return false;
    }), false);
    assert.equal(attempts, 2);
  });

  it("shares failures without hanging late joiners", async () => {
    const gate = new ConnectGate();
    let attempts = 0;
    const attempt = async (): Promise<boolean> => {
      attempts += 1;
      throw new Error("handshake failed");
    };
    const a = gate.run(attempt);
    const b = gate.run(attempt);
    await assert.rejects(a, /handshake failed/);
    await assert.rejects(b, /handshake failed/);
    assert.equal(attempts, 1);
  });
});
