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
  return {
    accessToken,
    refreshToken: str(tokens.refresh_token) ?? str(root.refresh_token),
    accountId: str(tokens.account_id) ?? str(root.account_id),
    planType: planFromIdToken(str(tokens.id_token)),
  };
}

export async function refreshOpenAIToken(
  creds: OpenAIOauthCreds,
  fetchFn: typeof fetch = fetch,
): Promise<OpenAIOauthCreds> {
  if (!creds.refreshToken) throw new Error("OpenAI account has no refresh token; re-run accounts login");
  const response = await fetchFn(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: creds.refreshToken,
      client_id: CODEX_CLIENT_ID,
      scope: "openid profile email",
    }),
  });
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

/** Best-effort plan name from the id_token JWT's claims; null on any problem. */
function planFromIdToken(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString());
    const auth = (payload["https://api.openai.com/auth"] ?? {}) as Record<string, unknown>;
    return typeof auth.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : undefined;
  } catch {
    return undefined;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}
