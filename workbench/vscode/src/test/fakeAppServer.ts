/**
 * Fake `codex app-server` for protocol tests. Speaks newline-delimited
 * JSON-RPC over stdio with the pinned wire shapes (see
 * workbench/docs/vscode-feature-matrix.md). Run with node:
 *
 *   node out/test/fakeAppServer.js [--hang=<method>] [--die-after-ms=<n>] [--record=<path>]
 *
 * - `--hang`: never answer that method (timeout tests).
 * - `--die-after-ms`: exit(1) after N ms (crash/reconnect tests).
 * - `--record`: append every approval *response received* as JSONL
 *   `{ id, result }` (exactly-once + fail-closed assertions).
 * - `--record-turns`: append every `turn/start` *request params received* as
 *   JSONL `{ id, params }` (model/effort override forwarding assertions).
 * - `--record-modes`: append every `thread/settings/update` *request params
 *   received* as JSONL `{ id, params }` (collaboration-mode payload shape
 *   assertions). Unknown threads are rejected, like the real backend.
 * - `--record-init`: append every `initialize` *request params received* as
 *   JSONL `{ id, params }` (handshake capability assertions, e.g. that the
 *   client opts into `experimentalApi` for the settings/update escape hatch).
 *
 * A turn whose text contains `[ask-approval]` triggers one
 * `item/commandExecution/requestApproval` server request and completes the
 * turn only after the client answers (or after 5 s, completing anyway).
 */
import * as fs from "fs";

interface Args {
  hang: Set<string>;
  dieAfterMs: number;
  recordPath: string | null;
  recordTurnsPath: string | null;
  recordModesPath: string | null;
  recordInitPath: string | null;
}

function parseArgs(): Args {
  const args: Args = { hang: new Set(), dieAfterMs: 0, recordPath: null, recordTurnsPath: null, recordModesPath: null, recordInitPath: null };
  for (const raw of process.argv.slice(2)) {
    if (raw.startsWith("--hang=")) {
      args.hang.add(raw.slice("--hang=".length));
    } else if (raw.startsWith("--die-after-ms=")) {
      args.dieAfterMs = Number(raw.slice("--die-after-ms=".length));
    } else if (raw.startsWith("--record=")) {
      args.recordPath = raw.slice("--record=".length);
    } else if (raw.startsWith("--record-turns=")) {
      args.recordTurnsPath = raw.slice("--record-turns=".length);
    } else if (raw.startsWith("--record-modes=")) {
      args.recordModesPath = raw.slice("--record-modes=".length);
    } else if (raw.startsWith("--record-init=")) {
      args.recordInitPath = raw.slice("--record-init=".length);
    }
  }
  return args;
}

const args = parseArgs();

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function recordApprovalResponse(id: unknown, result: unknown): void {
  if (args.recordPath === null) {
    return;
  }
  fs.appendFileSync(args.recordPath, `${JSON.stringify({ id, result })}\n`);
}

function recordTurnStart(id: unknown, params: Record<string, unknown>): void {
  if (args.recordTurnsPath === null) {
    return;
  }
  fs.appendFileSync(args.recordTurnsPath, `${JSON.stringify({ id, params })}\n`);
}

function recordParams(recordPath: string | null, id: unknown, params: Record<string, unknown>): void {
  if (recordPath === null) {
    return;
  }
  fs.appendFileSync(recordPath, `${JSON.stringify({ id, params })}\n`);
}

let threadCounter = 0;
let turnCounter = 0;
const threads = new Map<string, { id: string; preview: string }>();
const turns: Array<{ id: string; threadId: string; text: string }> = [];

function platformInfo(): { platformFamily: string; platformOs: string } {
  if (process.platform === "win32") {
    return { platformFamily: "windows", platformOs: "windows" };
  }
  if (process.platform === "darwin") {
    return { platformFamily: "unix", platformOs: "macos" };
  }
  return { platformFamily: "unix", platformOs: "linux" };
}

