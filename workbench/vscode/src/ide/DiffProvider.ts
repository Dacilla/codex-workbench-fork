/**
 * Native diff integration. Proposed edits open in VS Code's built-in diff
 * editor (`vscode.diff` command / `Title: diff`) where a legitimate
 * before/after pair exists. This module holds the vscode-free decision
 * logic; extension.ts performs the actual `vscode.diff` call.
 */

export interface DiffCandidate {
  /** Workspace uri of the file, authority intact. */
  uri: string;
  /** Diff title shown in the tab. */
  title: string;
}

export interface FileChangeLike {
  path?: string;
  kind?: string;
}

/**
 * Decide whether a completed file-change item yields a native diff target.
 * Only plain workspace file paths qualify — anything else falls back to an
 * inline preview card in the webview (never a guessed diff).
 */
export function diffCandidateFor(workspaceKey: string, change: FileChangeLike): DiffCandidate | null {
  if (typeof change.path !== "string" || change.path === "") {
    return null;
  }
  // Reject non-file targets (URLs, untitled buffers, data blobs).
  if (/^(https?|data|untitled):/i.test(change.path)) {
    return null;
  }
  const title = change.path.split(/[\\/]/).pop() ?? change.path;
  return {
    uri: workspaceKey !== "" && !change.path.includes("://") ? `${workspaceKey}/${change.path}` : change.path,
    title: `${title} (proposed edit)`,
  };
}
