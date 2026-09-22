/**
 * Thread bookkeeping. Codex owns the source-of-truth conversation history;
 * this registry keeps only routing metadata plus the minimal state needed to
 * restore panel→thread bindings after reload.
 *
 * Persisted record per panel (NOT the transcript):
 *   { panelId, threadId, displayName, workspaceKey, draft }
 * Closing a tab removes the panel binding. It never deletes the thread.
 */

import type { CollaborationModeKind } from "./CollaborationMode";
import { DEFAULT_COLLABORATION_MODE } from "./CollaborationMode";

export interface PersistedPanelBinding {
  panelId: string;
  threadId: string;
  displayName: string;
  /** remote authority + workspace URI, so local threads never resume remote. */
  workspaceKey: string;
  draft?: string;
  /**
   * Explicitly chosen model/effort pins, restored into the override map on
   * reload (see restorePanel). Absent = never chosen; the backend default
   * applies. Written by persistBindings alongside the draft.
   */
  model?: string;
  effort?: string;
  /**
   * Explicitly chosen collaboration mode ("default" | "plan"), restored into
   * the mode map on reload. Absent (or any other string) = never chosen;
   * the backend default ("default") applies. Written by persistBindings only
   * when non-default so untouched threads persist no mode key at all.
   */
  mode?: string;
}

export interface ThreadRecord {
  threadId: string;
  displayName: string;
  workspaceKey: string;
  /** Backend-reported thread model (from thread/start|resume), not a user pin. */
  model: string | null;
  /** Backend-reported reasoning effort, when the backend reports one. */
  effort: string | null;
  cwd: string | null;
  status: string | null;
  lastTurnId: string | null;
  updatedAtMs: number;
}

/**
 * Explicit user-chosen model/effort pins. Null = no pin; the backend thread
 * default (or the inherited last-chosen value) applies.
 */
export interface ThreadModelOverride {
  model: string | null;
  effort: string | null;
}

export interface RegistryStorage {
  readBindings(): PersistedPanelBinding[];
  writeBindings(bindings: PersistedPanelBinding[]): void;
}

export class InMemoryStorage implements RegistryStorage {
  private bindings: PersistedPanelBinding[] = [];
  readBindings(): PersistedPanelBinding[] {
    return [...this.bindings];
  }
  writeBindings(bindings: PersistedPanelBinding[]): void {
    this.bindings = [...bindings];
  }
}

let panelCounter = 0;
export function newPanelId(): string {
  panelCounter += 1;
  return `panel-${Date.now().toString(36)}-${panelCounter.toString(36)}`;
}

export class ThreadRegistry {
  private readonly threads = new Map<string, ThreadRecord>();
  private readonly panelToThread = new Map<string, string>();
  private bindings: PersistedPanelBinding[];
  /**
   * Per-thread user pins, keyed by thread id. Separate from ThreadRecord so
   * a pin survives even when no backend record exists yet (e.g. a resumed
   * thread that was never upserted this session).
   */
  private readonly overrides = new Map<string, ThreadModelOverride>();
  /**
   * Last explicitly chosen values, session-scoped. New threads inherit these
   * as picker defaults AND as sent overrides (inherit-and-send; see
   * effectiveOverride). Never populated from backend echoes — only from
   * explicit user selection — so "unset" stays honest.
   */
  private lastChosen: ThreadModelOverride = { model: null, effort: null };
  /**
   * Per-thread confirmed collaboration modes, keyed by thread id. Written
   * only after a successful `thread/settings/update` (SessionManager),
   * after a validated persist restore, or via the failure fallback
   * (pinThreadMode) — never optimistically — so the header stays truthful.
   */
  private readonly modes = new Map<string, CollaborationModeKind>();
  /**
   * Last explicitly chosen mode, session-scoped. New threads inherit it
   * (applied post-start via `thread/settings/update`; `thread/start` has no
   * mode slot). Only explicit user selection changes it — never backend
   * echoes — so "unset" stays the honest backend default.
   */
  private lastMode: CollaborationModeKind = DEFAULT_COLLABORATION_MODE;

  constructor(private readonly storage: RegistryStorage = new InMemoryStorage()) {
    this.bindings = storage.readBindings();
    for (const binding of this.bindings) {
      this.panelToThread.set(binding.panelId, binding.threadId);
    }
  }

  upsertThread(record: ThreadRecord): void {
    this.threads.set(record.threadId, record);
  }

  getThread(threadId: string): ThreadRecord | undefined {
    return this.threads.get(threadId);
  }

  /**
   * Record an explicit user pin for a thread. Merges with the existing pin;
   * only keys present in `patch` change. Explicit non-null values also become
   * the session-scoped last-chosen defaults inherited by new threads.
   * Returns the effective override after the update.
   */
  setThreadOverride(threadId: string, patch: { model?: string | null; effort?: string | null }): ThreadModelOverride {
    const current = this.overrides.get(threadId) ?? { model: null, effort: null };
    const next: ThreadModelOverride = {
      model: patch.model !== undefined ? patch.model : current.model,
      effort: patch.effort !== undefined ? patch.effort : current.effort,
    };
    this.overrides.set(threadId, next);
    this.rememberChoice(patch);
    return this.effectiveOverride(threadId);
  }

