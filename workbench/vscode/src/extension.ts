/**
 * Codex Workbench extension host entry point (workspace extension).
 *
 * Flow: WebviewPanel editor tab → this host → `codex app-server` stdio
 * child → initialize → thread/start|resume → turn/start → per-thread
 * streaming back to the owning panel.
 *
 * - One SessionManager (one App Server) per workspace extension host.
 * - Panel close ≠ thread delete; serializer restores panel→thread bindings.
 * - Approvals fail closed and are answered exactly once.
 */

import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { backendSpawnArgs, discoverBackend } from "./backend/BackendDiscovery";
import type { HandshakeResult } from "./backend/ProtocolVersion";
import { diffCandidateFor } from "./ide/DiffProvider";
import { referenceFromEditorContext, renderReferenceAsMention } from "./ide/UriContext";
import type { EventRouter, ThreadSink } from "./sessions/EventRouter";
import { ConnectGate } from "./sessions/ConnectGate";
import { displayLabelFor, effortOptionsFor, findModel, parseModelList, validateModelChoice, visibleModels, defaultModel } from "./sessions/ModelCatalog";
import type { ModelEntry } from "./sessions/ModelCatalog";
import { newPanelId } from "./sessions/ThreadRegistry";
import type { PersistedPanelBinding } from "./sessions/ThreadRegistry";
import { PanelRegistry } from "./sessions/PanelRegistry";
import { SessionManager } from "./sessions/SessionManager";
import { classifyApproval } from "./sessions/Approvals";
import { normalizeThreadItem } from "./webview/normalize";
import { extractUserInputQuestions, validateUserInputAnswers, validateWebviewMessage } from "./webview/protocol";

const VIEW_TYPE = "codexWorkbench.chat";
const STORAGE_KEY = "codexWorkbench.panelBindings";
const APPROVAL_POLICY_KEY = "codexWorkbench.approvalPolicy";
const EXECUTABLE_PATH_KEY = "codexWorkbench.codexExecutablePath";

interface PanelContext {
  panel: vscode.WebviewPanel;
  panelId: string;
  threadId: string | null;
  activeTurnId: string | null;
  mentions: string[];
  unsubscribe: (() => void) | null;
  serializerState?: { panelId: string; threadId: string };
}

let manager: SessionManager | null = null;
let panels: PanelRegistry | null = null;
const livePanels = new Map<string, PanelContext>();
let outputChannel: vscode.OutputChannel | null = null;
let extensionContext: vscode.ExtensionContext | null = null;
/**
 * Last successfully fetched model catalog (id → display name resolution for
 * the header). Refreshed on every model/list call the picker makes; empty
 * until the first fetch, in which case the header shows raw model ids.
 */
let modelCatalog: ModelEntry[] = [];

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  outputChannel = vscode.window.createOutputChannel("Codex Workbench");
  panels = new PanelRegistry();
  manager = new SessionManager(
    {
      onConnectionState: (state, detail) => {
        log(`connection: ${state} — ${detail}`);
        broadcast({ type: "ext/connection", state, detail });
      },
      onHandshake: (handshake: HandshakeResult) => {
        if (handshake.isOfficialFallback) {
          void vscode.window.showWarningMessage(
            `Codex Workbench: connected to official backend (${handshake.response.userAgent}). Protocol drift is tolerated for reads; unsupported methods will error honestly.`,
          );
        }
      },
    },
    {
      onApprovalRequested: (approval) => {
        // Log routing metadata only: summaries may echo tool output, and
        // user-input answers (incl. secrets) must never reach the log.
        log(`approval requested: ${approval.method} thread=${approval.threadId} request=${String(approval.requestId)}`);
        const owner = findPanelForThread(approval.threadId);
        if (owner !== null) {
          // Per-kind card data: the webview decides which controls to offer
          // (Approve/Deny, Deny-only, or per-question answer forms). Only a
          // bounded question excerpt crosses the boundary, never full bodies.
          const kind = classifyApproval(approval.method);
          const questions = kind === "userInput" ? extractUserInputQuestions(approval.params) : null;
          void owner.panel.webview.postMessage({ type: "ext/approval", requestId: approval.requestId, method: approval.method, summary: approval.summary, kind, questions });
        }
      },
      onApprovalSettled: (approval, approved, failClosed) => {
        const owner = findPanelForThread(approval.threadId);
        if (owner !== null) {
          void owner.panel.webview.postMessage({ type: "ext/approvalSettled", requestId: approval.requestId, approved, failClosed });
        }
      },
    },
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexWorkbench.newChat", () => void createChatPanel()),
    vscode.commands.registerCommand("codexWorkbench.openChatBeside", () => void createChatPanel(vscode.ViewColumn.Beside)),
    vscode.commands.registerCommand("codexWorkbench.resumeChat", () => void pickAndResume()),
    vscode.commands.registerCommand("codexWorkbench.renameTab", () => void renameActiveTab()),
    vscode.commands.registerCommand("codexWorkbench.reconnectBackend", () => void reconnect()),
    vscode.commands.registerCommand("codexWorkbench.showLogs", () => outputChannel?.show()),
    vscode.commands.registerCommand("codexWorkbench.attachSelection", () => void attachSelection()),
    vscode.commands.registerCommand("codexWorkbench.selectModel", () => void selectModel()),
    vscode.commands.registerCommand("codexWorkbench.selectEffort", () => void selectEffort()),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      deserializeWebviewPanel: (restored, state) => restorePanel(restored, state as { panelId: string; threadId: string } | undefined),
    }),
  );
  void ensureConnected(true);
}

