/** Model-id → provider routing table, persisted at <poolDir>/models.json. */
import { existsSync, readFileSync, writeFileSync } from "fs";
import type { Provider } from "./accounts/types.ts";
import type { AccountManager } from "./accounts/manager.ts";
import { modelFamilyOf } from "./accounts/types.ts";

export const SOURCE_EFFORT_TIERS = ["default", "low", "medium", "high", "xhigh", "max"] as const;
export type SourceEffortTier = (typeof SOURCE_EFFORT_TIERS)[number];

/** Codex Responses API reasoning.effort values (gpt-5.6). "ultra" is a
 * Codex-app-only delegated mode, not an API value — never emitted here. */
export const CODEX_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type CodexEffort = (typeof CODEX_EFFORTS)[number];

export type EffortMap = Partial<Record<SourceEffortTier, CodexEffort>>;

/** Smallest verified Codex input/history ceiling that represents its opt-in
 * 1M total-budget mode. Claude Code has no arbitrary per-model custom-window
 * marker, but it does recognize a trailing `[1m]`. */
export const CODEX_EXTENDED_CONTEXT_MIN = 872_000;

/** Membership guards — the single source of truth for tier validation, so the
 * rule can only change in one place (mirrors isValidPriority/isValidWeight). */
export function isSourceEffortTier(v: unknown): v is SourceEffortTier {
  return typeof v === "string" && (SOURCE_EFFORT_TIERS as readonly string[]).includes(v);
}
export function isCodexEffort(v: unknown): v is CodexEffort {
  return typeof v === "string" && (CODEX_EFFORTS as readonly string[]).includes(v);
}

export interface ModelRoute {
  id: string;
  provider: Provider;
  upstreamModel: string;
  /** Codex's normal active input/history window, in tokens. */
  contextWindow?: number;
  /** Largest input/history window the Codex subscription backend permits. */
  maxContextWindow?: number;
  /** Per-route effort overrides; mapped routes attach this at request time. */
  effortMap?: EffortMap;
}

const CODEX_DEFAULT_CONTEXT_WINDOW = 272_000;
const EXTENDED_CONTEXT_SELECTOR = /\[1m\]$/i;

export function modelSelectorId(route: ModelRoute): string {
  const extended =
    route.provider === "openai" &&
    (route.maxContextWindow ?? 0) >= CODEX_EXTENDED_CONTEXT_MIN;
  return extended && !EXTENDED_CONTEXT_SELECTOR.test(route.id) ? `${route.id}[1m]` : route.id;
}

const claude = (id: string): ModelRoute => ({ id, provider: "anthropic", upstreamModel: id });
const openai = (id: string, maxContextWindow: number, upstreamModel = id): ModelRoute => ({
  id,
  provider: "openai",
  upstreamModel,
  contextWindow: CODEX_DEFAULT_CONTEXT_WINDOW,
  maxContextWindow,
});

export const DEFAULT_MODEL_TABLE: ModelRoute[] = [
  claude("opus"), claude("sonnet"), claude("haiku"), claude("fable"),
  claude("claude-opus-5"), claude("claude-opus-4-8"),
  claude("claude-sonnet-5"), claude("claude-haiku-4-5"),
  claude("claude-fable-5"), claude("claude-fable-5-1"),
  // Authenticated Codex catalog values checked 2026-09-04. GPT-5.6's 872K
  // maximum is its input/history side of the opt-in 1M total budget.
  openai("gpt-5.6-sol", 872_000),
  openai("gpt-5.6-terra", 872_000),
  openai("gpt-5.6-luna", 872_000),
  openai("gpt-5.6", 872_000, "gpt-5.6-sol"),
  openai("gpt-5.5", 272_000),
  openai("gpt-5.4", 1_000_000),
  openai("gpt-5.4-mini", 272_000),
];

/** Bundled full-id duplicates of the family aliases (e.g. `claude-sonnet-5`
 * alongside `sonnet`). Hidden from the GET /v1/models listing so each Claude
 * family shows once — the alias — while the full ids still ROUTE via
 * resolveModel fall-through. Computed from the bundled defaults only, so a
 * user-added id in models.json stays visible unless it reuses one of these
 * exact bundled full-ids. */
const BUNDLED_ALIAS_DUPES: ReadonlySet<string> = new Set(
  DEFAULT_MODEL_TABLE.filter((m) => m.provider === "anthropic" && modelFamilyOf(m.id) !== m.id).map(
    (m) => m.id,
  ),
);