  /**
   * Record an explicit choice with no thread attached yet (e.g. picking a
   * model before any thread exists). Becomes the inherited default.
   */
  rememberChoice(patch: { model?: string | null; effort?: string | null }): void {
    if (patch.model !== undefined && patch.model !== null) {
      this.lastChosen.model = patch.model;
    }
    if (patch.effort !== undefined && patch.effort !== null) {
      this.lastChosen.effort = patch.effort;
    }
  }

  /** Session-scoped last explicitly chosen values (a copy). */
  lastChosenOverride(): ThreadModelOverride {
    return { ...this.lastChosen };
  }

  /**
   * The overrides to send for a thread: its own pins, falling back to the
   * last explicitly chosen values (new threads inherit-and-send). Nulls mean
   * "unset" — callers must omit them from the wire params, never send null.
   */
  effectiveOverride(threadId: string): ThreadModelOverride {
    const own = this.overrides.get(threadId);
    return {
      model: own?.model ?? this.lastChosen.model,
      effort: own?.effort ?? this.lastChosen.effort,
    };
  }

  /**
   * Wire/persist-ready form of the effective override: only non-null entries,
   * so spreading this into turn/start params or panel bindings can never
   * emit a null. Returns {} when nothing was ever chosen.
   */
  overrideParams(threadId: string): { model?: string; effort?: string } {
    const effective = this.effectiveOverride(threadId);
    const params: { model?: string; effort?: string } = {};
    if (effective.model !== null) {
      params.model = effective.model;
    }
    if (effective.effort !== null) {
      params.effort = effective.effort;
    }
    return params;
  }

  /**
   * Record an explicit user mode choice for a thread. Also becomes the
   * session-scoped last-chosen default inherited by new threads (mirrors
   * setThreadOverride). Call only after the backend confirmed the update.
   */
  setThreadMode(threadId: string, mode: CollaborationModeKind): CollaborationModeKind {
    this.modes.set(threadId, mode);
    this.lastMode = mode;
    return this.effectiveMode(threadId);
  }

  /**
   * Record a mode for a thread WITHOUT touching the inherited default.
   * Used for (a) the new-thread inheritance fallback when the post-start
   * `thread/settings/update` fails — the thread is honestly "default" while
   * the session default stays whatever the user chose — and (b) internal
   * corrections. Never for explicit user picks (those use setThreadMode).
   */
  pinThreadMode(threadId: string, mode: CollaborationModeKind): CollaborationModeKind {
    this.modes.set(threadId, mode);
    return this.effectiveMode(threadId);
  }

  /**
   * Record an explicit mode choice with no thread attached yet (e.g. picking
   * a mode while the panel has no thread). Becomes the inherited default.
   */
  rememberModeChoice(mode: CollaborationModeKind): void {
    this.lastMode = mode;
  }

  /** Session-scoped last explicitly chosen mode. */
  lastChosenMode(): CollaborationModeKind {
    return this.lastMode;
  }

  /**
   * The confirmed-or-inherited mode for a thread: its own confirmed pin,
   * falling back to the last explicitly chosen value (new threads inherit).
   * "default" when nothing was ever chosen — the honest backend default.
   */
  effectiveMode(threadId: string): CollaborationModeKind {
    return this.modes.get(threadId) ?? this.lastMode;
  }

  bindPanel(panelId: string, threadId: string, displayName: string, workspaceKey: string): void {
    this.panelToThread.set(panelId, threadId);
    this.persistBinding({ panelId, threadId, displayName, workspaceKey });
  }

  /** Close-tab path: drop the binding, keep the thread record. Never calls thread/delete. */
  unbindPanel(panelId: string): string | null {
    const threadId = this.panelToThread.get(panelId) ?? null;
    this.panelToThread.delete(panelId);
    this.bindings = this.bindings.filter((binding) => binding.panelId !== panelId);
    this.storage.writeBindings(this.bindings);
    return threadId;
  }

  threadForPanel(panelId: string): string | null {
    return this.panelToThread.get(panelId) ?? null;
  }

  panelsForThread(threadId: string): string[] {
    const panels: string[] = [];
    for (const [panelId, bound] of this.panelToThread) {
      if (bound === threadId) {
        panels.push(panelId);
      }
    }
    return panels;
  }

  saveDraft(panelId: string, draft: string): void {
    const binding = this.bindings.find((entry) => entry.panelId === panelId);
    if (binding !== undefined) {
      binding.draft = draft;
      this.storage.writeBindings(this.bindings);
    }
  }

  bindingForPanel(panelId: string): PersistedPanelBinding | undefined {
    return this.bindings.find((entry) => entry.panelId === panelId);
  }

  /** Bindings whose workspace matches, for the session picker. */
  bindingsForWorkspace(workspaceKey: string): PersistedPanelBinding[] {
    return this.bindings.filter((binding) => binding.workspaceKey === workspaceKey);
  }

  private persistBinding(binding: PersistedPanelBinding): void {
    this.bindings = this.bindings.filter((entry) => entry.panelId !== binding.panelId);
    this.bindings.push(binding);
    this.storage.writeBindings(this.bindings);
  }
}
