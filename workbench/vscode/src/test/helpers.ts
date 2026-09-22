/** Shared harnesses for fake-server protocol tests (node --test, no vscode API). */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SessionManager } from "../sessions/SessionManager";

export const FAKE_PATH = path.join(__dirname, "fakeAppServer.js");

export async function waitFor(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export interface ConnectedManager {
  manager: SessionManager;
  cleanup: () => Promise<void>;
}

export async function connectFake(fakeArgs: string[] = [], options: { cwd?: string; experimentalApi?: boolean } = {}): Promise<ConnectedManager> {
  const manager = new SessionManager();
  await manager.connect(process.execPath, [FAKE_PATH, ...fakeArgs], options);
  return {
    manager,
    cleanup: () => manager.disconnect("test cleanup"),
  };
}

export function tempRecordPath(): { path: string; readLines: () => string[] } {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wb-approve-")), "approvals.jsonl");
  return {
    path: filePath,
    readLines: () => {
      if (!fs.existsSync(filePath)) {
        return [];
      }
      return fs.readFileSync(filePath, "utf8").split("\n").filter((line) => line.trim() !== "");
    },
  };
}

export interface CollectedEvent {
  method: string;
  params: unknown;
}

export function collectSink(collected: CollectedEvent[]): { onNotification: (notification: { method: string; params?: unknown }) => void; onServerRequest: (request: unknown) => void; requests: unknown[] } {
  const requests: unknown[] = [];
  return {
    onNotification: (notification: { method: string; params?: unknown }) => {
      collected.push({ method: notification.method, params: notification.params });
    },
    onServerRequest: (request: unknown) => {
      requests.push(request);
    },
    requests,
  };
}

export function threadIdOfParams(params: unknown): string | null {
  if (params !== null && typeof params === "object" && !Array.isArray(params)) {
    const threadId = (params as Record<string, unknown>)["threadId"];
    return typeof threadId === "string" ? threadId : null;
  }
  return null;
}