function handleRequest(id: unknown, method: string, params: Record<string, unknown>): void {
  if (args.hang.has(method)) {
    return; // Never answer: the client must time out / abort.
  }
  switch (method) {
    case "initialize": {
      const info = platformInfo();
      recordParams(args.recordInitPath, id, params);
      send({
        id,
        result: {
          userAgent: "codex-workbench-fake/0.1.0 (test)",
          codexHome: "/tmp/wb-fake-codex-home",
          platformFamily: info.platformFamily,
          platformOs: info.platformOs,
        },
      });
      send({ method: "configWarning", params: { summary: "fake backend: test notice", details: null }, emittedAtMs: Date.now() });
      break;
    }
    case "thread/start": {
      threadCounter += 1;
      const threadId = `thr-fake-${threadCounter}`;
      threads.set(threadId, { id: threadId, preview: "" });
      send({
        id,
        result: {
          thread: { id: threadId, preview: "", historyMode: "paginated", status: { type: "idle" }, model: "fake-model", modelProvider: "fake" },
          model: "fake-model",
          modelProvider: "fake",
          serviceTier: null,
          disabledPluginIds: [],
          cwd: "/tmp",
          instructionSources: [],
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: "read-only",
          reasoningEffort: null,
        },
      });
      break;
    }
    case "thread/fork": {
      const sourceId = String(params["threadId"] ?? "");
      if (!threads.has(sourceId)) {
        send({ id, error: { code: -32000, message: `unknown thread ${sourceId}` } });
        break;
      }
      threadCounter += 1;
      const threadId = `thr-fake-${threadCounter}`;
      threads.set(threadId, { id: threadId, preview: "" });
      send({
        id,
        result: {
          thread: { id: threadId, preview: "", historyMode: "paginated", status: { type: "idle" }, model: "fake-model", modelProvider: "fake" },
          model: "fake-model",
          modelProvider: "fake",
          serviceTier: null,
          disabledPluginIds: [],
          cwd: "/tmp",
          instructionSources: [],
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: "read-only",
          reasoningEffort: null,
        },
      });
      break;
    }
    case "thread/resume": {
      const threadId = String(params["threadId"] ?? "");
      if (!threads.has(threadId)) {
        send({ id, error: { code: -32000, message: `unknown thread ${threadId}` } });
        break;
      }
      send({
        id,
        result: {
          thread: { id: threadId, preview: "", historyMode: "paginated", status: { type: "idle" } },
          model: "fake-model",
          modelProvider: "fake",
          serviceTier: null,
          cwd: "/tmp",
          instructionSources: [],
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: "read-only",
          reasoningEffort: null,
          collaborationMode: null,
          turnsBackwardsCursor: `cursor-turns-${threadId}`,
          itemsBackwardsCursor: `cursor-items-${threadId}`,
        },
      });
      break;
    }
    case "thread/list": {
      send({
        id,
        result: {
          data: [...threads.values()].map((thread) => ({ id: thread.id, preview: thread.preview, historyMode: "paginated", status: { type: "notLoaded" } })),
          nextCursor: null,
          backwardsCursor: null,
        },
      });
      break;
    }
    case "thread/turns/list": {
      const threadId = String(params["threadId"] ?? "");
      const data = turns.filter((turn) => turn.threadId === threadId).map((turn) => ({ id: turn.id, items: [], itemsView: "summary", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1 }));
      send({ id, result: { data, nextCursor: null, backwardsCursor: data.length > 0 ? `bc-${threadId}` : null } });
      break;
    }
    case "thread/items/list": {
      const threadId = String(params["threadId"] ?? "");
      const data = turns
        .filter((turn) => turn.threadId === threadId)
        .flatMap((turn) => [
          { turnId: turn.id, item: { type: "userMessage", id: `item-u-${turn.id}`, clientId: null, content: [{ type: "text", text: turn.text, text_elements: [] }] } },
          { turnId: turn.id, item: { type: "agentMessage", id: `item-a-${turn.id}`, text: `echo: ${turn.text}`, phase: "answer", memoryCitation: null, delivery: null, questions: null } },
        ]);
      send({ id, result: { data, nextCursor: null, backwardsCursor: null } });
      break;
    }
    case "turn/start": {
      const threadId = String(params["threadId"] ?? "");
      recordTurnStart(id, params);
      turnCounter += 1;
      const turnId = `turn-fake-${turnCounter}`;
      const input = Array.isArray(params["input"]) ? (params["input"] as Array<Record<string, unknown>>) : [];
      const text = input.map((entry) => String(entry["text"] ?? "")).join("");
      turns.push({ id: turnId, threadId, text });
      const thread = threads.get(threadId);
      if (thread !== undefined) {
        thread.preview = text.slice(0, 80);
      }
      send({ id, result: { turn: { id: turnId, items: [], itemsView: "summary", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } } });
      void streamTurn(threadId, turnId, text);
      break;
    }
    case "turn/interrupt": {
      const threadId = String(params["threadId"] ?? "");
      const turnId = String(params["turnId"] ?? "");
      send({ id, result: {} });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], itemsView: "summary", status: "interrupted", error: null, startedAt: 1, completedAt: 2, durationMs: 1 } }, emittedAtMs: Date.now() });
      break;
    }
    case "thread/settings/update": {
      // Fail closed like the real backend: unknown threads are rejected, and
      // the fake deliberately does NOT enforce the experimentalApi gate (gating
      // is verified by code inspection + the handshake-flag test instead).
      const threadId = String(params["threadId"] ?? "");
      if (!threads.has(threadId)) {
        send({ id, error: { code: -32000, message: `unknown thread ${threadId}` } });
        break;
      }
      recordParams(args.recordModesPath, id, params);
      send({ id, result: {} });
      break;
    }
    case "model/list": {
      send({
        id,
        result: {
          data: [
            {
              id: "fake-model",
              model: "fake-model",
              displayName: "Fake Model",
              description: "default test model",
              hidden: false,
              isDefault: true,
              supportedReasoningEfforts: [
                { reasoningEffort: "low", description: "fast test effort" },
                { reasoningEffort: "medium", description: "balanced test effort" },
                { reasoningEffort: "high", description: "careful test effort" },
              ],
              defaultReasoningEffort: "medium",
            },
            {
              id: "fake-hidden",
              model: "fake-hidden",
              displayName: "Hidden Model",
              description: "never offered by the picker",
              hidden: true,
              isDefault: false,
              supportedReasoningEfforts: [],
              defaultReasoningEffort: "low",
            },
          ],
        },
      });
      send({ method: "account/updated", params: { reason: "fake-test-broadcast" }, emittedAtMs: Date.now() });
      break;
    }
    default: {
      send({ id, error: { code: -32601, message: `method not found: ${method}` } });
      break;
    }
  }
}

