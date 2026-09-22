/**
 * Per-thread collaboration-mode helpers for the `thread/settings/update`
 * escape hatch.
 *
 * Verified background (do not re-derive from memory; shapes checked against
 * the pinned sources cited below):
 *
 * - `request_user_input` is registered only for modes where
 *   `allows_request_user_input()` is true (`codex-rs/protocol/src/
 *   config_types.rs`: only `Plan`, plus `Default` behind an operator feature
 *   flag). Our threads run `Default`, so the model truthfully reports the
 *   tool as unavailable.
 * - `thread/start` has NO collaboration slot (generated
 *   `schema/typescript/v2/ThreadStartParams.ts` carries no collaboration
 *   key), so the mode can only be applied AFTER start via
 *   `thread/settings/update`. New-thread inheritance therefore means
 *   start-then-update, not a start param.
 * - Wire shape (`codex-rs/protocol/src/config_types.rs` + generated
 *   `schema/typescript/CollaborationMode.ts`, `Settings.ts`):
 *     `{ threadId, collaborationMode: { mode: "plan" | "default",
 *        settings: { model, reasoning_effort, developer_instructions } } }`
 *   Outer keys are camelCase; `settings` keys are snake_case (the Rust
 *   `Settings` struct has no `rename_all`). `settings.model` is REQUIRED.
 * - Minimal settings: echo the thread's current model, `reasoning_effort`
 *   echoed the same way (or null), `developer_instructions: null` which the
 *   server fills with the built-in instructions for the selected mode
 *   (`turn_processor.rs::normalize_collaboration_mode`; same meaning is
 *   documented on the Rust field).
 * - A `Some(collaboration_mode)` REPLACES the whole mode+settings server
 *   side (`core/src/session/step_settings.rs`: `update.collaboration_mode`
 *   wins outright). Echoing model/effort is therefore load-bearing: sending
 *   `reasoning_effort: null` while the thread has an effort pin would CLEAR
 *   the pin. Resolution order is explicit option → user pin → backend-
 *   reported thread value (see SessionManager.setThreadMode).
 *
 * EXPERIMENTAL GATING (verified in `app-server-protocol/src/protocol/
 * common.rs` + `app-server/src/message_processor.rs`):
 * - The `ThreadSettingsUpdate` *variant* carries
 *   `#[experimental("thread/settings/update")]`, and the macro resolves a
 *   variant-level reason BEFORE inspecting params — so the WHOLE method
 *   requires the `experimentalApi` handshake capability, regardless of which
 *   fields are set. The field-level
 *   `#[experimental("thread/settings/update.collaborationMode")]` is
 *   additionally true but never reached without the method-level opt-in.
 * - The server rejects the call with
 *   `<reason> requires experimentalApi capability` when the session did not
 *   opt in. Our handshake therefore passes `experimentalApi: true`
 *   (extension.ts `doConnect`). Without it the toggle fails with the
 *   backend's honest error — never a faked success.
 * - The in-repo fake does not enforce gating (it answers the method
 *   unconditionally); gating itself is covered by code inspection + the
 *   handshake-flag test, and live acceptance is listed as UNTESTED in the
 *   feature matrix.
 *
 * No vscode API here — pure functions, unit-tested directly.
 */

/** Collaboration modes the toggle offers. Wire values are lowercase. */
export type CollaborationModeKind = "default" | "plan";

export const DEFAULT_COLLABORATION_MODE: CollaborationModeKind = "default";

export interface CollaborationModeOption {
  mode: CollaborationModeKind;
  label: string;
  /** One-line description of what changes (Plan enables the question tool; Default does not). */
  description: string;
}

export const COLLABORATION_MODE_OPTIONS: readonly CollaborationModeOption[] = [
  {
    mode: "default",
    label: "Default",
    description: "Default collaboration — the question tool is unavailable to the model.",
  },
  {
    mode: "plan",
    label: "Plan",
    description: "Plan collaboration — the model can ask questions with the question tool.",
  },
];

export type CollaborationModeValidation =
  | { ok: true; mode: CollaborationModeKind }
  | { ok: false; error: string };

/**
 * Strict validation: only the exact lowercase wire literals are accepted.
 * Anything else ("Plan", "PLAN", "", null, numbers) is rejected so callers
 * fail closed instead of sending a value the backend would misroute.
 */
export function validateCollaborationMode(value: unknown): CollaborationModeValidation {
  if (value !== "default" && value !== "plan") {
    return { ok: false, error: `unknown collaboration mode ${JSON.stringify(value) ?? "unknown"}: expected "default" or "plan"` };
  }
  return { ok: true, mode: value };
}

/**
 * Parse a persisted `mode` string from a panel binding. Returns null for
 * anything that is not an exact mode literal (older builds, hand-edited
 * storage) so restore ignores it instead of applying a bogus mode.
 */
export function parsePersistedMode(value: unknown): CollaborationModeKind | null {
  const check = validateCollaborationMode(value);
  return check.ok ? check.mode : null;
}

/** Exact wire shape of `thread/settings/update` for a mode change. */
export interface ThreadModeUpdateParams {
  threadId: string;
  collaborationMode: {
    mode: CollaborationModeKind;
    settings: {
      model: string;
      reasoning_effort: string | null;
      developer_instructions: string | null;
    };
  };
}

export type ThreadModeValidation =
  | { ok: true; params: ThreadModeUpdateParams }
  | { ok: false; error: string };

/**
 * Build the exact `thread/settings/update` params for a mode change. Fails
 * closed: empty thread ids, unknown modes, and empty models are rejected
 * rather than sent (an empty `settings.model` would fail or misroute
 * server-side; the caller must resolve the thread's current model first).
 */
export function buildThreadModeUpdateParams(
  threadId: string,
  mode: CollaborationModeKind,
  model: string,
  effort: string | null = null,
): ThreadModeValidation {
  if (typeof threadId !== "string" || threadId.length === 0) {
    return { ok: false, error: "cannot set collaboration mode: threadId is empty" };
  }
  const check = validateCollaborationMode(mode);
  if (!check.ok) {
    return { ok: false, error: check.error };
  }
  if (typeof model !== "string" || model.length === 0) {
    return { ok: false, error: `cannot set collaboration mode for thread ${threadId}: no model known (settings.model is required)` };
  }
  if (effort !== null && (typeof effort !== "string" || effort.length === 0)) {
    return { ok: false, error: `cannot set collaboration mode for thread ${threadId}: invalid effort override` };
  }
  return {
    ok: true,
    params: {
      threadId,
      collaborationMode: {
        mode: check.mode,
        settings: {
          model,
          reasoning_effort: effort,
          developer_instructions: null,
        },
      },
    },
  };
}
