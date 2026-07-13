/**
 * Shared Claude Code OAuth access-token accessor: returns a fresh bearer token
 * for an account, refreshing via the OAuth token endpoint when the stored one
 * is near expiry. A per-account in-flight lock coalesces concurrent refreshes so
 * a rotating refresh_token is never spent twice in parallel. Imported by both the
 * Messages proxy and the usage-refresh path so they share one lock map.
 */

import type { Config } from "../config.ts";
import { AccountManager } from "../accounts/manager.ts";
import type { Account, ClaudeOauthCreds } from "../accounts/types.ts";
import { parseJson, objectProp, stringProp, numberProp } from "./shared.ts";

const refreshLocks = new Map<string, Promise<ClaudeOauthCreds>>();

export async function accessTokenFor(
  account: Account,
  mgr: AccountManager,
  config: Config,
  forceRefresh: boolean,
): Promise<string> {
  const oauth = mgr.getOAuthCreds(account.name);
  if (!oauth?.accessToken) throw new Error(`Account "${account.name}" has no OAuth access token`);
  if (!forceRefresh && tokenFresh(oauth, config)) return oauth.accessToken;
  if (!oauth.refreshToken) {
    if (!forceRefresh) return oauth.accessToken;
    throw new Error(`Account "${account.name}" cannot refresh OAuth token; re-run accounts login`);
  }

  const existing = refreshLocks.get(account.name);
  if (existing) {
    const refreshed = await existing;
    if (!refreshed.accessToken) throw new Error(`Account "${account.name}" refresh returned no access token`);
    return refreshed.accessToken;
  }

  const refresh = refreshOAuth(account.name, mgr, config, forceRefresh).finally(() => {
    refreshLocks.delete(account.name);
  });
  refreshLocks.set(account.name, refresh);
  const refreshed = await refresh;
  if (!refreshed.accessToken) throw new Error(`Account "${account.name}" refresh returned no access token`);
  return refreshed.accessToken;
}

async function refreshOAuth(
  accountName: string,
  mgr: AccountManager,
  config: Config,
  forceRefresh: boolean,
): Promise<ClaudeOauthCreds> {
  const current = mgr.getOAuthCreds(accountName);
  if (!current?.refreshToken) throw new Error(`Account "${accountName}" has no OAuth refresh token`);
  if (!forceRefresh && current.accessToken && tokenFresh(current, config)) return current;

  let response: Response;
  try {
    response = await fetch(config.oauthTokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
        client_id: config.oauthClientId,
      }),
      signal: AbortSignal.timeout(config.tokenRefreshTimeoutMs),
    });
  } catch (err) {
    if ((err as Error).name === "TimeoutError" || (err as Error).name === "AbortError") {
      throw new Error(`OAuth refresh for "${accountName}" timed out after ${config.tokenRefreshTimeoutMs}ms`);
    }
    throw err;
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OAuth refresh failed for "${accountName}" (${response.status}): ${safeErrorText(text)}`);
  }

  const json = parseJson(text);
  const accessToken = stringProp(json, "access_token") ?? stringProp(json, "accessToken");
  if (!accessToken) throw new Error(`OAuth refresh failed for "${accountName}": no access token in response`);

  const refreshToken =
    stringProp(json, "refresh_token") ?? stringProp(json, "refreshToken") ?? current.refreshToken;
  const expiresIn = numberProp(json, "expires_in") ?? numberProp(json, "expiresIn") ?? 3600;
  const scope = stringProp(json, "scope");
  const next: ClaudeOauthCreds = {
    ...current,
    accessToken,
    refreshToken,
    expiresAt: Date.now() + Math.max(1, expiresIn) * 1000,
    scopes: scope ? scope.split(/\s+/).filter(Boolean) : current.scopes,
  };
  mgr.updateOAuthCreds(accountName, next);
  return next;
}

function tokenFresh(oauth: ClaudeOauthCreds, config: Config): boolean {
  if (!oauth.expiresAt) return true;
  return oauth.expiresAt - Date.now() > config.tokenRefreshSkewMs;
}

function safeErrorText(text: string): string {
  const json = parseJson(text);
  const error = objectProp(json, "error");
  return stringProp(error, "message") ?? (text.slice(0, 500) || "unknown OAuth error");
}
