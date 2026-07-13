/**
 * Anthropic's undocumented GET /api/oauth/usage returns ground-truth Claude
 * subscription usage — the same data behind `/usage`. This module fetches it
 * lazily at routing time and maps it into the pool's RateLimitSnapshot shape.
 */

import type { RateLimitSnapshot, RateLimitWindow } from "../accounts/types.ts";
import { MODEL_FAMILIES, modelFamilyOf, sortRateLimitWindows, windowDurationMs } from "../accounts/types.ts";
import { asObject, objectProp, stringProp, numberProp, parseJson } from "./shared.ts";
import type { Config } from "../config.ts";
import { AccountManager } from "../accounts/manager.ts";
import type { Account } from "../accounts/types.ts";
import { accessTokenFor } from "./oauth-token.ts";

function parseResetMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Convert a parsed /api/oauth/usage body into a RateLimitSnapshot. Prefers the
 * richer `limits[]` array (carries per-model scoped windows); falls back to the
 * top-level `five_hour`/`seven_day`/`seven_day_<model>` objects. `percent`/
 * `utilization` are 0–100 and get divided to the [0,1] fraction the pool uses.
 * Returns null when nothing usable is present.
 */
export function mapUsageResponse(
  json: Record<string, unknown> | null,
  now: number,
): RateLimitSnapshot | null {
  if (!json) return null;
  const windows: RateLimitWindow[] = [];
  const seen = new Set<string>();

  const push = (
    key: string,
    model: string | null,
    percent: number | undefined,
    resetsAt: string | undefined,
    fallbackResetsAt?: string,
  ): void => {
    if (percent == null || seen.has(key)) return;
    seen.add(key);
    const utilization = clamp01(percent / 100);
    let reset = parseResetMs(resetsAt) ?? parseResetMs(fallbackResetsAt);
    // A spent window with no usable reset would never sideline the account
    // (spentWindowReason needs reset > now); bound it by the window's own
    // duration so the sideline takes effect and later expires on its own.
    if (reset == null && utilization >= 1) {
      const dur = windowDurationMs(key);
      if (dur != null) reset = now + dur;
    }
    windows.push({
      key,
      model,
      status: utilization >= 1 ? "rejected" : "allowed",
      utilization,
      reset,
    });
  };

  const topResets = (topKey: string): string | undefined =>
    stringProp(objectProp(json, topKey), "resets_at");

  const limits = json.limits;
  if (Array.isArray(limits)) {
    for (const raw of limits) {
      const lim = asObject(raw);
      if (!lim) continue;
      const kind = stringProp(lim, "kind");
      const percent = numberProp(lim, "percent");
      const resetsAt = stringProp(lim, "resets_at");
      if (kind === "session") {
        push("5h", null, percent, resetsAt, topResets("five_hour"));
      } else if (kind === "weekly_all") {
        push("7d", null, percent, resetsAt, topResets("seven_day"));
      } else if (kind === "weekly_scoped") {
        const model = objectProp(objectProp(lim, "scope"), "model");
        const family = modelFamilyOf(stringProp(model, "display_name"));
        if (!family) {
          console.warn("[usage] skipping scoped limit with unrecognized model");
          continue;
        }
        push(`7d-${family}`, family, percent, resetsAt, topResets(`seven_day_${family}`));
      }
    }
  }

  // Backfill any account-wide window limits[] didn't yield from the top-level
  // objects. push() dedups via `seen`, so this only fills gaps — a partial
  // limits[] (e.g. session absent, or its percent null) no longer silently
  // drops 5h/7d, which replace-mode would otherwise wipe from routing.
  const top = (topKey: string, key: string, model: string | null): void => {
    const obj = objectProp(json, topKey);
    if (!obj) return;
    push(key, model, numberProp(obj, "utilization"), stringProp(obj, "resets_at"));
  };
  top("five_hour", "5h", null);
  top("seven_day", "7d", null);
  for (const f of MODEL_FAMILIES) {
    top(`seven_day_${f}`, `7d-${f}`, f);
  }

  if (windows.length === 0) return null;
  return {
    unifiedStatus: windows.some((w) => w.status === "rejected") ? "rejected" : "allowed",
    windows: sortRateLimitWindows(windows),
    updatedAt: now,
  };
}

/** Origin of the Anthropic API base URL, e.g. "https://api.anthropic.com" (note: /api/oauth/usage is NOT under /v1). */
function usageUrl(config: Config): string {
  return new URL("/api/oauth/usage", config.anthropicApiBaseUrl).toString();
}

/**
 * GET the account's live usage. Returns null on any failure (timeout, non-200,
 * unparseable body) — callers treat a null as "no fresh data, keep routing".
 */
export async function fetchUsageSnapshot(
  account: Account,
  mgr: AccountManager,
  config: Config,
  signal?: AbortSignal,
): Promise<RateLimitSnapshot | null> {
  let token: string;
  try {
    token = await accessTokenFor(account, mgr, config, false);
  } catch {
    return null;
  }

  let res: Response;
  try {
    const timeout = AbortSignal.timeout(config.usageFetchTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    res = await fetch(usageUrl(config), {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "content-type": "application/json",
        "user-agent": config.usageUserAgent,
      },
      signal: combined,
    });
  } catch {
    return null;
  }

  if (!res.ok) return null;
  let text: string;
  try {
    text = await res.text();
  } catch {
    return null;
  }
  return mapUsageResponse(parseJson(text), Date.now());
}

/** Per-account in-flight refreshes, so racing new sessions share one fetch. */
const usageLocks = new Map<string, Promise<void>>();

/**
 * Refresh an account's usage if its snapshot is stale, off the request path.
 * TTL-gated and in-flight-deduped so the self-throttling endpoint is called at
 * most once per account per TTL window. Never throws — a failure is recorded as
 * lastUsageCheckError and routing is unaffected. Callers should NOT await this.
 */
export async function maybeRefreshUsage(
  account: Account,
  mgr: AccountManager,
  config: Config,
): Promise<void> {
  if (!config.usageRefreshEnabled) return;

  // Skip if either our headroom data is fresh (headers or a prior usage check)
  // OR we recently attempted a check — the latter backs off a failing/429ing
  // endpoint, since recordUsageCheckError bumps lastUsageCheckAt but not updatedAt.
  const lastActivity = Math.max(
    account.usage.rateLimitStatus?.updatedAt ?? 0,
    account.usage.lastUsageCheckAt ?? 0,
  );
  if (Date.now() - lastActivity < config.usageRefreshTtlMs) return;

  const existing = usageLocks.get(account.name);
  if (existing) return existing;

  const run = (async () => {
    try {
      const snap = await fetchUsageSnapshot(account, mgr, config);
      if (snap) mgr.recordUsageSnapshot(account.name, snap);
      else mgr.recordUsageCheckError(account.name, "usage refresh failed (see logs)");
    } catch (err) {
      mgr.recordUsageCheckError(account.name, (err as Error).message);
    } finally {
      usageLocks.delete(account.name);
    }
  })();
  usageLocks.set(account.name, run);
  return run;
}