/** The model table as shown by GET /v1/models: one entry per Claude family (the
 * alias), with the bundled full-id duplicates filtered out. Routing is
 * unaffected — it keys off the full table, not this projection. */
export function modelsForListing(table: ModelRoute[]): ModelRoute[] {
  return table.filter((m) => !(m.provider === "anthropic" && BUNDLED_ALIAS_DUPES.has(m.id)));
}

/** Reads and parses <modelsFile> once, or null when absent/unparseable. */
function parseModelsFile(modelsFile: string): Record<string, unknown> | null {
  if (!existsSync(modelsFile)) return null;
  try {
    return JSON.parse(readFileSync(modelsFile, "utf8")) as Record<string, unknown>;
  } catch {
    console.warn(`${modelsFile}: failed to parse; using default model mapping config`);
    return null;
  }
}

function positiveInteger(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
}

function sanitizeEffortMap(value: unknown): EffortMap | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const effort: EffortMap = {};
  for (const [tier, mapped] of Object.entries(value)) {
    if (isSourceEffortTier(tier) && isCodexEffort(mapped)) effort[tier] = mapped;
  }
  return Object.keys(effort).length ? effort : undefined;
}

function normalizeModelRoute(m: ModelRoute): ModelRoute {
  const out: ModelRoute = { id: m.id, provider: m.provider, upstreamModel: m.upstreamModel };
  const contextWindow = positiveInteger(m.contextWindow);
  const maxContextWindow = positiveInteger(m.maxContextWindow);
  const effortMap = sanitizeEffortMap(m.effortMap);
  const contradictoryContext =
    contextWindow !== undefined &&
    maxContextWindow !== undefined &&
    contextWindow > maxContextWindow;
  if (!contradictoryContext && contextWindow !== undefined) out.contextWindow = contextWindow;
  if (!contradictoryContext && maxContextWindow !== undefined) out.maxContextWindow = maxContextWindow;
  if (effortMap !== undefined) out.effortMap = effortMap;
  return out;
}

/** Merges on-disk model routes over the bundled defaults (on-disk ids shadow). */
function mergeModelTable(parsed: Record<string, unknown> | null): ModelRoute[] {
  const fromFile = Array.isArray(parsed?.models)
    ? parsed.models.filter(isModelRoute).map(normalizeModelRoute)
    : [];
  const defaults = new Map(DEFAULT_MODEL_TABLE.map((m) => [m.id, m]));
  const merged = fromFile.map((route) => {
    const bundled = defaults.get(route.id);
    const sameTarget = bundled?.provider === route.provider && bundled.upstreamModel === route.upstreamModel;
    return sameTarget ? { ...bundled, ...route } : route;
  });
  const ids = new Set(merged.map((m) => m.id));
  return [...DEFAULT_MODEL_TABLE.filter((m) => !ids.has(m.id)), ...merged];
}

export function loadModelTable(modelsFile: string): ModelRoute[] {
  return mergeModelTable(parseModelsFile(modelsFile));
}

export function saveModelTable(modelsFile: string, models: ModelRoute[]): void {
  writeFileSync(modelsFile, JSON.stringify({ models }, null, 2));
}

export function resolveModel(table: ModelRoute[], modelId: string): ModelRoute {
  const exact = table.find((m) => m.id === modelId);
  if (exact) return exact;
  const bareId = modelId.replace(EXTENDED_CONTEXT_SELECTOR, "");
  const marked = bareId === modelId ? undefined : table.find((m) => m.id === bareId);
  if (marked) return { ...marked, id: modelId };
  return { id: modelId, provider: "anthropic", upstreamModel: modelId };
}

/** Mapped openai route for a Claude-family request, or null when mapping is
 * disabled, the model has no family, the row is missing/inert, or the target
 * doesn't resolve to an openai route. */
export function mappingFor(cfg: ModelConfig, modelId: string): ModelRoute | null {
  if (!cfg.mappingEnabled) return null;
  const family = modelFamilyOf(modelId);
  if (!family) return null;
  const row = cfg.mappings.find((m) => m.from === family);
  if (!row || row.to === row.from) return null;
  const target = resolveModel(cfg.models, row.to);
  if (target.provider !== "openai") return null;
  return { ...target, id: modelId, effortMap: row.effort };
}

