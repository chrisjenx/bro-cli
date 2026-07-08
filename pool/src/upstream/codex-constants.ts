/**
 * Protocol constants for OpenAI's Codex backend (ChatGPT-subscription traffic).
 * Every value verified against the open-source Codex CLI (github.com/openai/codex),
 * commit bdaad6820cd884ea11787477f4c495e4de0a8be5, on 2026-07-08.
 * Cite the source file next to each constant. Corrections vs. the task-1 brief's
 * guesses are called out explicitly.
 */

/** OAuth issuer / authorization endpoint (browser flow).
 * — codex-rs/login/src/server.rs:57 (DEFAULT_ISSUER = "https://auth.openai.com"),
 *   codex-rs/login/src/server.rs:566 (`format!("{issuer}/oauth/authorize?{qs}")`) */
export const CODEX_AUTH_URL = "https://auth.openai.com/oauth/authorize";

/** OAuth token endpoint (code exchange + refresh).
 * — codex-rs/login/src/server.rs:801 (`format!("{}/oauth/token", issuer.trim_end_matches('/'))`) */
export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";

/** Public OAuth client id used by the Codex CLI.
 * — codex-rs/login/src/auth/manager.rs:1446 (`pub const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";`)
 * CORRECTED from the brief's placeholder "<verify: app_...>". */
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/** Localhost callback port the registered redirect URI expects.
 * — codex-rs/login/src/server.rs:58 (`const DEFAULT_PORT: u16 = 1455;`).
 * Note: the CLI falls back to port 1457 (`FALLBACK_PORT`, server.rs:60) if 1455 is busy;
 * the redirect_uri is built dynamically as `http://localhost:{actual_port}/auth/callback`
 * (server.rs:167), not a fixed path baked into this constant. */
export const CODEX_OAUTH_REDIRECT_PORT = 1455;

/** OAuth scopes requested during the authorize step.
 * — codex-rs/login/src/server.rs:566-570 (`"openid profile email offline_access api.connectors.read api.connectors.invoke"`)
 * CORRECTED from the brief's guess: two extra scopes (`api.connectors.read`,
 * `api.connectors.invoke`) are present in the real request that the brief's
 * guess omitted. */
export const CODEX_OAUTH_SCOPES =
  "openid profile email offline_access api.connectors.read api.connectors.invoke";

/** Responses-API endpoint subscription traffic posts to.
 * — codex-rs/model-provider-info/src/lib.rs:38 (`CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"`)
 *   codex-rs/core/src/client.rs:158 (`const RESPONSES_ENDPOINT: &str = "/responses";`, appended to the base URL)
 * Matches the brief's guess exactly. */
export const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

/** `originator` header value identifying the client (only sent when it differs
 * from this default — see codex-rs/core/src/client.rs:1885-1897 `add_originator_header`).
 * — codex-rs/login/src/auth/default_client.rs:42 (`pub const DEFAULT_ORIGINATOR: &str = "codex_cli_rs";`)
 * Matches the brief's guess exactly. */
export const CODEX_ORIGINATOR = "codex_cli_rs";

/** Header carrying the ChatGPT workspace/account id on outbound requests.
 * — codex-rs/codex-api/src/files.rs:280, codex-rs/core/src/mcp_openai_file.rs:241 et al.
 *   (wiremock matchers asserting `header("chatgpt-account-id", "account_id")`).
 * Matches the brief's guess exactly. */
export const CODEX_ACCOUNT_ID_HEADER = "chatgpt-account-id";

/** `OpenAI-Beta` header name used by the client.
 * — codex-rs/core/src/client.rs:141 (`pub const OPENAI_BETA_HEADER: &str = "OpenAI-Beta";`) */
export const CODEX_OPENAI_BETA_HEADER = "OpenAI-Beta";

/** `OpenAI-Beta` header VALUE. CORRECTED from the brief's guess of
 * "responses=experimental": that literal value does not appear anywhere in the
 * source. The only place the client sets this header is the WebSocket handshake
 * path (codex-rs/core/src/client.rs:1092-1095), with value
 * `RESPONSES_WEBSOCKETS_V2_BETA_HEADER_VALUE` (client.rs:155). The plain HTTP
 * POST path (`stream_responses_api`, client.rs:1395) does NOT set this header
 * at all — so pool code should treat this header as optional / websocket-only,
 * not a required header on every Responses API call. */
export const CODEX_OPENAI_BETA_VALUE = "responses_websockets=2026-02-06";

/** Response headers carrying rolling-window usage, verified against
 * codex-rs/codex-api/src/rate_limits.rs:57-100 (`parse_rate_limit_for_limit`) and its
 * unit tests (rate_limits.rs:276-325), which are the ground truth for the wire format:
 *   prefix + "-primary-used-percent" / "-primary-window-minutes" / "-primary-reset-at"
 *   prefix + "-secondary-used-percent" / "-secondary-window-minutes" / "-secondary-reset-at"
 * where prefix defaults to "x-codex" for the primary/default metered limit.
 * CORRECTED from the brief's guess: the reset field is an absolute UNIX timestamp
 * named `...-reset-at` (seconds since epoch, e.g. "1704069000" in the source's own
 * test fixture), NOT a countdown named `...-resets-in-seconds` as the brief guessed. */
export const CODEX_RATE_LIMIT_HEADERS = {
  primaryUsedPercent: "x-codex-primary-used-percent",
  primaryWindowMinutes: "x-codex-primary-window-minutes",
  primaryResetAt: "x-codex-primary-reset-at",
  secondaryUsedPercent: "x-codex-secondary-used-percent",
  secondaryWindowMinutes: "x-codex-secondary-window-minutes",
  secondaryResetAt: "x-codex-secondary-reset-at",
} as const;

/**
 * Shape of `~/.codex/auth.json`, verified against
 * codex-rs/login/src/auth/storage.rs:39-61 (`struct AuthDotJson`) and
 * codex-rs/login/src/token_data.rs (`struct TokenData`, `struct IdTokenInfo`):
 *
 * {
 *   "auth_mode"?: string,               // optional, e.g. "ChatGPT" | "ApiKey"
 *   "OPENAI_API_KEY"?: string | null,    // serde rename of `openai_api_key`
 *   "tokens"?: {
 *     "id_token": <opaque raw JWT string on disk>,  // parsed into IdTokenInfo in
 *                                                     // memory via custom (de)serializer;
 *                                                     // on disk it is the raw JWT string.
 *     "access_token": string,            // JWT
 *     "refresh_token": string,
 *     "account_id"?: string | null
 *   },
 *   "last_refresh"?: string,             // ISO-8601 / RFC3339 DateTime<Utc>
 *   "agent_identity"?: ...,
 *   "personal_access_token"?: string | null,
 *   "bedrock_api_key"?: ...
 * }
 *
 * Matches the brief's guessed field names (`tokens.id_token/access_token/refresh_token/
 * account_id`, `last_refresh`) exactly; the brief did not mention `auth_mode`,
 * `OPENAI_API_KEY`, `agent_identity`, `personal_access_token`, or `bedrock_api_key`,
 * which are additional top-level fields present in the real struct.
 */
