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

/** Membership guards — the single source of truth for tier validation, so the
 * rule can only change in one place (mirrors isValidPriority/isValidWeight). */
export function isSourceEffortTier(v: unknown): v is SourceEffortTier {
  return typeof v === "string" && (SOURCE_EFFORT_TIERS as readonly string[]).includes(v);
}
export function isCodexEffort(v: unknown): v is CodexEffort {
  return typeof v === "string" && (CODEX_EFFORTS as readonly string[]).includes(v);
}

/** Claude Code's own window constants, mirrored so the pool can reason about
 * what the client will do with a given model id. 200K is its default budget for
 * a recognized Claude model, 1M is what the `[1m]` id suffix unlocks, and 100K
 * is the floor it accepts for CLAUDE_CODE_AUTO_COMPACT_WINDOW. */
export const CLAUDE_DEFAULT_CONTEXT = 200_000;
export const CLAUDE_MAX_CONTEXT = 1_000_000;
export const CLAUDE_MIN_AUTO_COMPACT = 100_000;

export interface ModelRoute {
  id: string;
  provider: Provider;
  upstreamModel: string;
  /** Upstream's default context budget for this model, in tokens. */
  contextWindow?: number;
  /** Upstream's ceiling — the most a client may budget. Codex publishes both
   * (`context_window` / `max_context_window`); the extended window is a purely
   * client-side budget, so we may use the ceiling directly. */
  maxContextWindow?: number;
  /** Attached at request time for mapped routes; never persisted. */
  effortMap?: EffortMap;
}

const claude = (id: string): ModelRoute => ({
  id, provider: "anthropic", upstreamModel: id,
  contextWindow: CLAUDE_DEFAULT_CONTEXT, maxContextWindow: CLAUDE_MAX_CONTEXT,
});
const openai = (id: string, contextWindow: number, maxContextWindow: number): ModelRoute => ({
  id, provider: "openai", upstreamModel: id, contextWindow, maxContextWindow,
});

export const DEFAULT_MODEL_TABLE: ModelRoute[] = [
  claude("opus"), claude("sonnet"), claude("haiku"), claude("fable"),
  claude("claude-opus-5"), claude("claude-opus-4-8"),
  claude("claude-sonnet-5"), claude("claude-haiku-4-5"), claude("claude-fable-5"),
  // GPT-5.6 tiers per codex-rs models-manager/models.json: sol (flagship),
  // terra (mid), luna (fast/cheap); bare "gpt-5.6" is a family alias for sol.
  // All three share one 272K default / 872K ceiling — the extended window is
  // not Sol-only.
  openai("gpt-5.6-sol", 272_000, 872_000),
  openai("gpt-5.6-terra", 272_000, 872_000),
  openai("gpt-5.6-luna", 272_000, 872_000),
  { id: "gpt-5.6", provider: "openai", upstreamModel: "gpt-5.6-sol", contextWindow: 272_000, maxContextWindow: 872_000 },
  openai("gpt-5.5", 272_000, 272_000),
  openai("gpt-5.4", 272_000, 1_000_000),
  openai("gpt-5.4-mini", 272_000, 272_000),
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

/** A window a hand-edited models.json may declare, or undefined when it may
 * not: NaN/negative values never reach the guard, and neither does a ceiling
 * ceilingBelowFloor rejects (load time has no way to return an error, so this
 * is the warn-and-ignore surface of that one rule). Warns naming the id and
 * field so a hand-edited file doesn't fail silently, then lets the bundled
 * backfill supply the real value. */
function declaredWindow(
  v: unknown,
  ctx: {
    modelsFile: string;
    id: string;
    field: "contextWindow" | "maxContextWindow";
    /** The bundled value for THIS field, or undefined when there is none —
     * both the value returned on rejection and what the warning describes, so
     * the message can never promise a fallback that isn't applied. */
    fallback: number | undefined;
  },
): number | undefined {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) return ctx.fallback;
  const why = ceilingBelowFloor(ctx.id, v);
  if (why !== null) {
    const outcome =
      ctx.fallback !== undefined
        ? `falling back to the bundled ${ctx.fallback.toLocaleString("en-US")}`
        : `no bundled default for this id, so it will use ${CLAUDE_DEFAULT_CONTEXT.toLocaleString("en-US")}`;
    console.warn(`${ctx.modelsFile}: ignoring "${ctx.field}" — ${why} (${outcome})`);
    return ctx.fallback;
  }
  return v;
}