/**
 * Keeps configured OpenAI routes unchanged when `models update` runs. ChatGPT's
 * authenticated Codex service now has an internal model catalog, but it is not
 * a stable public API; wiring live synchronization is intentionally separate
 * from the CLI contract and bundled context metadata in this file.
 */
export async function updateOpenAIModels(mgr: AccountManager, table: ModelRoute[]): Promise<ModelRoute[]> {
  const names = mgr.listNames().filter((n) => mgr.providerFor(n) === "openai");
  const account = names.find((n) => mgr.getOpenAICreds(n)?.accessToken);
  if (!account) {
    console.log("No authenticated OpenAI account found — skipping models update.");
    return table;
  }
  console.log(
    "Codex has no documented model-list endpoint; keeping existing openai entries. " +
      "Edit models.json manually to add/remove OpenAI model ids.",
  );
  return table;
}

export interface ModelMapping {
  /** Claude model family this row applies to ("fable" | "opus" | "sonnet" | "haiku"). */
  from: string;
  /** Target model id. A Claude-family target (or to === from) marks the row inert:
   * that family stays Anthropic-only. */
  to: string;
  /** Source tier → Codex effort overrides. Omitted tiers pass through 1:1. */
  effort?: EffortMap;
}

export interface ModelConfig {
  models: ModelRoute[];
  mappingEnabled: boolean;
  mappings: ModelMapping[];
}

export const DEFAULT_MAPPINGS: ModelMapping[] = [
  { from: "fable", to: "gpt-5.6-sol" },
  { from: "opus", to: "gpt-5.6-terra" },
  { from: "sonnet", to: "gpt-5.6-luna" },
  { from: "haiku", to: "gpt-5.4-mini" },
];

/** Overlays `rows` onto `base`: a row replaces the `base` row for the same
 * family, families not in `rows` keep their `base` value. Used both to fill a
 * partial on-disk set from defaults and to apply a partial edit over the live
 * set without disturbing families the edit didn't mention. */
export function mergeMappingsOver(base: ModelMapping[], rows: ModelMapping[]): ModelMapping[] {
  const overridden = new Set(rows.map((m) => m.from));
  return [...base.filter((m) => !overridden.has(m.from)), ...rows];
}

/** Fills any family missing from `rows` with its bundled default, so a partial
 * on-disk set behaves identically in memory and after a restart. */
export function mergeMappingsOverDefaults(rows: ModelMapping[]): ModelMapping[] {
  return mergeMappingsOver(DEFAULT_MAPPINGS, rows);
}

export function loadModelConfig(modelsFile: string): ModelConfig {
  const parsed = parseModelsFile(modelsFile);
  const models = mergeModelTable(parsed);
  let mappingEnabled = false;
  let fromFile: ModelMapping[] = [];
  if (parsed) {
    if (parsed.mappingEnabled !== undefined) {
      if (typeof parsed.mappingEnabled === "boolean") {
        mappingEnabled = parsed.mappingEnabled;
      } else {
        console.warn(`${modelsFile}: "mappingEnabled" is not a boolean; ignoring (mapping stays off)`);
      }
    }
    if (parsed.mappings !== undefined) {
      if (Array.isArray(parsed.mappings)) {
        fromFile = parsed.mappings.filter(isModelMapping).map(sanitizeMapping);
      } else {
        console.warn(`${modelsFile}: "mappings" is not an array; ignoring (using defaults)`);
      }
    }
  }
  return { models, mappingEnabled, mappings: mergeMappingsOverDefaults(fromFile) };
}

export function saveModelConfig(modelsFile: string, cfg: ModelConfig): void {
  writeFileSync(
    modelsFile,
    JSON.stringify({ models: cfg.models, mappingEnabled: cfg.mappingEnabled, mappings: cfg.mappings }, null, 2),
  );
}

export function isModelMapping(v: unknown): v is ModelMapping {
  const o = v as Record<string, unknown>;
  return v != null && typeof o.from === "string" && typeof o.to === "string";
}

/** Drops effort entries whose key/value aren't recognized tiers. */
function sanitizeMapping(m: ModelMapping): ModelMapping {
  const effort = sanitizeEffortMap(m.effort);
  return effort ? { from: m.from, to: m.to, effort } : { from: m.from, to: m.to };
}

function isModelRoute(v: unknown): v is ModelRoute {
  const o = v as Record<string, unknown>;
  return (
    v != null && typeof o.id === "string" && typeof o.upstreamModel === "string" &&
    (o.provider === "anthropic" || o.provider === "openai")
  );
}