export function deactivate(): Thenable<void> | undefined {
  panels?.disposeAll();
  if (manager === undefined || manager === null) {
    return undefined;
  }
  return manager.disconnect("extension deactivated").then(() => undefined);
}

function log(message: string): void {
  outputChannel?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function workspaceKey(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (folders === undefined || folders.length === 0) {
    return "";
  }
  const uri = folders[0]?.uri;
  if (uri === undefined) {
    return "";
  }
  return `${uri.scheme}://${uri.authority}${uri.path}`;
}

function config<T>(key: string): T | undefined {
  return vscode.workspace.getConfiguration().get<T>(key);
}

const connectGate = new ConnectGate();

async function ensureConnected(silent: boolean): Promise<boolean> {
  if (manager === null) {
    return false;
  }
  if (manager.connectionState === "ready") {
    return true;
  }
  // Concurrent callers (e.g. auto-connect at activation racing New Chat)
  // share one in-flight attempt instead of tripping "already in progress".
  return connectGate.run(() => doConnect(silent));
}

async function doConnect(silent: boolean): Promise<boolean> {
  if (manager === null) {
    return false;
  }
  let executable: string;
  try {
    const explicit = config<string>(EXECUTABLE_PATH_KEY) ?? "";
    executable = discoverBackend(explicit).executable;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!silent) {
      void vscode.window.showErrorMessage(`Codex Workbench: ${message}`);
    }
    log(`discovery failed: ${message}`);
    return false;
  }
  try {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    await manager.connect(executable, backendSpawnArgs(), { cwd });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!silent) {
      void vscode.window.showErrorMessage(`Codex Workbench: backend handshake failed: ${message}`);
    }
    log(`connect failed: ${message}`);
    return false;
  }
}