async function streamTurn(threadId: string, turnId: string, text: string): Promise<void> {
  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  send({ method: "turn/started", params: { threadId, turn: { id: turnId, items: [], itemsView: "summary", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } }, emittedAtMs: Date.now() });
  const itemId = `item-agent-${turnId}`;
  send({ method: "item/started", params: { threadId, turnId, item: { type: "agentMessage", id: itemId, text: "", phase: "commentary", memoryCitation: null, delivery: null, questions: null }, startedAtMs: Date.now() }, emittedAtMs: Date.now() });
  await wait(20);
  if (text.includes("[ask-approval]")) {
    const approvalId = `appr-${turnId}`;
    const answered = await requestApproval(threadId, turnId, approvalId);
    const marker = answered ? "approved-path" : "denied-path";
    send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId, delta: `decision was ${marker} ` }, emittedAtMs: Date.now() });
  } else {
    send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId, delta: `echo[${threadId}] part1 ` }, emittedAtMs: Date.now() });
    await wait(20);
    send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId, delta: "part2" }, emittedAtMs: Date.now() });
  }
  await wait(20);
  send({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: itemId, text: "final", phase: "answer", memoryCitation: null, delivery: null, questions: null }, completedAtMs: Date.now() }, emittedAtMs: Date.now() });
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], itemsView: "summary", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1 } }, emittedAtMs: Date.now() });
}

function requestApproval(threadId: string, turnId: string, approvalId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resultWaiters.delete(approvalId);
      resolve(false);
    }, 5000);
    resultWaiters.set(approvalId, (result: unknown) => {
      clearTimeout(timer);
      recordApprovalResponse(approvalId, result);
      const decision = (result ?? {}) as Record<string, unknown>;
      resolve(decision["decision"] === "accept" || decision["decision"] === "acceptForSession");
    });
    send({ id: approvalId, method: "item/commandExecution/requestApproval", params: { kind: "command", threadId, turnId, itemId: `item-exec-${turnId}`, startedAtMs: Date.now(), environmentId: null, command: "rm -rf /tmp/wb-test-target", cwd: "/tmp", commandActions: null } });
  });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    dispatchLine(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
  }
});

/** Single dispatcher: method+id → handleRequest; bare results → waiter or late-record. */
const resultWaiters = new Map<string, (result: unknown) => void>();

function dispatchLine(line: string): void {
  if (line.trim() === "") {
    return;
  }
  let message: { id?: unknown; method?: string; params?: Record<string, unknown>; result?: unknown };
  try {
    message = JSON.parse(line) as { id?: unknown; method?: string; params?: Record<string, unknown>; result?: unknown };
  } catch {
    return; // Ignore malformed test input.
  }
  if (typeof message.method === "string" && message.id !== undefined) {
    handleRequest(message.id, message.method, message.params ?? {});
    return;
  }
  if (typeof message.method === "string") {
    return; // Notification from client (e.g. initialized): acknowledge silently.
  }
  if (message.id !== undefined) {
    const waiter = resultWaiters.get(String(message.id));
    if (waiter !== undefined) {
      resultWaiters.delete(String(message.id));
      waiter(message.result);
      return;
    }
    // Late or unclaimed approval answer: still record for exactly-once audits.
    recordApprovalResponse(message.id, message.result);
  }
}

if (args.dieAfterMs > 0) {
  setTimeout(() => process.exit(1), args.dieAfterMs).unref();
}
