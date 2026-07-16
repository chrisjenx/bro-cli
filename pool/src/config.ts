/**
 * Central configuration, resolved once from the environment.
 *
 * The "pool directory" holds one sub-directory per Claude account. Each of those
 * sub-directories stores a Claude Code OAuth credential set. The direct backend
 * reads those tokens for upstream API calls; the CLI fallback also uses each
 * directory as CLAUDE_CONFIG_DIR when spawning Claude Code.
 */

import { homedir } from "os";
import { join } from "path";

export interface Config {
  /** Root directory that holds every account's config dir + pool state. */
  poolDir: string;
  /** Directory holding one sub-directory per account (each a CLAUDE_CONFIG_DIR). */
  accountsDir: string;
  /** File where rolling usage counters are persisted between restarts. */
  usageFile: string;
  /** File where session→account pins are persisted between restarts. */
  sessionsFile: string;
  /** File where the model routing table is persisted between restarts. */
  modelsFile: string;
  /** Path to the `claude` executable. */
  claudeBin: string;
  /** Inference backend for /v1/messages: direct OAuth proxy by default, CLI as fallback. */
  backend: "oauth" | "cli";
  /** Base URL for the real Anthropic API when using the direct OAuth backend. */
  anthropicApiBaseUrl: string;
  /** OAuth token endpoint used to refresh Claude Code account credentials. */
  oauthTokenUrl: string;
  /** Public Claude Code OAuth client id. Override if Anthropic changes it. */
  oauthClientId: string;
  /** Refresh access tokens this long before their recorded expiry. */
  tokenRefreshSkewMs: number;
  /** Timeout for the OAuth token-refresh call itself (Claude + OpenAI), in ms. */
  tokenRefreshTimeoutMs: number;
  /** HTTP host to bind. */
  host: string;
  /** HTTP port to bind. */
  port: number;
  /** Optional bearer token required on /v1/* requests. Empty = no auth. */
  proxyApiKey: string;
  /** Per-request upstream/subprocess timeout in milliseconds. */
  requestTimeoutMs: number;
  /**
   * Emit an SSE `ping` keep-alive when a streaming upstream goes idle this long
   * without sending bytes. Reasoning models (e.g. gpt-5.5 via Codex) can think
   * silently for seconds; without keep-alives the client's inactivity timeout
   * fires and it aborts. Mirrors Anthropic's own periodic ping.
   */
  streamKeepAliveMs: number;
  /**
   * Length of the rolling usage window in milliseconds. Claude Max plans reset
   * usage roughly every 5 hours; we mirror that window for display/routing.
   */
  usageWindowMs: number;
  /** How long to sideline an account after it reports a rate limit, in ms. */
  rateLimitCooldownMs: number;
  /** Max same-account backoff retries for a transient upstream overload (529/500/503). 0 disables. */
  overloadRetryMax: number;
  /** Base backoff delay for overload retries, doubled per attempt, in ms. */
  overloadRetryBaseMs: number;
  /** Per-sleep cap for overload backoff, in ms. */
  overloadRetryMaxDelayMs: number;
  /**
   * A session idle longer than this loses its account pin and stops counting
   * toward that account's active-session load. Claude Code sessions idle while
   * the user reads/thinks; 30 min covers that without pinning abandoned ones.
   */
  sessionIdleMs: number;
  /** Account routing policy: blended weighted score by default. */
  routingStrategy: "weighted" | "expiring" | "headroom";
  /**
   * Minimum remaining headroom for an account to stay eligible in the `weighted`
   * and `expiring` strategies, measured over the gate set — the tightest binding
   * window except the account-wide 7d (which we deliberately drain). In practice
   * this is the 5-hour window, plus any model-scoped window for model requests.
   */
  routingMinHeadroom: number;
  /** Log a line when a request fails over from one account to another. */
  logFailover: boolean;
  /** Enable the async usage-refresh call to /api/oauth/usage at routing time. */
  usageRefreshEnabled: boolean;
  /** Skip a usage refresh if the account's snapshot is younger than this (ms). */
  usageRefreshTtlMs: number;
  /** Timeout for a single /api/oauth/usage fetch (ms). */
  usageFetchTimeoutMs: number;
  /** User-Agent sent to /api/oauth/usage; the wrong/absent UA hits a throttled bucket. */
  usageUserAgent: string;
  /** Codex ground-truth usage endpoint (ChatGPT backend). */
  codexUsageUrl: string;
  /** User-Agent sent to the Codex usage endpoint. */
  codexUsageUserAgent: string;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Like intEnv, but floors the result so a misconfigured 0/negative value can't produce a runaway timer or a timeout that fails instantly. */
function positiveIntEnv(name: string, fallback: number, min: number): number {
  return Math.max(min, intEnv(name, fallback));
}

function floatEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function routingStrategyEnv(): "weighted" | "expiring" | "headroom" {
  const raw = process.env.ROUTING_STRATEGY?.toLowerCase();
  if (raw === "headroom" || raw === "expiring") return raw;
  return "weighted";
}

function backendEnv(): "oauth" | "cli" {
  const raw = (process.env.CLAUDE_POOL_BACKEND || process.env.POOL_BACKEND || "oauth").toLowerCase();
  return raw === "cli" || raw === "subprocess" || raw === "claude" ? "cli" : "oauth";
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const poolDir = process.env.CLAUDE_POOL_DIR || join(homedir(), ".claude-max-pool");
  const accountsDir = join(poolDir, "accounts");
  const usageFile = join(poolDir, "usage.json");
  const sessionsFile = join(poolDir, "sessions.json");
  const modelsFile = join(poolDir, "models.json");

  const config: Config = {
    poolDir,
    accountsDir,
    usageFile,
    sessionsFile,
    modelsFile,
    claudeBin: process.env.CLAUDE_BIN || "claude",
    backend: backendEnv(),
    anthropicApiBaseUrl: process.env.ANTHROPIC_API_BASE_URL || "https://api.anthropic.com",
    oauthTokenUrl: process.env.CLAUDE_OAUTH_TOKEN_URL || "https://platform.claude.com/v1/oauth/token",
    oauthClientId: process.env.CLAUDE_OAUTH_CLIENT_ID || "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    tokenRefreshSkewMs: intEnv("TOKEN_REFRESH_SKEW_MS", 5 * 60 * 1000),
    tokenRefreshTimeoutMs: positiveIntEnv("TOKEN_REFRESH_TIMEOUT_MS", 20 * 1000, 1000),
    host: process.env.HOST || "127.0.0.1",
    port: intEnv("PORT", 3456),
    proxyApiKey: process.env.PROXY_API_KEY || "",
    requestTimeoutMs: intEnv("REQUEST_TIMEOUT_MS", 15 * 60 * 1000),
    streamKeepAliveMs: positiveIntEnv("STREAM_KEEPALIVE_MS", 1000, 100),
    usageWindowMs: intEnv("USAGE_WINDOW_MS", 5 * 60 * 60 * 1000),
    rateLimitCooldownMs: intEnv("RATE_LIMIT_COOLDOWN_MS", 60 * 60 * 1000),
    overloadRetryMax: positiveIntEnv("OVERLOAD_RETRY_MAX", 4, 0),
    overloadRetryBaseMs: positiveIntEnv("OVERLOAD_RETRY_BASE_MS", 500, 0),
    overloadRetryMaxDelayMs: positiveIntEnv("OVERLOAD_RETRY_MAX_DELAY_MS", 8000, 0),
    sessionIdleMs: positiveIntEnv("SESSION_IDLE_MS", 30 * 60 * 1000, 60_000),
    routingStrategy: routingStrategyEnv(),
    routingMinHeadroom: clamp(floatEnv("ROUTING_MIN_HEADROOM", 0.1), 0, 1),
    logFailover: process.env.LOG_FAILOVER !== "0",
    usageRefreshEnabled: process.env.CLAUDE_USAGE_REFRESH !== "0",
    usageRefreshTtlMs: positiveIntEnv("USAGE_REFRESH_TTL_MS", 120_000, 1000),
    usageFetchTimeoutMs: positiveIntEnv("USAGE_FETCH_TIMEOUT_MS", 2500, 250),
    usageUserAgent: process.env.CLAUDE_USAGE_USER_AGENT || "claude-code/2.1.207",
    codexUsageUrl: process.env.CODEX_USAGE_URL || "https://chatgpt.com/backend-api/wham/usage",
    codexUsageUserAgent: process.env.CODEX_USAGE_USER_AGENT || "codex-cli",
    ...overrides,
  };

  return config;
}

/** Default config dir the Claude CLI uses when CLAUDE_CONFIG_DIR is unset. */
export function defaultClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}
