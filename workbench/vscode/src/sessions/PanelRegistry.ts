/**
 * WebviewPanel bookkeeping. Each Codex chat is an ordinary editor tab
 * (ViewColumn-aware, movable, splittable). No nested custom tabs, no
 * terminal, no sidebar requirement.
 *
 * `PanelLike` keeps panel lifecycle testable without the vscode API; the
 * production implementation wraps `vscode.WebviewPanel`.
 */

export interface WebviewMessageSender {
  postMessage(message: unknown): Promise<boolean> | boolean | void;
}

export interface PanelLike {
  readonly panelId: string;
  reveal(column?: number): void;
  postMessage(message: unknown): void;
  dispose(): void;
  onDidDispose(listener: () => void): void;
  setTitle(title: string): void;
}

export class PanelRegistry {
  private readonly panels = new Map<string, PanelLike>();

  register(panel: PanelLike): void {
    this.panels.set(panel.panelId, panel);
    panel.onDidDispose(() => {
      this.panels.delete(panel.panelId);
    });
  }

  get(panelId: string): PanelLike | undefined {
    return this.panels.get(panelId);
  }

  count(): number {
    return this.panels.size;
  }

  disposeAll(): void {
    for (const panel of [...this.panels.values()]) {
      panel.dispose();
    }
    this.panels.clear();
  }
}
