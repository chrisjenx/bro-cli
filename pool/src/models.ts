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

export interface ModelRoute {
  id: string;
  provider: Provider;
  upstreamModel: string;
  /** Attached at request time for mapped routes; never persisted. */
  effortMap?: EffortMap;
}

const claude = (id: string): ModelRoute => ({ id, provider: "anthropic", upstreamModel: id });
const openai = (id: string): ModelRoute => ({ id, provider: "openai", upstreamModel: id });

export const DEFAULT_MODEL_TABLE: ModelRoute[] = [
  claude("opus"), claude("sonnet"), claude("haiku"), claude("fable"),
  claude("claude-opus-4-8"), claude("claude-sonnet-5"), claude("claude-haiku-4-5"), claude("claude-fable-5"),
  // GPT-5.6 tiers per codex-rs models-manager/models.json: sol (flagship),
  // terra (mid), luna (fast/cheap); bare "gpt-5.6" is a family alias for sol.
  openai("gpt-5.6-sol"), openai("gpt-5.6-terra"), openai("gpt-5.6-luna"),
  { id: "gpt-5.6", provider: "openai", upstreamModel: "gpt-5.6-sol" },
  openai("gpt-5.5"), openai("gpt-5.4"), openai("gpt-5.4-mini"),
];

export function loadModelTable(modelsFile: string): ModelRoute[] {
  let fromFile: ModelRoute[] = [];
  if (existsSync(modelsFile)) {
    try {
      const parsed = JSON.parse(readFileSync(modelsFile, "utf8")) as { models?: unknown };
      if (Array.isArray(parsed.models)) {
        fromFile = parsed.models.filter(isModelRoute);
      }
    } catch {
      // fall through to defaults
    }
  }
  const ids = new Set(fromFile.map((m) => m.id));
  return [...DEFAULT_MODEL_TABLE.filter((m) => !ids.has(m.id)), ...fromFile];
}

export function saveModelTable(modelsFile: string, models: ModelRoute[]): void {
  writeFileSync(modelsFile, JSON.stringify({ models }, null, 2));
}

export function resolveModel(table: ModelRoute[], modelId: string): ModelRoute {
  return (
    table.find((m) => m.id === modelId) ??
    { id: modelId, provider: "anthropic", upstreamModel: modelId }
  );
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
  return { id: modelId, provider: "openai", upstreamModel: target.upstreamModel, effortMap: row.effort };
}

/**
 * Refreshes the `openai` entries in `table` from an authenticated OpenAI
 * (ChatGPT-subscription) account, if one exists. There is no documented Codex
 * Responses-API model-listing endpoint in the open-source Codex CLI (verified
 * during Task 1/8 research — codex-rs has no `GET .../models` call in its
 * client), so this currently keeps the existing `openai` entries unchanged and
 * prints a notice; it's structured so a real endpoint can be wired in later
 * without changing the `models update` CLI contract.
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

export function loadModelConfig(modelsFile: string): ModelConfig {
  const models = loadModelTable(modelsFile);
  let mappingEnabled = false;
  let fromFile: ModelMapping[] = [];
  if (existsSync(modelsFile)) {
    try {
      const parsed = JSON.parse(readFileSync(modelsFile, "utf8")) as Record<string, unknown>;
      if (typeof parsed.mappingEnabled === "boolean") mappingEnabled = parsed.mappingEnabled;
      if (Array.isArray(parsed.mappings)) fromFile = parsed.mappings.filter(isModelMapping).map(sanitizeMapping);
    } catch {
      // fall through to defaults (mapping off)
    }
  }
  const families = new Set(fromFile.map((m) => m.from));
  const mappings = [...DEFAULT_MAPPINGS.filter((m) => !families.has(m.from)), ...fromFile];
  return { models, mappingEnabled, mappings };
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
  if (!m.effort || typeof m.effort !== "object") return { from: m.from, to: m.to };
  const effort: EffortMap = {};
  for (const [k, val] of Object.entries(m.effort)) {
    if (
      (SOURCE_EFFORT_TIERS as readonly string[]).includes(k) &&
      typeof val === "string" &&
      (CODEX_EFFORTS as readonly string[]).includes(val)
    ) {
      effort[k as SourceEffortTier] = val as CodexEffort;
    }
  }
  return Object.keys(effort).length ? { from: m.from, to: m.to, effort } : { from: m.from, to: m.to };
}

function isModelRoute(v: unknown): v is ModelRoute {
  const o = v as Record<string, unknown>;
  return (
    v != null && typeof o.id === "string" && typeof o.upstreamModel === "string" &&
    (o.provider === "anthropic" || o.provider === "openai")
  );
}
