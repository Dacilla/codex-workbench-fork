/**
 * Thread bookkeeping. Codex owns the source-of-truth conversation history;
 * this registry keeps only routing metadata plus the minimal state needed to
 * restore panel→thread bindings after reload.
 *
 * Persisted record per panel (NOT the transcript):
 *   { panelId, threadId, displayName, workspaceKey, draft }
 * Closing a tab removes the panel binding. It never deletes the thread.
 */

export interface PersistedPanelBinding {
  panelId: string;
  threadId: string;
  displayName: string;
  /** remote authority + workspace URI, so local threads never resume remote. */
  workspaceKey: string;
  draft?: string;
}

export interface ThreadRecord {
  threadId: string;
  displayName: string;
  workspaceKey: string;
  model: string | null;
  cwd: string | null;
  status: string | null;
  lastTurnId: string | null;
  updatedAtMs: number;
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
