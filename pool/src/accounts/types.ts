/** The `claudeAiOauth` block stored in an account's .credentials.json. */
export interface ClaudeOauthCreds {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

export interface CredentialsFile {
  claudeAiOauth?: ClaudeOauthCreds;
  [key: string]: unknown;
}

/**
 * Anthropic's own view of an account's remaining headroom, taken verbatim from
 * the `anthropic-ratelimit-*` response headers (present on every direct-OAuth
 * response, success or error). This is ground truth from Anthropic, unlike the
 * `window*` counters below which are just our own local tally.
 */
export interface RateLimitSnapshot {
  requestsLimit: number | null;
  requestsRemaining: number | null;
  requestsReset: number | null;
  tokensLimit: number | null;
  tokensRemaining: number | null;
  tokensReset: number | null;
  inputTokensLimit: number | null;
  inputTokensRemaining: number | null;
  inputTokensReset: number | null;
  outputTokensLimit: number | null;
  outputTokensRemaining: number | null;
  outputTokensReset: number | null;
  /** When this snapshot was captured. */
  updatedAt: number;
}

/** Rolling + lifetime usage counters for one account. */
export interface AccountUsage {
  /** Start of the current rolling window (epoch ms). */
  windowStart: number;
  windowRequests: number;
  windowInputTokens: number;
  windowOutputTokens: number;
  windowCostUsd: number;

  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;

  lastUsedAt: number | null;
  lastError: string | null;

  /** If set and in the future, the account is sidelined until this time. */
  rateLimitedUntil: number | null;

  /**
   * Most recent rate-limit headroom reported by Anthropic for this account.
   * Only populated on the direct OAuth backend — the CLI-subprocess backend
   * has no HTTP access and cannot see these headers.
   */
  rateLimitStatus: RateLimitSnapshot | null;
}

/** Fully-resolved view of an account for status/routing. */
export interface Account {
  name: string;
  configDir: string;
  authenticated: boolean;
  subscriptionType: string | null;
  rateLimitTier: string | null;
  scopes: string[];
  tokenExpiresAt: number | null;
  tokenExpired: boolean;
  usage: AccountUsage;
  /** Available to serve traffic right now. */
  available: boolean;
  /** Human-readable reason when not available. */
  unavailableReason: string | null;
}

export function emptyUsage(now: number): AccountUsage {
  return {
    windowStart: now,
    windowRequests: 0,
    windowInputTokens: 0,
    windowOutputTokens: 0,
    windowCostUsd: 0,
    totalRequests: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    lastUsedAt: null,
    lastError: null,
    rateLimitedUntil: null,
    rateLimitStatus: null,
  };
}
