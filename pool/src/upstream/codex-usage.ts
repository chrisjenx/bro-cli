/**
 * Codex's ground-truth usage snapshot, the ChatGPT-subscription analogue of
 * Anthropic's /api/oauth/usage. GET https://chatgpt.com/backend-api/wham/usage
 * returns rate_limit.{primary,secondary}_window with used_percent /
 * limit_window_seconds / reset_at, plus allowed / limit_reached. Polled off the
 * request path so idle/sidelined Codex accounts refresh, mirroring usage.ts.
 */

import type { Account, RateLimitSnapshot, RateLimitWindow } from "../accounts/types.ts";
import type { Config } from "../config.ts";
import { sortRateLimitWindows } from "../accounts/types.ts";
import { AccountManager } from "../accounts/manager.ts";
import { ensureFreshToken } from "./openai-codex.ts";
import { durationToWindowKey } from "./codex-windows.ts";
import { CODEX_ORIGINATOR, CODEX_ACCOUNT_ID_HEADER } from "./codex-constants.ts";
import { asObject, objectProp, numberProp, parseJson } from "./shared.ts";

export function mapCodexUsageResponse(
  json: Record<string, unknown> | null,
  now: number,
): RateLimitSnapshot | null {
  const root = asObject(json);
  const rl = root ? objectProp(root, "rate_limit") : null;
  if (!rl) return null;
  const rejected = rl["limit_reached"] === true || rl["allowed"] === false;

  const windows: RateLimitWindow[] = [];
  const seen = new Set<string>();
  const addWindow = (slot: "primary" | "secondary"): void => {
    const w = objectProp(rl, `${slot}_window`);
    if (!w) return;
    const usedPct = numberProp(w, "used_percent");
    const seconds = numberProp(w, "limit_window_seconds");
    const resetAtSec = numberProp(w, "reset_at");
    const resetAfter = numberProp(w, "reset_after_seconds");
    if (usedPct == null && resetAtSec == null && resetAfter == null) return;
    let key = durationToWindowKey(seconds == null ? null : seconds * 1000, slot);
    if (seen.has(key)) key = key === "5h" ? "7d" : "5h";
    seen.add(key);
    const utilization = usedPct == null ? null : Math.max(0, Math.min(1, usedPct / 100));
    const reset = resetAtSec != null ? resetAtSec * 1000 : resetAfter != null ? now + resetAfter * 1000 : null;
    // A window is spent only when the account is limited AND this window is the
    // full one. Marking an unfull window (e.g. a low-usage session window while
    // the WEEKLY limit is enforced) rejected would bench the account only until
    // that shorter window resets — an early un-bench and a wasted 429.
    const windowRejected = rejected && usedPct != null && usedPct >= 100;
    windows.push({ key, model: null, status: windowRejected ? "rejected" : "allowed", utilization, reset });
  };
  addWindow("primary");
  addWindow("secondary");
  if (windows.length === 0) return null;
  const unifiedStatus = windows.some((w) => w.status === "rejected") ? "rejected" : "allowed";
  return { unifiedStatus, windows: sortRateLimitWindows(windows), updatedAt: now };
}

export async function fetchCodexUsageSnapshot(
  account: Account,
  mgr: AccountManager,
  config: Config,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<RateLimitSnapshot | null> {
  let creds;
  try {
    creds = await ensureFreshToken(account.name, mgr, config, false, fetchFn);
  } catch {
    return null;
  }
  if (!creds?.accessToken) return null;

  let res: Response;
  try {
    const timeout = AbortSignal.timeout(config.usageFetchTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    res = await fetchFn(config.codexUsageUrl, {
      method: "GET",
      headers: {
        authorization: `Bearer ${creds.accessToken}`,
        [CODEX_ACCOUNT_ID_HEADER]: creds.accountId ?? "",
        originator: CODEX_ORIGINATOR,
        "user-agent": config.codexUsageUserAgent,
        accept: "application/json",
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
  return mapCodexUsageResponse(asObject(parseJson(text)), Date.now());
}

/** Per-account in-flight refreshes, so racing sweeps share one fetch. */
const codexUsageLocks = new Map<string, Promise<void>>();

export async function maybeRefreshCodexUsage(
  account: Account,
  mgr: AccountManager,
  config: Config,
): Promise<void> {
  if (!config.usageRefreshEnabled) return;
  const lastActivity = Math.max(
    account.usage.rateLimitStatus?.updatedAt ?? 0,
    account.usage.lastUsageCheckAt ?? 0,
  );
  if (Date.now() - lastActivity < config.usageRefreshTtlMs) return;

  const existing = codexUsageLocks.get(account.name);
  if (existing) return existing;

  const run = (async () => {
    try {
      const snap = await fetchCodexUsageSnapshot(account, mgr, config);
      if (snap) mgr.recordUsageSnapshot(account.name, snap);
      else mgr.recordUsageCheckError(account.name, "codex usage refresh failed (see logs)");
    } catch (err) {
      mgr.recordUsageCheckError(account.name, (err as Error).message);
    } finally {
      codexUsageLocks.delete(account.name);
    }
  })();
  codexUsageLocks.set(account.name, run);
  return run;
}
