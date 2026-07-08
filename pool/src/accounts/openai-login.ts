/**
 * Interactive ChatGPT OAuth login (PKCE + localhost callback), mirroring the
 * open-source Codex CLI flow (codex-rs/login/src/server.rs). Opens the
 * browser, waits for the callback, exchanges the code, and stores normalized
 * creds in the account dir. Never logs tokens — only success/failure + plan.
 */
import { randomBytes, createHash } from "crypto";
import type { AccountManager } from "./manager.ts";
import { normalizeCodexAuthJson } from "./openai-oauth.ts";
import {
  CODEX_AUTH_URL,
  CODEX_TOKEN_URL,
  CODEX_CLIENT_ID,
  CODEX_OAUTH_REDIRECT_PORT,
  CODEX_OAUTH_SCOPES,
  CODEX_ORIGINATOR,
} from "../upstream/codex-constants.ts";

export async function loginOpenAI(mgr: AccountManager, name: string): Promise<boolean> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(32).toString("base64url");
  // Path and port verified against codex-rs/login/src/server.rs:167
  // (`format!("http://localhost:{actual_port}/auth/callback")`).
  const redirectUri = `http://localhost:${CODEX_OAUTH_REDIRECT_PORT}/auth/callback`;

  const authUrl = new URL(CODEX_AUTH_URL);
  // Query params match codex-rs/login/src/server.rs:558-580 (`build_authorize_url`)
  // exactly, including `codex_cli_simplified_flow` and `originator`, which the
  // task-8 brief's draft omitted.
  authUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: CODEX_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: CODEX_OAUTH_SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: CODEX_ORIGINATOR,
  }).toString();

  const code = await new Promise<string | null>((resolve) => {
    let settled = false;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let overallTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(settleTimer);
      clearTimeout(overallTimer);
      server.stop();
      resolve(value);
    };
    const server = Bun.serve({
      port: CODEX_OAUTH_REDIRECT_PORT,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/auth/callback") return new Response("not found", { status: 404 });
        const ok = url.searchParams.get("state") === state && Boolean(url.searchParams.get("code"));
        settleTimer = setTimeout(() => {
          settle(ok ? url.searchParams.get("code") : null);
        }, 50);
        return new Response(
          ok ? "Login complete — you can close this tab." : "Login failed (state mismatch).",
          { headers: { "content-type": "text/plain" } },
        );
      },
    });
    console.log(`\nOpen this URL to sign in with ChatGPT:\n\n  ${authUrl}\n`);
    Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", authUrl.toString()], {
      stderr: "ignore",
    }).exited.catch(() => {});
    overallTimer = setTimeout(() => {
      settle(null);
    }, 5 * 60_000); // 5-min timeout
  });
  if (!code) {
    console.error("Login timed out or was rejected.");
    return false;
  }

  // Form-encoded exchange verified against codex-rs/login/src/server.rs:784-820
  // (`exchange_code_for_tokens`), which posts `application/x-www-form-urlencoded`
  // with grant_type=authorization_code, code, redirect_uri, client_id, code_verifier.
  const res = await fetch(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CODEX_CLIENT_ID,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) {
    console.error(`Token exchange failed (${res.status}).`);
    return false;
  }
  const tokens = (await res.json()) as Record<string, unknown>;
  const creds = normalizeCodexAuthJson({ tokens });
  if (!creds) {
    console.error("Token exchange returned no usable credentials.");
    return false;
  }
  if (typeof tokens.expires_in === "number") creds.expiresAt = Date.now() + tokens.expires_in * 1000;
  mgr.updateOpenAICreds(name, creds);
  return true;
}