async function reconnect(): Promise<void> {
  if (manager === null) {
    return;
  }
  const ok = await ensureConnected(false);
  if (!ok) {
    return;
  }
  // Re-resume known threads metadata-only; report interrupted turns honestly.
  for (const [, panelContext] of livePanels) {
    if (panelContext.threadId !== null) {
      try {
        await manager.resumeThread(panelContext.threadId);
        subscribePanel(panelContext);
        await hydratePanel(panelContext);
        postModelState(panelContext);
        void panelContext.panel.webview.postMessage({ type: "ext/connection", state: "ready", detail: "reconnected; in-flight turns were interrupted" });
      } catch (error) {
        void panelContext.panel.webview.postMessage({ type: "ext/error", message: `resume failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
  }
}

function findPanelForThread(threadId: string | null): PanelContext | null {
  if (threadId === null) {
    return null;
  }
  for (const panelContext of livePanels.values()) {
    if (panelContext.threadId === threadId) {
      return panelContext;
    }
  }
  return null;
}

function broadcast(message: unknown): void {
  for (const panelContext of livePanels.values()) {
    void panelContext.panel.webview.postMessage(message);
  }
}

async function createChatPanel(
  column: vscode.ViewColumn = vscode.ViewColumn.Active,
  options: { startThread?: boolean } = {},
): Promise<PanelContext | null> {
  if (!(await ensureConnected(false)) || manager === null || panels === null || extensionContext === null) {
    return null;
  }
  const panelId = newPanelId();
  const panel = vscode.window.createWebviewPanel(VIEW_TYPE, "Codex Workbench", column, {
    enableScripts: true,
    retainContextWhenHidden: false,
    localResourceRoots: [vscode.Uri.joinPath(extensionContext.extensionUri, "media")],
  });
  const panelContext: PanelContext = { panel, panelId, threadId: null, activeTurnId: null, mentions: [], unsubscribe: null };
  livePanels.set(panelId, panelContext);
  panels.register({
    panelId,
    reveal: (target) => panel.reveal(target),
    postMessage: (message) => void panel.webview.postMessage(message),
    dispose: () => panel.dispose(),
    onDidDispose: (listener) => void panel.onDidDispose(listener),
    setTitle: (title) => {
      panel.title = title;
    },
  });
  panel.webview.html = renderHtml(panel.webview, panelId, null, "");
  wirePanel(panelContext);
  trackPanelFocus(panel, panelId);
  panel.onDidDispose(() => {
    // Close tab ≠ delete thread: drop the binding, fail closed any prompt
    // owned by this panel, keep the thread on the backend.
    manager?.panelDisposed(panelId, panelContext.threadId);
    panelContext.unsubscribe?.();
    livePanels.delete(panelId);
    persistBindings();
  });
  if (options.startThread === false) {
    // Bare chrome for resume flows: the caller binds a resumed thread next.
    // No backend thread is started, so none leaks.
    persistBindings();
    return panelContext;
  }
  try {
    const approvalPolicy = config<string>(APPROVAL_POLICY_KEY) ?? "on-request";
    // New threads inherit the last explicitly chosen model as their
    // thread/start default (inherit-and-send: the same pin also rides every
    // turn/start via composer/send). Effort has no thread/start slot, so it
    // is carried by turn/start pins only. Nothing is sent until the user
    // picks via Select Model / Select Reasoning Effort.
    const inherited = manager.threads.lastChosenOverride();
    const result = (await manager.startThread({
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      approvalPolicy,
      ...(inherited.model !== null ? { model: inherited.model } : {}),
    })) as Record<string, unknown>;
    const thread = (result["thread"] ?? {}) as Record<string, unknown>;
    const threadId = thread["id"] as string;
    panelContext.threadId = threadId;
    manager.threads.bindPanel(panelId, threadId, "Codex Workbench", workspaceKey());
    subscribePanel(panelContext);
    panel.webview.html = renderHtml(panel.webview, panelId, threadId, "");
    void panel.webview.postMessage({ type: "ext/connection", state: "ready", detail: "thread started" });
    postModelState(panelContext);
  } catch (error) {
    void panel.webview.postMessage({ type: "ext/error", message: `thread/start failed: ${error instanceof Error ? error.message : String(error)}` });
  }
  persistBindings();
  return panelContext;
}

function subscribePanel(panelContext: PanelContext): void {
  if (manager === null || panelContext.threadId === null) {
    return;
  }
  panelContext.unsubscribe?.();
  const threadId = panelContext.threadId;
  const sink: ThreadSink = {
    onNotification: (notification) => routeToPanel(panelContext, notification.method, notification.params),
    onServerRequest: () => {
      // Displayed via the ApprovalHandler hook; nothing extra to do here.
    },
  };
  panelContext.unsubscribe = manager.subscribe(threadId, sink);
}

async function hydratePanel(panelContext: PanelContext): Promise<void> {
  if (manager === null || panelContext.threadId === null) {
    return;
  }
  // Paginated hydration: latest items only — never a full blob.
  const items = (await manager.listThreadItems(panelContext.threadId, { limit: 50 })) as Record<string, unknown>;
  const data = Array.isArray(items["data"]) ? (items["data"] as Array<Record<string, unknown>>) : [];
  for (const entry of data) {
    const item = (entry["item"] ?? entry) as Record<string, unknown>;
    routeToPanel(panelContext, "hydrated/item", { item, turnId: entry["turnId"] });
  }
}

async function pickAndResume(): Promise<void> {
  if (!(await ensureConnected(false)) || manager === null) {
    return;
  }
  let threads: Array<Record<string, unknown>>;
  try {
    const result = (await manager.listThreads({ limit: 20 })) as Record<string, unknown>;
    threads = Array.isArray(result["data"]) ? (result["data"] as Array<Record<string, unknown>>) : [];
  } catch (error) {
    void vscode.window.showErrorMessage(`Codex Workbench: thread/list failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const picked = await vscode.window.showQuickPick(
    threads.map((thread) => ({ label: String(thread["name"] ?? thread["preview"] ?? thread["id"]), description: String(thread["id"]), thread })),
    { placeHolder: "Resume a Codex thread in a new editor tab" },
  );
  if (picked === undefined) {
    return;
  }
  const pickedId = String((picked.thread as Record<string, unknown>)["id"]);
  // One thread, one live view: revealing beats a duplicate tab whose
  // approvals could then race the original panel.
  const alreadyOpen = findLivePanelForThread(pickedId);
  if (alreadyOpen !== undefined) {
    alreadyOpen.panel.reveal(alreadyOpen.panel.viewColumn);
    void vscode.window.showInformationMessage("Codex Workbench: that thread is already open — revealed it instead.");
    return;
  }
  const newest = await createChatPanel(vscode.ViewColumn.Active, { startThread: false });
  // Attach the resumed thread to the fresh panel. No backend thread leaks:
  // createChatPanel skips thread/start for resume flows.
  if (newest === null || manager === null) {
    return;
  }
  const threadId = pickedId;
  try {
    await manager.resumeThread(threadId);
    newest.threadId = threadId;
    manager.threads.bindPanel(newest.panelId, threadId, picked.label, workspaceKey());
    subscribePanel(newest);
    newest.panel.webview.html = renderHtml(newest.panel.webview, newest.panelId, threadId, "");
    await hydratePanel(newest);
    postModelState(newest);
  } catch (error) {
    void newest.panel.webview.postMessage({ type: "ext/error", message: `thread/resume failed: ${error instanceof Error ? error.message : String(error)}` });
  }
  persistBindings();
}

async function renameActiveTab(): Promise<void> {
  const entry = activePanel();
  if (entry === undefined) {
    return;
  }
  const name = await vscode.window.showInputBox({ prompt: "Rename Codex chat tab", value: entry.panel.title });
  if (name !== undefined && name !== "") {
    entry.panel.title = name;
    persistBindings();
  }
}

/**
 * The panel model/effort/context commands act on: the focused chat tab when
 * known, else the visible chat tab, or the only live panel when exactly one
 * exists. Focus tracking matters because in a split layout every panel is
 * `visible`, so first-visible would silently hit the wrong thread.
 */
let activePanelId: string | null = null;

function trackPanelFocus(panel: vscode.WebviewPanel, panelId: string): void {
  panel.onDidChangeViewState((event) => {
    if (event.webviewPanel.active) {
      activePanelId = panelId;
    }
  });
  panel.onDidDispose(() => {
    if (activePanelId === panelId) {
      activePanelId = null;
    }
  });
}

function activePanel(): PanelContext | undefined {
  const focused = activePanelId !== null ? livePanels.get(activePanelId) : undefined;
  if (focused !== undefined) {
    return focused;
  }
  const visible = [...livePanels.values()].find((panelContext) => panelContext.panel.visible);
  if (visible !== undefined) {
    return visible;
  }
  return livePanels.size === 1 ? [...livePanels.values()][0] : undefined;
}

/** A different live panel already showing this thread (same-thread views are forbidden). */
function findLivePanelForThread(threadId: string, exceptPanelId?: string): PanelContext | undefined {
  return [...livePanels.values()].find(
    (panelContext) => panelContext.threadId === threadId && panelContext.panelId !== exceptPanelId,
  );
}

/**
 * Post the effective model/effort header state for a panel: user pins first,
 * then the backend-reported thread values, then the honest backend default
 * (nulls — the header renders "default", never "unknown"). Display names
 * come from the last model/list fetch; raw ids are shown until one exists.
 */
function postModelState(panelContext: PanelContext): void {
  if (manager === null) {
    return;
  }
  const threadId = panelContext.threadId;
  const record = threadId !== null ? manager.threads.getThread(threadId) : undefined;
  const pins = threadId !== null ? manager.threads.effectiveOverride(threadId) : manager.threads.lastChosenOverride();
  const model = pins.model ?? record?.model ?? null;
  const effort = pins.effort ?? record?.effort ?? null;
  const displayName = model !== null ? displayLabelFor(modelCatalog, model) : null;
  void panelContext.panel.webview.postMessage({ type: "ext/model", model, effort, displayName });
}

/** Re-apply persisted pins after a reload (serializer restore path). */
function restoreThreadPins(threadId: string): void {
  if (extensionContext === null || manager === null) {
    return;
  }
  const stored = extensionContext.workspaceState.get<PersistedPanelBinding[]>(STORAGE_KEY) ?? [];
  const binding = stored.find((entry) => entry.threadId === threadId);
  if (binding === undefined) {
    return;
  }
  const patch: { model?: string; effort?: string } = {};
  if (typeof binding.model === "string" && binding.model.length > 0) {
    patch.model = binding.model;
  }
  if (typeof binding.effort === "string" && binding.effort.length > 0) {
    patch.effort = binding.effort;
  }
  if (patch.model !== undefined || patch.effort !== undefined) {
    manager.threads.setThreadOverride(threadId, patch);
  }
}

/** Host-side model picker: QuickPick over model/list, no webview messages. */
async function selectModel(): Promise<void> {
  if (manager === null) {
    return;
  }
  const panelContext = activePanel();
  if (panelContext === undefined) {
    void vscode.window.showErrorMessage("Codex Workbench: focus a chat tab first, then pick a model.");
    return;
  }
  if (!(await ensureConnected(false)) || manager === null) {
    return;
  }
  let entries: ModelEntry[];
  try {
    entries = parseModelList(await manager.listModels());
  } catch (error) {
    void vscode.window.showErrorMessage(`Codex Workbench: model/list failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (entries.length === 0) {
    void vscode.window.showErrorMessage("Codex Workbench: model/list returned no models.");
    return;
  }
  modelCatalog = entries;
  const visible = visibleModels(entries);
  if (visible.length === 0) {
    void vscode.window.showErrorMessage("Codex Workbench: every catalog model is hidden; nothing to pick.");
    return;
  }
  const threadId = panelContext.threadId;
  const effective = threadId !== null ? manager.threads.effectiveOverride(threadId) : manager.threads.lastChosenOverride();
  const record = threadId !== null ? manager.threads.getThread(threadId) : undefined;
  const currentId = effective.model ?? record?.model ?? defaultModel(entries)?.id ?? null;
  const items = visible.map((entry) => ({
    label: `${entry.displayName}${entry.id === currentId ? " (current)" : ""}${entry.isDefault ? " (default)" : ""}`,
    detail: entry.description,
    id: entry.id,
  }));
  const picked = await vscode.window.showQuickPick(items, { placeHolder: "Select model for this thread (applies to this turn and subsequent turns)" });
  if (picked === undefined) {
    return;
  }
  // Unreachable via the picker itself (ids come from the list), but a
  // defense-in-depth check: never pin an id the backend did not advertise.
  const check = validateModelChoice(entries, picked.id);
  if (!check.ok) {
    void vscode.window.showErrorMessage(`Codex Workbench: ${check.error}`);
    return;
  }
  if (threadId !== null) {
    manager.threads.setThreadOverride(threadId, { model: check.entry.id });
  } else {
    manager.threads.rememberChoice({ model: check.entry.id });
  }
  log(`model selected: ${check.entry.id} thread=${threadId ?? "(none yet)"}`);
  postModelState(panelContext);
  persistBindings();
}

/** Host-side effort picker: per-model catalog options, static fallback otherwise. */
async function selectEffort(): Promise<void> {
  if (manager === null) {
    return;
  }
  const panelContext = activePanel();
  if (panelContext === undefined) {
    void vscode.window.showErrorMessage("Codex Workbench: focus a chat tab first, then pick a reasoning effort.");
    return;
  }
  if (!(await ensureConnected(false)) || manager === null) {
    return;
  }
  let entries: ModelEntry[] = [];
  try {
    entries = parseModelList(await manager.listModels());
    modelCatalog = entries;
  } catch (error) {
    // A failed list lacks every model, so the static fallback applies;
    // the effort pin is still valid on the wire. Logged, not hidden.
    log(`model/list failed during effort pick, using static fallback: ${error instanceof Error ? error.message : String(error)}`);
  }
  const threadId = panelContext.threadId;
  const effective = threadId !== null ? manager.threads.effectiveOverride(threadId) : manager.threads.lastChosenOverride();
  const record = threadId !== null ? manager.threads.getThread(threadId) : undefined;
  const currentModelId = effective.model ?? record?.model ?? defaultModel(entries)?.id ?? null;
  const currentModel = currentModelId !== null ? findModel(entries, currentModelId) : undefined;
  if (currentModel !== undefined && currentModel.efforts.length === 0) {
    void vscode.window.showErrorMessage(`Codex Workbench: model "${currentModelId}" advertises no reasoning effort options.`);
    return;
  }
  const { options, fromFallback } = effortOptionsFor(entries, currentModelId);
  const currentEffort = effective.effort ?? record?.effort ?? null;
  const modelDefault = currentModel?.defaultEffort ?? null;
  const modelLabel = currentModelId !== null ? (displayLabelFor(entries, currentModelId) ?? currentModelId) : "default model";
  const items = options.map((option) => ({
    label: `${option.effort}${option.effort === currentEffort ? " (current)" : ""}${option.effort === modelDefault ? " (model default)" : ""}`,
    detail: option.description,
    id: option.effort,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: fromFallback
      ? `Select reasoning effort (catalog unavailable — static fallback, thread model unknown)`
      : `Select reasoning effort for ${modelLabel}`,
  });
  if (picked === undefined) {
    return;
  }
  if (threadId !== null) {
    manager.threads.setThreadOverride(threadId, { effort: picked.id });
  } else {
    manager.threads.rememberChoice({ effort: picked.id });
  }
  log(`effort selected: ${picked.id} thread=${threadId ?? "(none yet)"}${fromFallback ? " (static fallback)" : ""}`);
  postModelState(panelContext);
  persistBindings();
}

async function attachSelection(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const panelContext = activePanel();
  if (editor === undefined || panelContext === null || panelContext === undefined) {
    return;
  }
  const selection = editor.selection;
  const reference = referenceFromEditorContext(
    {
      uri: editor.document.uri.toString(),
      scheme: editor.document.uri.scheme,
      fileName: editor.document.fileName.split(/[\\/]/).pop() ?? editor.document.fileName,
      languageId: editor.document.languageId,
      selection: selection.isEmpty
        ? undefined
        : { startLine: selection.start.line + 1, endLine: selection.end.line + 1, text: editor.document.getText(selection) },
    },
    !selection.isEmpty,
  );
  const mention = renderReferenceAsMention(reference);
  panelContext.mentions.push(mention);
  void panelContext.panel.webview.postMessage({ type: "ext/mentions", mentions: panelContext.mentions });
}

async function restorePanel(restored: vscode.WebviewPanel, state: { panelId: string; threadId: string } | undefined): Promise<void> {
  if (panels === null) {
    return;
  }
  try {
    if (state === undefined) {
      return;
    }
    // Serialized state may come from an older build: validate before trusting.
    const panelId = typeof state.panelId === "string" && state.panelId !== "" ? state.panelId : newPanelId();
    const threadId = typeof state.threadId === "string" && state.threadId !== "" ? state.threadId : null;
    const panelContext: PanelContext = { panel: restored, panelId, threadId, activeTurnId: null, mentions: [], unsubscribe: null };
    livePanels.set(panelId, panelContext);
    restored.webview.html = renderHtml(restored.webview, panelId, panelContext.threadId, "");
    wirePanel(panelContext);
    trackPanelFocus(restored, panelId);
    restored.onDidDispose(() => {
      manager?.panelDisposed(panelId, panelContext.threadId);
      panelContext.unsubscribe?.();
      livePanels.delete(panelId);
      persistBindings();
    });
    if (await ensureConnected(true) && manager !== null && panelContext.threadId !== null) {
      try {
        restoreThreadPins(panelContext.threadId);
        await manager.resumeThread(panelContext.threadId);
        subscribePanel(panelContext);
        await hydratePanel(panelContext);
        postModelState(panelContext);
      } catch (error) {
        void restored.webview.postMessage({ type: "ext/error", message: `restore failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
  } catch (error) {
    // A failed restore must never leave a dead webview: surface the error in
    // the output channel so the user can close this tab and open a new chat.
    log(`panel restore failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function wirePanel(panelContext: PanelContext): void {
  panelContext.panel.webview.onDidReceiveMessage((raw: unknown) => {
    const message = validateWebviewMessage(raw);
    if (message === null) {
      log("dropped malformed webview message");
      return;
    }
    void handleWebviewMessage(panelContext, message.type, (message as { payload?: unknown }).payload);
  });
}

async function handleWebviewMessage(panelContext: PanelContext, type: string, payload: unknown): Promise<void> {
  if (manager === null) {
    return;
  }
  const record = (payload ?? {}) as Record<string, unknown>;
  switch (type) {
    case "webview/ready":
      void panelContext.panel.webview.postMessage({ type: "ext/mentions", mentions: panelContext.mentions });
      // The webview is recreated whenever a hidden tab is reshown
      // (retainContextWhenHidden: false), so re-send header state here.
      // Connection state especially: the ready broadcast fired while this
      // webview was still loading and was lost.
      if (manager !== null) {
        const snapshot = manager.connectionSnapshot();
        void panelContext.panel.webview.postMessage({ type: "ext/connection", state: snapshot.state, detail: snapshot.detail });
      }
      postModelState(panelContext);
      // A recreated webview starts blank while the host binding survives:
      // re-attach the live thread and backfill history, or the tab looks
      // "reset" after every hide/show cycle.
      if (manager !== null && panelContext.threadId !== null) {
        subscribePanel(panelContext);
        await hydratePanel(panelContext);
      }
      break;
    case "composer/send": {
      if (panelContext.threadId === null) {
        return;
      }
      const text = String(record["text"] ?? "");
      const mentions = Array.isArray(record["mentions"]) ? (record["mentions"] as string[]) : [];
      const fullText = mentions.length > 0 ? `${mentions.join(" ")}\n${text}` : text;
      void panelContext.panel.webview.postMessage({ type: "ext/item", turnId: "local", itemId: `local-${Date.now()}`, kind: "userMessage", text: fullText });
      try {
        // Apply this thread's stored model/effort pins (inherited defaults
        // included). Absent pins are omitted from the params — never null —
        // so the backend thread default applies untouched.
        const overrides = manager.threads.overrideParams(panelContext.threadId);
        const response = (await manager.startTurn(panelContext.threadId, fullText, { ...overrides })) as Record<string, unknown>;
        const turn = (response["turn"] ?? {}) as Record<string, unknown>;
        panelContext.activeTurnId = typeof turn["id"] === "string" ? (turn["id"] as string) : null;
      } catch (error) {
        void panelContext.panel.webview.postMessage({ type: "ext/error", message: `turn/start failed: ${error instanceof Error ? error.message : String(error)}` });
      }
      panelContext.mentions = [];
      void panelContext.panel.webview.postMessage({ type: "ext/mentions", mentions: [] });
      break;
    }
    case "composer/cancel": {
      if (panelContext.threadId !== null && panelContext.activeTurnId !== null) {
        try {
          await manager.interruptTurn(panelContext.threadId, panelContext.activeTurnId);
        } catch (error) {
          void panelContext.panel.webview.postMessage({ type: "ext/error", message: `interrupt failed: ${error instanceof Error ? error.message : String(error)}` });
        }
      }
      break;
    }
    case "composer/saveDraft":
      manager.threads.saveDraft(panelContext.panelId, String(record["text"] ?? ""));
      persistBindings();
      break;
    case "approval/decide": {
      const requestId = record["requestId"] as string | number;
      const ok = manager.decideApproval(requestId, { approved: record["approved"] === true, result: record["result"] });
      if (!ok) {
        void panelContext.panel.webview.postMessage({ type: "ext/error", message: "approval already settled; duplicate decision ignored" });
      }
      break;
    }
    case "approval/answer": {
      // Per-question user-input answer. Shape was checked by
      // validateWebviewMessage; re-check here (defense in depth) and forward
      // through the existing decide channel — no new backend/session path.
      // Only metadata is logged: answers may contain secrets.
      const requestId = record["requestId"] as string | number;
      const answers = validateUserInputAnswers(record["answers"]);
      if (answers === null) {
        log(`dropped malformed approval/answer for request=${String(requestId)}`);
        void panelContext.panel.webview.postMessage({ type: "ext/error", message: "answer was malformed and ignored; the prompt stays open" });
        break;
      }
      const ok = manager.decideApproval(requestId, { approved: true, result: { answers } });
      if (!ok) {
        void panelContext.panel.webview.postMessage({ type: "ext/error", message: "approval already settled; duplicate decision ignored" });
      } else {
        log(`approval answered: request=${String(requestId)} questions=${Object.keys(answers).length}`);
      }
      break;
    }
    case "session/pick": {
      const threadId = String(record["threadId"] ?? "");
      const elsewhere = findLivePanelForThread(threadId, panelContext.panelId);
      if (elsewhere !== undefined) {
        void panelContext.panel.webview.postMessage({ type: "ext/error", message: "that thread is already open in another tab" });
        break;
      }
      try {
        await manager.resumeThread(threadId);
        panelContext.threadId = threadId;
        subscribePanel(panelContext);
        await hydratePanel(panelContext);
      } catch (error) {
        void panelContext.panel.webview.postMessage({ type: "ext/error", message: `thread/resume failed: ${error instanceof Error ? error.message : String(error)}` });
      }
      break;
    }
    case "session/rename":
      panelContext.panel.title = String(record["name"] ?? panelContext.panel.title);
      persistBindings();
      break;
    case "file/openDiff": {
      const candidate = diffCandidateFor(workspaceKey(), { path: String(record["uri"] ?? "") });
      if (candidate !== null) {
        // TODO(M4): open a real before/after pair once tool events carry one.
        // Today only a single URI is available, so opening vscode.diff would
        // show an empty diff — fail closed with an honest error instead.
        void panelContext.panel.webview.postMessage({ type: "ext/error", message: `diff unavailable for ${candidate.title}: no before/after pair yet` });
      }
      break;
    }
    default:
      break;
  }
}

function routeToPanel(panelContext: PanelContext, method: string, params: unknown): void {
  const record = (params ?? {}) as Record<string, unknown>;
  switch (method) {
    case "item/agentMessage/delta": {
      void panelContext.panel.webview.postMessage({
        type: "ext/delta",
        turnId: record["turnId"],
        itemId: record["itemId"],
        kind: "agentMessage",
        delta: record["delta"],
      });
      break;
    }
    case "thread/started": {
      // Lifecycle bookkeeping only; the thread is already known from the
      // thread/start response. Never a timeline card. Params carry a nested
      // thread object ({ thread: { id, ... } }), not a top-level threadId.
      const nested = (record["thread"] ?? {}) as Record<string, unknown>;
      log(`thread/started: ${typeof nested["id"] === "string" ? (nested["id"] as string) : "unknown"}`);
      break;
    }
    case "mcpServer/startupStatus/updated": {
      // One compact status segment per server (rendered in the header line),
      // not one timeline card per update. Full detail goes to the log.
      const server = typeof record["name"] === "string" ? (record["name"] as string) : "unknown";
      const status = typeof record["status"] === "string" ? (record["status"] as string) : "unknown";
      const detail = typeof record["error"] === "string" && (record["error"] as string).length > 0
        ? `: ${(record["error"] as string).slice(0, 300)}`
        : "";
      log(`mcp startup: ${server} -> ${status}${detail}`);
      void panelContext.panel.webview.postMessage({ type: "ext/mcpStatus", server, status, hasError: detail !== "" });
      break;
    }
    case "turn/started": {
      const turn = (record["turn"] ?? {}) as Record<string, unknown>;
      panelContext.activeTurnId = typeof turn["id"] === "string" ? (turn["id"] as string) : null;
      void panelContext.panel.webview.postMessage({ type: "ext/turnStatus", turnId: panelContext.activeTurnId, status: "inProgress" });
      break;
    }
    case "turn/completed": {
      const turn = (record["turn"] ?? {}) as Record<string, unknown>;
      panelContext.activeTurnId = null;
      void panelContext.panel.webview.postMessage({ type: "ext/turnStatus", turnId: typeof turn["id"] === "string" ? turn["id"] : null, status: typeof turn["status"] === "string" ? turn["status"] : "completed" });
      break;
    }
    case "item/started":
    case "item/completed": {
      const turnId = typeof record["turnId"] === "string" ? (record["turnId"] as string) : "";
      const view = normalizeThreadItem(record["item"], turnId);
      if (view === null) {
        const raw = (record["item"] ?? {}) as Record<string, unknown>;
        log(`dropped unrenderable item: ${method} type=${String(raw["type"] ?? "unknown")} id=${String(raw["id"] ?? "unknown")}`);
        break;
      }
      void panelContext.panel.webview.postMessage({
        type: "ext/item",
        turnId: view.turnId,
        itemId: view.id,
        kind: view.kind,
        text: view.detail !== undefined ? `${view.text}\n${view.detail}` : view.text,
      });
      break;
    }
    case "hydrated/item": {
      const turnId = typeof record["turnId"] === "string" ? (record["turnId"] as string) : "";
      const view = normalizeThreadItem(record["item"], turnId);
      if (view === null) {
        const raw = (record["item"] ?? {}) as Record<string, unknown>;
        log(`dropped unrenderable item: hydrated/item type=${String(raw["type"] ?? "unknown")} id=${String(raw["id"] ?? "unknown")}`);
        break;
      }
      void panelContext.panel.webview.postMessage({ type: "ext/item", turnId: view.turnId, itemId: view.id, kind: view.kind, text: view.detail !== undefined ? `${view.text}\n${view.detail}` : view.text });
      break;
    }
    default: {
      // Unknown/background notifications stay out of the timeline; the method
      // name and a bounded params preview go to the output channel instead.
      // Rendering every new lifecycle method as a card flooded the view.
      let preview = "";
      try {
        preview = JSON.stringify(record ?? null) ?? "";
      } catch {
        preview = "";
      }
      log(`unrendered notification: ${method}${preview.length > 0 ? ` ${preview.slice(0, 300)}` : ""}`);
      break;
    }
  }
}

function persistBindings(): void {
  if (extensionContext === null || manager === null) {
    return;
  }
  const bindings = [...livePanels.values()]
    .filter((panelContext) => panelContext.threadId !== null)
    .map((panelContext) => {
      const existing = manager?.threads.bindingForPanel(panelContext.panelId);
      // Persist pins alongside the draft so a reload restores them
      // (restoreThreadPins). overrideParams omits unset keys, so untouched
      // threads persist no model/effort and keep the backend default.
      const pins = panelContext.threadId !== null ? (manager?.threads.overrideParams(panelContext.threadId) ?? {}) : {};
      return {
        panelId: panelContext.panelId,
        threadId: panelContext.threadId as string,
        displayName: panelContext.panel.title,
        workspaceKey: workspaceKey(),
        draft: existing?.draft ?? "",
        ...pins,
      };
    });
  void extensionContext.workspaceState.update(STORAGE_KEY, bindings);
}

function renderHtml(webview: vscode.Webview, panelId: string, threadId: string | null, draft: string): string {
  if (extensionContext === null) {
    return "";
  }
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionContext.extensionUri, "media", "main.js"));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionContext.extensionUri, "media", "main.css"));
  const nonce = randomBytes(18).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 24);
  const initial = JSON.stringify({ panelId, threadId, draft }).replace(/</g, "\\u003c");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<link rel="stylesheet" href="${styleUri}"></head>`
    + `<body><div id="wb-status"></div><div id="wb-convo"></div><div id="wb-composer"></div>`
    + `<script nonce="${nonce}">window.__wbInitial = ${initial};</script>`
    + `<script type="module" nonce="${nonce}" src="${scriptUri}"></script></body></html>`;
}
