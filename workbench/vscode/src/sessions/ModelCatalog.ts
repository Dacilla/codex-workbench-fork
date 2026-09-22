/**
 * Host-side model catalog helpers for the model/effort picker commands.
 *
 * Pure functions over the `model/list` response shape
 * (`{ data: Model[] }`; Model has id, displayName, description, hidden,
 * isDefault, supportedReasoningEfforts, defaultReasoningEffort). Tolerant
 * decode: required fields are checked, extras ignored, so a newer backend
 * catalog never breaks the picker. No vscode API — unit-tested directly.
 */

export interface EffortOption {
  effort: string;
  description: string;
}

export interface ModelEntry {
  id: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  efforts: EffortOption[];
  defaultEffort: string | null;
}

/**
 * Static effort fallback, used ONLY when `model/list` lacks the current
 * model (unknown id, empty catalog, or list failure at the call site).
 * Values are the canonical wire strings from
 * `codex-rs/protocol/src/openai_models.rs` (`ReasoningEffort::as_str`);
 * descriptions are deliberately generic — the catalog is the authority
 * whenever it knows the model.
 */
export const FALLBACK_EFFORTS: EffortOption[] = [
  { effort: "low", description: "Lower reasoning effort (fallback; catalog unavailable)" },
  { effort: "medium", description: "Default reasoning effort (fallback; catalog unavailable)" },
  { effort: "high", description: "Higher reasoning effort (fallback; catalog unavailable)" },
  { effort: "xhigh", description: "Extra-high reasoning effort (fallback; catalog unavailable)" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function effortOptionOf(value: unknown): EffortOption | null {
  if (!isRecord(value) || typeof value["reasoningEffort"] !== "string") {
    return null;
  }
  const effort = value["reasoningEffort"] as string;
  if (effort.length === 0) {
    return null;
  }
  const description = typeof value["description"] === "string" ? (value["description"] as string) : "";
  return { effort, description };
}

/** Tolerant decode of a `model/list` result; unparseable entries are dropped. */
export function parseModelList(result: unknown): ModelEntry[] {
  if (!isRecord(result) || !Array.isArray(result["data"])) {
    return [];
  }
  const entries: ModelEntry[] = [];
  for (const raw of result["data"] as unknown[]) {
    if (!isRecord(raw) || typeof raw["id"] !== "string" || (raw["id"] as string).length === 0) {
      continue;
    }
    const efforts: EffortOption[] = [];
    if (Array.isArray(raw["supportedReasoningEfforts"])) {
      for (const option of raw["supportedReasoningEfforts"] as unknown[]) {
        const parsed = effortOptionOf(option);
        if (parsed !== null) {
          efforts.push(parsed);
        }
      }
    }
    entries.push({
      id: raw["id"] as string,
      displayName: typeof raw["displayName"] === "string" && (raw["displayName"] as string).length > 0 ? (raw["displayName"] as string) : (raw["id"] as string),
      description: typeof raw["description"] === "string" ? (raw["description"] as string) : "",
      hidden: raw["hidden"] === true,
      isDefault: raw["isDefault"] === true,
      efforts,
      defaultEffort: typeof raw["defaultReasoningEffort"] === "string" && (raw["defaultReasoningEffort"] as string).length > 0 ? (raw["defaultReasoningEffort"] as string) : null,
    });
  }
  return entries;
}

/** Picker-visible models: hidden catalog entries are never offered. */
export function visibleModels(entries: ModelEntry[]): ModelEntry[] {
  return entries.filter((entry) => !entry.hidden);
}

export function findModel(entries: ModelEntry[], id: string): ModelEntry | undefined {
  return entries.find((entry) => entry.id === id);
}

/** Catalog default: the isDefault entry, else the first visible entry, else null. */
export function defaultModel(entries: ModelEntry[]): ModelEntry | null {
  return entries.find((entry) => entry.isDefault && !entry.hidden) ?? visibleModels(entries)[0] ?? null;
}

export type ModelChoiceValidation = { ok: true; entry: ModelEntry } | { ok: false; error: string };

/**
 * Validate a chosen model id against the catalog. Rejects ids the backend
 * did not advertise — sending an unknown id would fail (or misroute) the
 * turn, so the picker errors honestly instead.
 */
export function validateModelChoice(entries: ModelEntry[], id: string): ModelChoiceValidation {
  const entry = findModel(entries, id);
  if (entry === undefined) {
    return { ok: false, error: `unknown model "${id}": not advertised by model/list` };
  }
  if (entry.hidden) {
    return { ok: false, error: `model "${id}" is hidden in the catalog` };
  }
  return { ok: true, entry };
}

export interface EffortOptions {
  options: EffortOption[];
  /** True when the static fallback was used (catalog lacks the model). */
  fromFallback: boolean;
}

/**
 * Effort options for the current model: the model's own
 * supportedReasoningEfforts with their descriptions, or FALLBACK_EFFORTS
 * when the catalog has no entry for `modelId` (null included).
 */
export function effortOptionsFor(entries: ModelEntry[], modelId: string | null): EffortOptions {
  if (modelId !== null) {
    const entry = findModel(entries, modelId);
    if (entry !== undefined && entry.efforts.length > 0) {
      return { options: entry.efforts, fromFallback: false };
    }
  }
  return { options: FALLBACK_EFFORTS, fromFallback: true };
}

/** Display name for a model id where known, else null (caller shows raw id). */
export function displayLabelFor(entries: ModelEntry[], modelId: string): string | null {
  const entry = findModel(entries, modelId);
  if (entry === undefined || entry.displayName === modelId) {
    return null;
  }
  return entry.displayName;
}
