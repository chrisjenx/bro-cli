import type { AccountManager } from "../accounts/manager.ts";
import type { Config } from "../config.ts";
import { isCodexEffort, type ModelRoute } from "../models.ts";
import { ensureFreshToken } from "./openai-codex.ts";
import { CODEX_ACCOUNT_ID_HEADER, CODEX_ORIGINATOR } from "./codex-constants.ts";

const CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models?client_version=0.200.0";
const CATALOG_TIMEOUT_MS = 8_000;

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function catalogRoutes(body: unknown): ModelRoute[] {
  if (!body || typeof body !== "object" || !Array.isArray((body as { models?: unknown }).models)) {
    throw new Error("Codex model catalog has an invalid response");
  }
  const routes: ModelRoute[] = [];
  for (const entry of (body as { models: unknown[] }).models) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Codex model catalog has an invalid model entry");
    }
    const model = entry as Record<string, unknown>;
    if (model.visibility !== "list" && model.visibility !== "hide" && model.visibility !== "none") {
      throw new Error("Codex model catalog has invalid visibility");
    }
    if (model.visibility !== "list") continue;
    if (typeof model.slug !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(model.slug)) {
      throw new Error("Codex model catalog has an invalid model slug");
    }
    const route: ModelRoute = { id: model.slug, provider: "openai", upstreamModel: model.slug };
    const contextWindow = positiveInteger(model.context_window);
    const maxContextWindow = positiveInteger(model.max_context_window);
    if (contextWindow !== undefined) route.contextWindow = contextWindow;
    if (maxContextWindow !== undefined && (contextWindow === undefined || maxContextWindow >= contextWindow)) {
      route.maxContextWindow = maxContextWindow;
    }
    if (!Array.isArray(model.supported_reasoning_levels)) {
      throw new Error("Codex model catalog has invalid reasoning levels");
    }
    route.supportedEfforts = [...new Set(model.supported_reasoning_levels
      .map((level: unknown) => level && typeof level === "object" ? (level as { effort?: unknown }).effort : null)
      .filter(isCodexEffort))];
    if (route.supportedEfforts.length === 0) {
      throw new Error("Codex model catalog has no supported API reasoning levels");
    }
    routes.push(route);
  }
  return routes;
}

async function fetchAccountCatalog(
  account: string,
  mgr: AccountManager,
  config: Config,
  fetchFn: typeof fetch,
): Promise<ModelRoute[]> {
  const credentials = async (force: boolean) => {
    try {
      const creds = await ensureFreshToken(account, mgr, config, force, fetchFn);
      if (!creds?.accessToken) throw new Error("missing access token");
      return creds;
    } catch (err) {
      const status = /refresh failed \((\d{3})\)/.exec(String(err))?.[1];
      throw new Error(`Codex token refresh failed${status ? ` (HTTP ${status})` : ""}; re-run accounts login`);
    }
  };
  let creds = await credentials(false);
  const request = async (): Promise<Response> => {
    try {
      return await fetchFn(CODEX_MODELS_URL, {
        headers: {
          authorization: `Bearer ${creds.accessToken}`,
          [CODEX_ACCOUNT_ID_HEADER]: creds.accountId ?? "",
          originator: CODEX_ORIGINATOR,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
      });
    } catch {
      throw new Error("Codex model catalog request failed (network error or timeout)");
    }
  };
  let response = await request();
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    const current = mgr.getOpenAICreds(account);
    creds = await credentials(current?.accessToken === creds.accessToken);
    response = await request();
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Codex model catalog request failed (HTTP ${response.status})`);
  }
  try {
    return catalogRoutes(await response.json());
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Codex model catalog has")) throw err;
    throw new Error("Codex model catalog response could not be read");
  }
}

/** Add discoverable Codex models without replacing configured routes or removing old ids. */
export async function updateOpenAIModels(
  mgr: AccountManager,
  table: ModelRoute[],
  config: Config,
  fetchFn: typeof fetch = fetch,
): Promise<ModelRoute[]> {
  const accounts = mgr.listNames().filter((name) => mgr.providerFor(name) === "openai" && mgr.getOpenAICreds(name)?.accessToken);
  if (accounts.length === 0) {
    console.log("No authenticated OpenAI account found — skipping models update.");
    return table;
  }

  const existing = new Set(table.map((route) => route.id));
  const added: ModelRoute[] = [];
  let successes = 0;
  let lastError: unknown;
  for (const account of accounts) {
    try {
      for (const route of await fetchAccountCatalog(account, mgr, config, fetchFn)) {
        if (existing.has(route.id)) continue;
        existing.add(route.id);
        added.push(route);
      }
      successes++;
    } catch (err) {
      lastError = err;
    }
  }
  if (successes === 0) throw lastError;
  if (successes < accounts.length) console.warn("Some Codex account catalogs were unavailable; keeping models discovered from the others.");
  if (added.length) console.log(`Discovered ${added.length} new Codex model${added.length === 1 ? "" : "s"}: ${added.map((m) => m.id).join(", ")}`);
  else console.log("Codex model catalog has no new model ids.");
  return added.length ? [...table, ...added] : table;
}
