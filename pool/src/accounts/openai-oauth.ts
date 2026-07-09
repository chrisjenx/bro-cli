/**
 * ChatGPT-subscription OAuth for the Codex backend: credential normalization
 * and refresh. The interactive browser login lives in the CLI layer.
 */
import type { OpenAIOauthCreds } from "./types.ts";
import { CODEX_TOKEN_URL, CODEX_CLIENT_ID } from "../upstream/codex-constants.ts";

export function normalizeCodexAuthJson(raw: unknown): OpenAIOauthCreds | null {
  if (raw == null || typeof raw !== "object") return null;
  const root = raw as Record<string, unknown>;
  const tokens = (root.tokens ?? {}) as Record<string, unknown>;
  const accessToken = str(tokens.access_token) ?? str(root.access_token);
  if (!accessToken) return null;
  const idToken = str(tokens.id_token) ?? str(root.id_token);
  return {
    accessToken,
    refreshToken: str(tokens.refresh_token) ?? str(root.refresh_token),
    accountId: str(tokens.account_id) ?? str(root.account_id) ?? accountIdFromIdToken(idToken),
    planType: planFromIdToken(idToken),
  };
}

export async function refreshOpenAIToken(
  creds: OpenAIOauthCreds,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 20_000,
): Promise<OpenAIOauthCreds> {
  if (!creds.refreshToken) throw new Error("OpenAI account has no refresh token; re-run accounts login");
  let response: Response;
  try {
    response = await fetchFn(CODEX_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: creds.refreshToken,
        client_id: CODEX_CLIENT_ID,
        scope: "openid profile email",
      }),
      // Unlike every other outbound call in this proxy, this one previously had
      // no timeout at all — a stalled token endpoint hung the whole request
      // (and every subsequent request sharing its refreshLocks promise) forever.
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if ((err as Error).name === "TimeoutError" || (err as Error).name === "AbortError") {
      throw new Error(`OpenAI token refresh timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`OpenAI token refresh failed (${response.status}): ${text.slice(0, 200)}`);
  const json = JSON.parse(text) as Record<string, unknown>;
  const accessToken = str(json.access_token);
  if (!accessToken) throw new Error("OpenAI token refresh returned no access token");
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
  return {
    ...creds,
    accessToken,
    refreshToken: str(json.refresh_token) ?? creds.refreshToken,
    expiresAt: Date.now() + Math.max(1, expiresIn) * 1000,
  };
}

/** Best-effort plan name from the id_token JWT's claims; undefined on any problem. */
function planFromIdToken(idToken: string | undefined): string | undefined {
  const auth = authClaimsFromIdToken(idToken);
  return typeof auth?.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : undefined;
}

/**
 * Best-effort ChatGPT account id from the id_token JWT's claims; undefined on
 * any problem. The authorization_code token response has no bare account_id
 * field — only the import path (~/.codex/auth.json, already materialized by
 * the Codex CLI) does. Browser login must derive it here instead (mirrors
 * codex-rs/login/src/auth/manager.rs: `token_data.id_token.chatgpt_account_id`).
 */
function accountIdFromIdToken(idToken: string | undefined): string | undefined {
  const auth = authClaimsFromIdToken(idToken);
  return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
}

/** Decodes the `https://api.openai.com/auth` claim object from an id_token JWT; undefined on any problem. */
function authClaimsFromIdToken(idToken: string | undefined): Record<string, unknown> | undefined {
  if (!idToken) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString());
    return (payload["https://api.openai.com/auth"] ?? {}) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}
