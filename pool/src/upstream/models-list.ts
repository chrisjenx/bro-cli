/**
 * Live model listing for GET /v1/models.
 *
 * Anthropic's GET /v1/models accepts the same Claude Code OAuth token the pool
 * already holds for each account, so the Claude side of the listing is read
 * from upstream instead of a hand-maintained table — a new Claude model shows
 * up without a pool release. Codex rows come from the configured routing table
 * because the authenticated catalog is not a stable public synchronization contract.
 *
 * Failures never surface to the caller: the last good upstream list is reused,
 * and with nothing cached the bundled table's Claude entries stand in.
 */
import { modelSelectorId, type ModelRoute } from "../models.ts";
import { anthropicUrl, asObject, numberProp, oauthHeaders, parseJson, stringProp } from "./shared.ts";

export interface ModelListEntry {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  display_name?: string;
  max_input_tokens?: number;
  /** Pool-private Codex metadata consumed by bro's catalog sync. */
  context_window?: number;
  max_context_window?: number;
}

export const ANTHROPIC_OWNER = "anthropic-claude-max-pool";
export const OPENAI_OWNER = "openai-chatgpt-pool";

/** How long a successful upstream list is served before re-fetching. */
export const MODELS_CACHE_TTL_MS = 10 * 60_000;

export interface LiveModelsDeps {
  /** Anthropic API origin, e.g. https://api.anthropic.com */
  baseUrl: string;
  /** Fresh OAuth access token for any available Claude account, or null when none. */
  token: () => Promise<string | null>;
  userAgent: string;
  timeoutMs: number;
  fetch?: typeof fetch;
  now?: () => number;
}

// One slot: a process serves a single Anthropic base URL. `inflight` collapses
// concurrent cold-cache requests into one upstream call.
let cache: { at: number; models: ModelListEntry[] } | null = null;
let inflight: Promise<ModelListEntry[] | null> | null = null;

/** Test hook. */
export function resetModelsCache(): void {
  cache = null;
  inflight = null;
}

function toEntry(raw: unknown): ModelListEntry | null {
  const m = asObject(raw);
  const id = stringProp(m, "id");
  if (!id) return null;
  const createdAt = stringProp(m, "created_at");
  const created = createdAt ? Math.floor(Date.parse(createdAt) / 1000) : 0;
  const entry: ModelListEntry = {
    id,
    object: "model",
    created: Number.isFinite(created) ? created : 0,
    owned_by: ANTHROPIC_OWNER,
  };
  const displayName = stringProp(m, "display_name");
  if (displayName) entry.display_name = displayName;
  const maxInput = numberProp(m, "max_input_tokens");
  if (maxInput !== undefined) entry.max_input_tokens = maxInput;
  return entry;
}

/**
 * Anthropic's current model list, or null when it can't be fetched and nothing
 * is cached. A stale cache is preferred over null so a transient upstream
 * blip doesn't flip the listing back to the bundled table.
 */
export async function fetchAnthropicModels(deps: LiveModelsDeps): Promise<ModelListEntry[] | null> {
  const now = deps.now ?? Date.now;
  if (cache && now() - cache.at < MODELS_CACHE_TTL_MS) return cache.models;
  inflight ??= fetchLive(deps)
    .then((models) => {
      if (models) cache = { at: now(), models };
      return cache?.models ?? null;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** One upstream round-trip; null on any failure (no token, network, non-2xx, bad body). */
async function fetchLive(deps: LiveModelsDeps): Promise<ModelListEntry[] | null> {
  const token = await deps.token().catch(() => null);
  if (!token) return null;
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(anthropicUrl(deps.baseUrl, "/v1/models?limit=1000"), {
      method: "GET",
      headers: oauthHeaders(token, deps.userAgent),
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const data = parseJson(await res.text().catch(() => ""))?.data;
  if (!Array.isArray(data)) return null;
  const models = data.map(toEntry).filter((m): m is ModelListEntry => m !== null);
  return models.length ? models : null;
}

function tableEntry(route: ModelRoute): ModelListEntry {
  const entry: ModelListEntry = {
    id: modelSelectorId(route),
    object: "model",
    created: 0,
    owned_by: route.provider === "openai" ? OPENAI_OWNER : ANTHROPIC_OWNER,
  };
  if (route.provider === "openai") {
    if (route.contextWindow !== undefined) entry.context_window = route.contextWindow;
    if (route.maxContextWindow !== undefined) entry.max_context_window = route.maxContextWindow;
  }
  return entry;
}

/**
 * The /v1/models payload: live Claude entries first, then the table's Claude
 * entries not already listed (the opus/sonnet/haiku/fable aliases and any
 * user-added routes — they still route), then the table's OpenAI entries.
 * Without a live list the table's Claude entries stand in alone.
 */
export function buildModelListing(live: ModelListEntry[] | null, table: ModelRoute[]): ModelListEntry[] {
  const seen = new Set((live ?? []).map((m) => m.id));
  // Configured OpenAI routes must survive a live-id collision: request routing
  // gives an exact configured route precedence, so discovery must agree.
  const routes = table.filter((route) => route.provider === "openai" || !seen.has(route.id));
  const exactIds = new Set(
    routes.filter((route) => route.id === modelSelectorId(route)).map((route) => route.id),
  );
  const listedIds = new Set<string>();
  const rest: ModelListEntry[] = [];
  // Preserve table order within each provider while keeping Claude rows first.
  for (const provider of ["anthropic", "openai"] as const) {
    for (const route of routes) {
      if (route.provider !== provider) continue;
      const id = modelSelectorId(route);
      if (exactIds.has(id) && route.id !== id) continue;
      if (listedIds.has(id)) continue;
      listedIds.add(id);
      rest.push(tableEntry(route));
    }
  }
  const configuredOpenAIIds = new Set(table.filter((route) => route.provider === "openai").map((route) => route.id));
  return [
    ...(live ?? []).filter((entry) => !listedIds.has(entry.id) && !configuredOpenAIIds.has(entry.id)),
    ...rest,
  ];
}