const BUNDLED_BY_ID = new Map(DEFAULT_MODEL_TABLE.map((m) => [m.id, m]));

function normalizeModelRoute(m: ModelRoute, modelsFile: string): ModelRoute {
  const out: ModelRoute = { id: m.id, provider: m.provider, upstreamModel: m.upstreamModel };
  // Backfill from the bundled row of the same id. Every save persists the FULL
  // materialized table, so a models.json written before windows existed (any
  // dashboard "Save mapping", or `models update`) shadows every bundled route
  // with a window-less entry — which would silently drop every model to
  // CLAUDE_DEFAULT_CONTEXT and make the Codex guard reject anything over 200K.
  // A value present in the file still wins; this only fills what the file
  // omits, which is exactly handleContextUpdate's "clearing restores the
  // bundled default" rule. Provider must match, or a re-pointed id (e.g. an
  // `opus` row re-provisioned to openai) would inherit the wrong windows.
  const bundled = BUNDLED_BY_ID.get(m.id);
  const fallback = bundled && bundled.provider === m.provider ? bundled : undefined;
  const ctx = declaredWindow(m.contextWindow, {
    modelsFile, id: m.id, field: "contextWindow", fallback: fallback?.contextWindow,
  });
  const max = declaredWindow(m.maxContextWindow, {
    modelsFile, id: m.id, field: "maxContextWindow", fallback: fallback?.maxContextWindow,
  });
  if (ctx !== undefined) out.contextWindow = ctx;
  if (max !== undefined) out.maxContextWindow = max;
  return out;
}

/** Merges on-disk model routes over the bundled defaults (on-disk ids shadow). */
function mergeModelTable(parsed: Record<string, unknown> | null, modelsFile: string): ModelRoute[] {
  const fromFile = Array.isArray(parsed?.models)
    ? parsed!.models.filter(isModelRoute).map((m) => normalizeModelRoute(m, modelsFile))
    : [];
  const ids = new Set(fromFile.map((m) => m.id));
  return [...DEFAULT_MODEL_TABLE.filter((m) => !ids.has(m.id)), ...fromFile];
}

