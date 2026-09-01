/**
 * Live model listing for GET /v1/models.
 *
 * Anthropic's GET /v1/models accepts the same Claude Code OAuth token the pool
 * already holds for each account, so the Claude side of the listing is read
 * from upstream instead of a hand-maintained table — a new Claude model shows
 * up without a pool release. OpenAI/Codex has no documented list endpoint
 * (see updateOpenAIModels), so those entries still come from the routing table.
 *
 * Failures never surface to the caller: the last good upstream list is reused,
 * and with nothing cached the bundled table's Claude entries stand in.
 */
import type { ModelRoute } from "../models.ts";
import { anthropicUrl, asObject, numberProp, oauthHeaders, parseJson, stringProp } from "./shared.ts";

export interface ModelListEntry {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  display_name?: string;
  max_input_tokens?: number;
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

/**
 * The /v1/models payload: live Claude entries first, then the table's Claude
 * entries not already listed (the opus/sonnet/haiku/fable aliases and any
 * user-added routes — they still route), then the table's OpenAI entries.
 * Without a live list the table's Claude entries stand in alone.
 */
export function buildModelListing(live: ModelListEntry[] | null, table: ModelRoute[]): ModelListEntry[] {
  const seen = new Set((live ?? []).map((m) => m.id));
  const rest = table
    .filter((m) => !seen.has(m.id))
    .map((m) => ({
      id: m.id,
      object: "model" as const,
      created: 0,
      owned_by: m.provider === "openai" ? OPENAI_OWNER : ANTHROPIC_OWNER,
      // Claude rows before OpenAI rows, matching the live-first ordering.
      _k: m.provider === "openai" ? 1 : 0,
    }))
    .sort((x, y) => x._k - y._k)
    .map(({ _k, ...m }) => m);
  return [...(live ?? []), ...rest];
}
