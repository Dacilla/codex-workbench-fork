/**
 * Owns the `codex app-server` stdio child process on the extension-host side.
 *
 * Lifetime rules (spec section 4.5):
 * - Closing a webview is NOT stopping a turn; the process keeps running.
 * - Closing VS Code / SSH disconnect MAY kill the child; persisted threads
 *   survive, in-flight turns do not. Reconnect rehydrates via thread/resume
 *   + paginated reads and reports honestly interrupted turns.
 * - On process exit, pending RPC promises are settled by
 *   JsonRpcTransport.close() and the owner is notified exactly once.
 */

import { spawn, ChildProcess } from "child_process";
import { JsonRpcTransport, TransportEvents } from "./JsonRpcTransport";

export interface ProcessStatus {
  running: boolean;
  pid: number | null;
  executable: string;
  exitCode: number | null;
  exitSignal: string | null;
  startedAtMs: number | null;
}

/** Last N stderr lines, sanitized — credentials must never reach logs/webview. */
export class SanitizedLog {
  private readonly lines: string[] = [];
  constructor(private readonly capacity = 200) {}

  push(rawLine: string): void {
    this.lines.push(sanitizeLine(rawLine));
    while (this.lines.length > this.capacity) {
      this.lines.shift();
    }
  }

  snapshot(): string[] {
    return [...this.lines];
  }

  clear(): void {
    this.lines.length = 0;
  }
}

const SECRET_PATTERNS: RegExp[] = [
  /api[_-]?key/i,
  /bearer\s+[A-Za-z0-9\-._~+/=]+/i,
  /sk-[A-Za-z0-9\-_]{8,}/,
  /"apiKey"\s*:\s*"[^"]*"/i,
  /"token"\s*:\s*"[^"]*"/i,
];

export function sanitizeLine(line: string): string {
  let out = line;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[redacted]");
  }
  return out.length > 2000 ? `${out.slice(0, 2000)}…[truncated]` : out;
}

export interface ProcessCallbacks {
  onExit?: (info: { code: number | null; signal: string | null }) => void;
  onStderr?: (line: string) => void;
}

export class ProcessManager {
  private child: ChildProcess | null = null;
  private transport: JsonRpcTransport | null = null;
  private executable = "";
  private exitCode: number | null = null;
  private exitSignal: string | null = null;
  private startedAtMs: number | null = null;
  readonly stderrLog = new SanitizedLog();

  constructor(private readonly callbacks: ProcessCallbacks = {}) {}

  get status(): ProcessStatus {
    return {
      running: this.child !== null && this.exitCode === null && this.exitSignal === null,
      pid: this.child?.pid ?? null,
      executable: this.executable,
      exitCode: this.exitCode,
      exitSignal: this.exitSignal,
      startedAtMs: this.startedAtMs,
    };
  }

  get rpc(): JsonRpcTransport | null {
    return this.transport;
  }

  /**
   * Spawn the backend and attach a multiplexed transport. Rejects when the
   * process exits before/without callers; `onExit` fires exactly once.
   */
  start(executable: string, argv: string[], transportEvents: TransportEvents = {}, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): JsonRpcTransport {
    if (this.child !== null) {
      throw new Error("backend process already started; stop it before starting again");
    }
    this.executable = executable;
    this.exitCode = null;
    this.exitSignal = null;
    this.startedAtMs = Date.now();
    this.stderrLog.clear();

    let child: ChildProcess;
    try {
      child = spawn(executable, argv, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        windowsHide: true,
      });
    } catch (error) {
      throw new Error(`failed to spawn backend '${executable}': ${error instanceof Error ? error.message : String(error)}`);
    }
    this.child = child;

    const transport = new JsonRpcTransport(
      (line: string) => {
        if (child.stdin !== null && child.stdin.writable) {
          child.stdin.write(`${line}\n`);
        }
      },
      {
        ...transportEvents,
        onClose: (reason: string) => transportEvents.onClose?.(reason),
      },
    );
    this.transport = transport;

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => transport.feedData(chunk));
    child.stderr?.setEncoding("utf8");
    let stderrRemainder = "";
    child.stderr?.on("data", (chunk: string) => {
      stderrRemainder += chunk;
      let index = stderrRemainder.indexOf("\n");
      while (index >= 0) {
        const line = stderrRemainder.slice(0, index);
        stderrRemainder = stderrRemainder.slice(index + 1);
        this.stderrLog.push(line);
        this.callbacks.onStderr?.(line);
        index = stderrRemainder.indexOf("\n");
      }
    });
    child.on("error", (error: Error) => {
      this.exitCode = null;
      transport.close(`backend process error: ${error.message}`);
      this.child = null;
      this.callbacks.onExit?.({ code: null, signal: null });
    });
    child.on("exit", (code: number | null, signal: string | null) => {
      this.exitCode = code;
      this.exitSignal = signal;
      transport.close(`backend exited (code=${code}, signal=${signal})`);
      this.child = null;
      this.callbacks.onExit?.({ code, signal });
    });
    return transport;
  }

  /** Graceful stop: SIGTERM, then SIGKILL after `graceMs`. Transport is closed by the exit handler. */
  async stop(graceMs = 3000): Promise<void> {
    const child = this.child;
    if (child === null) {
      return;
    }
    child.kill("SIGTERM");
    const deadline = Date.now() + graceMs;
    while (this.child !== null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (this.child !== null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone; the exit handler settles everything.
      }
    }
  }
}