export function loadModelTable(modelsFile: string): ModelRoute[] {
  return mergeModelTable(parseModelsFile(modelsFile), modelsFile);
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

/** A declared window that can safely be used, or null. Anything non-positive or
 * non-finite counts as absent.
 *
 * The single rule for every window this module reads, so the truthiness tests
 * scattered through it can't disagree. It matters most in
 * effectiveContextWindow: `??` alone lets a leaked 0 reach
 * Math.min(0, cap) === 0, and a 0-window route makes the request guard reject
 * EVERY request to that model. Six producers currently guard against that
 * upstream, so no leak is reachable today — but that invariant should not have
 * to hold for the guard to behave. */
export function usableWindow(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

/** The ceiling a route declares, or null when it declares none: the upstream
 * ceiling first, the default budget standing in for it, and a non-positive
 * value treated as absent rather than as a window of zero. This precedence is
 * the rule every reader must agree on — the request guard, the /v1/models
 * listing, the dashboard editor and `models list` all resolve a ceiling
 * through here, so there is exactly one place it can change. */
export function declaredCeiling(route: ModelRoute): number | null {
  return usableWindow(route.maxContextWindow) ?? usableWindow(route.contextWindow);
}

/** The budget a client should actually use for this route: the upstream ceiling
 * held under the pool's house cap. Unwindowed routes (a user-added id, or the
 * unknown-model fall-through) assume Claude Code's 200K default. */
export function effectiveContextWindow(route: ModelRoute, cap: number): number {
  return Math.min(declaredCeiling(route) ?? CLAUDE_DEFAULT_CONTEXT, cap);
}

/** Hold a window inside the range Claude Code will accept. Applied only on the
 * values we hand the client — the raw effective window stays exact so the
 * request guard can reject against the model's real limit. */
export function clampContextWindow(n: number): number {
  return Math.max(CLAUDE_MIN_AUTO_COMPACT, Math.min(CLAUDE_MAX_CONTEXT, Math.round(n)));
}

/** Why a per-model ceiling cannot be honoured, or null when it can.
 *
 * clampContextWindow always raises the derived session window UP to
 * CLAUDE_MIN_AUTO_COMPACT, so a ceiling below that floor would have Claude Code
 * compacting at the floor while this model's own request guard rejects it
 * lower — every request in the gap fails hard instead of compacting. There is
 * deliberately no upper bound: a large ceiling (872000, 1000000) is a
 * legitimate upstream budget, not a number handed straight to the client.
 *
 * Every surface that accepts a ceiling — the dashboard's POST /api/context,
 * `models context`, and a hand-edited models.json — decides only how to report
 * this; none of them restates the rule. */
export function ceilingBelowFloor(id: string, tokens: number): string | null {
  if (tokens >= CLAUDE_MIN_AUTO_COMPACT) return null;
  const floor = CLAUDE_MIN_AUTO_COMPACT.toLocaleString("en-US");
  return (
    `a context ceiling of ${tokens.toLocaleString("en-US")} for "${id}" is below ${floor}: ` +
    `Claude Code will not auto-compact below ${floor}, so the pool would reject ` +
    "requests the client never compacts"
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
  // Derive from the target rather than hand-copying its fields. The mapped
  // route is what reaches proxyCodexMessages → checkContextWindow, and this
  // literal is exactly where 2c64f60 silently dropped the window fields —
  // guarding every mapped request at Claude Code's 200K default instead of the
  // target's real ceiling. Spreading means the next ModelRoute field travels
  // without anyone having to remember this site. The provider guard above
  // already pins target.provider to "openai".
  return { ...target, id: modelId, effortMap: row.effort };
}

/** A positive integer, or null to clear. Anything else is a client error.
 * Rejecting 0 matters: a persisted `0` would fall through the `!cfg.value`
 * truthiness checks in sessionContextWindow/poolEnvBlock and silently mean
 * "derive it" instead of the caller's intended value — a bug already hit
 * twice in this codebase (see MEMORY.md). */
export function parseWindow(v: unknown): { ok: true; value: number | null } | { ok: false } {
  if (v === null) return { ok: true, value: null };
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return { ok: true, value: v };
  return { ok: false };
}

export type ContextEditResult =
  | { ok: true; config: ModelConfig }
  | { ok: false; status: number; message: string };

/**
 * The one validated path for every context mutation, whatever the surface.
 *
 * Pure: it never touches the config it is given and never writes a file, so a
 * caller decides for itself what committing means — the server swaps it into
 * the live MappingState and persists, the CLI persists it. Both therefore
 * enforce identical rules and identical clear-semantics, which they did not
 * when each restated the validation itself.
 *
 * All-or-nothing by construction: every field is validated before a single
 * value is applied, so a rejected edit anywhere in the payload can never leave
 * a half-applied table behind.
 */
export function applyContextEdits(
  cfg: ModelConfig,
  body: unknown,
  envOverride: number | null,
): ContextEditResult {
  const fail = (status: number, message: string): ContextEditResult => ({ ok: false, status, message });
  if (body == null || typeof body !== "object") return fail(400, "Invalid body");
  const b = body as Record<string, unknown>;

  // ---- validate everything first ----
  let nextModels: ModelRoute[] | null = null;
  if (b.models !== undefined) {
    if (!Array.isArray(b.models)) return fail(400, '"models" must be an array');
    const edits = new Map<string, number | null>();
    const known = new Set(cfg.models.map((m) => m.id));
    for (const raw of b.models) {
      if (raw == null || typeof raw !== "object") return fail(400, "Invalid model entry");
      const { id, maxContextWindow } = raw as Record<string, unknown>;
      if (typeof id !== "string" || !known.has(id)) {
        return fail(400, `Unknown model id: ${String(id)}`);
      }
      const parsed = parseWindow(maxContextWindow);
      if (!parsed.ok) return fail(400, `maxContextWindow for "${id}" must be a positive integer or null`);
      // Rule and rationale live in ceilingBelowFloor; this decides only that an
      // unhonourable ceiling is a client error. null still means "clear".
      const tooLow = parsed.value === null ? null : ceilingBelowFloor(id, parsed.value);
      if (tooLow !== null) return fail(400, tooLow);
      edits.set(id, parsed.value);
    }
    nextModels = cfg.models.map((m) => {
      const value = edits.get(m.id);
      if (value === undefined) return m;
      // Clearing restores the bundled default (cfg.models is already the merged,
      // materialized table — every id gets persisted in full on every save — so
      // just dropping the field would persist "no ceiling" for a bundled model
      // instead of reverting to its bundled maxContextWindow). A user-added id
      // with no bundled entry has nothing to revert to, so the field is dropped.
      if (value === null) {
        const bundled = BUNDLED_BY_ID.get(m.id)?.maxContextWindow;
        if (bundled !== undefined) return { ...m, maxContextWindow: bundled };
        const { maxContextWindow: _drop, ...rest } = m;
        return rest as ModelRoute;
      }
      return { ...m, maxContextWindow: value };
    });
  }

  let nextWindow: number | null | undefined;
  if (b.autoCompactWindow !== undefined) {
    // Deliberately all-or-nothing: rejecting here must not let a `models[]`
    // edit in the SAME payload commit anyway. A caller holding an env-locked
    // window should retry with just the model edits, in a separate request.
    if (envOverride !== null) {
      return fail(409, "POOL_AUTO_COMPACT_WINDOW is set; unset it to edit the window here");
    }
    const parsed = parseWindow(b.autoCompactWindow);
    if (!parsed.ok) return fail(400, "autoCompactWindow must be a positive integer or null");
    // Claude Code only honours CLAUDE_CODE_AUTO_COMPACT_WINDOW inside
    // [100000, 1000000] (clampContextWindow enforces this silently on the
    // serving path); reject out-of-range here so no surface ever shows a saved
    // value the client doesn't actually use. Per-model maxContextWindow is a
    // different quantity (an upstream ceiling) and is NOT bound by this range.
    if (parsed.value !== null && (parsed.value < CLAUDE_MIN_AUTO_COMPACT || parsed.value > CLAUDE_MAX_CONTEXT)) {
      return fail(
        400,
        `autoCompactWindow must be between ${CLAUDE_MIN_AUTO_COMPACT} and ${CLAUDE_MAX_CONTEXT} ` +
          "(the range Claude Code will honour for CLAUDE_CODE_AUTO_COMPACT_WINDOW), or null",
      );
    }
    nextWindow = parsed.value;
  }

  // ---- commit into a copy ----
  return {
    ok: true,
    config: {
      ...cfg,
      models: nextModels ?? cfg.models,
      autoCompactWindow: nextWindow !== undefined ? nextWindow : cfg.autoCompactWindow,
    },
  };
}

/** One mapped family and the window a client should use for its target. */
export interface MappedWindow {
  family: string;
  target: string;
  window: number;
}

/** Every family currently routed to an openai target, with the window a client
 * should use for it. Empty when mapping is off or every row is inert. */
export function mappedContextWindows(cfg: ModelConfig, cap: number): MappedWindow[] {
  if (!cfg.mappingEnabled) return [];
  const out: MappedWindow[] = [];
  for (const row of cfg.mappings) {
    if (row.to === row.from) continue;
    const target = resolveModel(cfg.models, row.to);
    if (target.provider !== "openai") continue;
    out.push({ family: row.from, target: target.id, window: effectiveContextWindow(target, cap) });
  }
  return out;
}

/**
 * One window that is safe for every model this session can reach, or null to
 * leave Claude Code on its own tuning.
 *
 * Claude Code's auto-compact threshold is per-session, not per-model
 * (CLAUDE_CODE_AUTO_COMPACT_WINDOW), so a session that can reach both a 872K
 * and a 272K target has to compact at 272K. Taking the minimum costs headroom
 * on the roomier target; taking anything larger overflows the smaller one.
 *
 * Both overrides bypass that derivation entirely — they're a deliberate "I know
 * what I'm mapping, use this number" — so they apply even with mapping off.
 * `envOverride` (POOL_AUTO_COMPACT_WINDOW) beats the persisted dashboard value
 * so a bad saved number is always recoverable from the launch environment.
 */
export function sessionContextWindow(
  cfg: ModelConfig,
  cap: number,
  envOverride: number | null = null,
  families?: MappedWindow[],
): number | null {
  const override = usableWindow(envOverride);
  if (override !== null) return clampContextWindow(override);
  const saved = usableWindow(cfg.autoCompactWindow);
  if (saved !== null) return clampContextWindow(saved);
  // Resolved lazily: an override returns above without touching the table.
  const smallest = smallestMappedWindow(families ?? mappedContextWindows(cfg, cap));
  return smallest === null ? null : clampContextWindow(smallest.window);
}

/** The mapped family with the least headroom — the one every other mapped
 * model's session has to fit inside. One definition, so the window we derive
 * and the model the warning names can never be different models. */
export function smallestMappedWindow(families: MappedWindow[]): MappedWindow | null {
  return families.length === 0 ? null : families.reduce((a, b) => (b.window < a.window ? b : a));
}

export interface ContextStatus {
  cap: number;
  sessionWindow: number | null;
  /** Where sessionWindow came from, so the UI can label and gate the field. */
  source: "env" | "settings" | "derived" | "none";
  /** True when POOL_AUTO_COMPACT_WINDOW is set: the dashboard must render the
   * window read-only, since a saved value would be silently outranked. */
  envLocked: boolean;
  families: MappedWindow[];
  /** Set when an EXPLICIT session window (env or saved) is larger than the
   * smallest mapped model can serve — the band between them fails hard instead
   * of compacting. Null when the window is derived, fits, or nothing is
   * mapped. Advisory: the override is deliberate, so we warn rather than
   * refuse. */
  warning: string | null;
  /** Every openai route, for the dashboard's per-model ceiling editor. Claude
   * routes are excluded — their window is fixed by the [1m] pin, not by us. */
  models: { id: string; ceiling: number; window: number; capped: boolean }[];
}

/** The `/api/status` context block. Shared with the CLI, which reads
 * `sessionWindow` to size Claude Code's auto-compact threshold. */
export function buildContextStatus(
  cfg: ModelConfig,
  cap: number,
  envOverride: number | null = null,
): ContextStatus {
  // Walked once here and handed to both readers below — sessionContextWindow
  // would otherwise walk it again for the derived case.
  const families = mappedContextWindows(cfg, cap);
  const sessionWindow = sessionContextWindow(cfg, cap, envOverride, families);
  // One predicate for both, so `source === "env"` and `envLocked` can never
  // disagree about whether the override is in force — they used to test it two
  // different ways (truthiness vs. `!== null`) three lines apart.
  const override = usableWindow(envOverride);
  const source = override !== null
    ? "env"
    : usableWindow(cfg.autoCompactWindow) !== null
      ? "settings"
      : sessionWindow === null
        ? "none"
        : "derived";
  const smallest = smallestMappedWindow(families);
  const warning =
    source !== "derived" && sessionWindow !== null && smallest !== null && sessionWindow > smallest.window
      ? `session window ${sessionWindow.toLocaleString("en-US")} is larger than ` +
        `${smallest.window.toLocaleString("en-US")}, the window of the smallest mapped model ` +
        `(${smallest.target}); requests to it between those sizes are rejected rather than compacted`
      : null;

  return {
    cap,
    sessionWindow,
    source,
    envLocked: override !== null,
    warning,
    families,
    models: cfg.models
      .filter((m) => m.provider === "openai")
      .map((m) => {
        const ceiling = declaredCeiling(m) ?? CLAUDE_DEFAULT_CONTEXT;
        const window = effectiveContextWindow(m, cap);
        return { id: m.id, ceiling, window, capped: ceiling > window };
      }),
  };
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
  /** Dashboard-set session auto-compact window; null means derive it. */
  autoCompactWindow: number | null;
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
  const models = mergeModelTable(parsed, modelsFile);
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
  let autoCompactWindow: number | null = null;
  if (parsed?.autoCompactWindow !== undefined) {
    const raw = parsed.autoCompactWindow;
    if (raw === null) {
      autoCompactWindow = null;
    } else if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) {
      autoCompactWindow = raw;
    } else {
      console.warn(`${modelsFile}: "autoCompactWindow" is not a positive integer; ignoring (window stays derived)`);
    }
  }
  return { models, mappingEnabled, mappings: mergeMappingsOverDefaults(fromFile), autoCompactWindow };
}

export function saveModelConfig(modelsFile: string, cfg: ModelConfig): void {
  writeFileSync(
    modelsFile,
    JSON.stringify(
      {
        models: cfg.models,
        mappingEnabled: cfg.mappingEnabled,
        mappings: cfg.mappings,
        autoCompactWindow: cfg.autoCompactWindow,
      },
      null,
      2,
    ),
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
    if (isSourceEffortTier(k) && isCodexEffort(val)) effort[k] = val;
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
