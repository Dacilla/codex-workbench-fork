/**
 * VS Code Uri/selection context for attaching file references to a turn.
 *
 * Rules:
 * - Preserve scheme + authority (untitled, vscode-remote, file). Never infer
 *   a local `C:\` path for remote content.
 * - What is attached is shown explicitly in the composer before sending.
 * - No file contents are read here; the backend reads workspace files itself.
 *   Only references (uri + optional line range + optional selected text
 *   excerpt, bounded) cross into the turn.
 */

export interface FileReference {
  /** Original string form, authority intact (e.g. vscode-remote://ssh-host/...). */
  uri: string;
  scheme: string;
  /** File name for compact display. */
  fileName: string;
  startLine?: number;
  endLine?: number;
  /** Bounded excerpt of the selected text, when the user explicitly attaches a selection. */
  excerpt?: string;
}

export const MAX_EXCERPT_CHARS = 4000;

export interface EditorContext {
  uri: string;
  scheme: string;
  fileName: string;
  languageId: string;
  selection?: { startLine: number; endLine: number; text: string };
}

/** Build a FileReference from active-editor context without touching disk. */
export function referenceFromEditorContext(context: EditorContext, includeSelection: boolean): FileReference {
  const segments = context.uri.split("/");
  const fileName = segments[segments.length - 1] ?? context.uri;
  const reference: FileReference = { uri: context.uri, scheme: context.scheme, fileName };
  if (includeSelection && context.selection !== undefined) {
    reference.startLine = context.selection.startLine;
    reference.endLine = context.selection.endLine;
    const text = context.selection.text;
    reference.excerpt = text.length > MAX_EXCERPT_CHARS ? `${text.slice(0, MAX_EXCERPT_CHARS)}…[truncated]` : text;
  }
  return reference;
}

/** Render a reference as mention text appended to the turn input. */
export function renderReferenceAsMention(reference: FileReference): string {
  const range = reference.startLine !== undefined ? `#L${reference.startLine}${reference.endLine !== undefined && reference.endLine !== reference.startLine ? `-L${reference.endLine}` : ""}` : "";
  return `@${reference.uri}${range}`;
}

/** True when the uri belongs to a remote authority (must never be mapped to a local path). */
export function isRemoteUri(uri: string): boolean {
  return uri.startsWith("vscode-remote://");
}
