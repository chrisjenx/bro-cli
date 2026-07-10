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

export type Provider = "anthropic" | "openai";

/** Filename inside an account dir that marks it as an OpenAI account. */
export const OPENAI_CREDS_FILENAME = "openai-auth.json";

/**
 * Normalized ChatGPT-subscription OAuth credential set (from the Codex OAuth
 * flow). Stored as JSON in <accountDir>/openai-auth.json.
 */
export interface OpenAIOauthCreds {
  accessToken?: string;
  refreshToken?: string;
  /** ChatGPT account id sent as the chatgpt-account-id request header. */
  accountId?: string;
  /** Epoch ms when accessToken expires. */
  expiresAt?: number;
  /** Plan name parsed from the id_token claims, for display (e.g. "plus", "pro"). */
  planType?: string;
}

/**
 * One unified rolling window reported by Anthropic, parsed from an
 * `anthropic-ratelimit-unified-<key>-{status,utilization,reset}` header triple.
 *
 * Account-wide windows use plain duration keys ("5h", "7d"). Model-scoped
 * windows carry the model family in the key (e.g. "7d-fable", "7d-opus") —
 * those limits are typically far tighter than the account-wide weekly window,
 * so routing treats them as binding only for requests targeting that model.
 */
export interface RateLimitWindow {
  /** Window key exactly as it appears in the header name, e.g. "5h", "7d-fable". */
  key: string;
  /** Model family the window is scoped to ("fable", "opus", …), null when account-wide. */
  model: string | null;
  /** Window status, e.g. "allowed" | "rejected". */
  status: string | null;
  /** Fraction of the window consumed, in [0, 1] (0.06 = 6% used). */
  utilization: number | null;
  /** When the window resets (epoch ms). */
  reset: number | null;
}

/**
 * Anthropic's own view of an account's remaining headroom, taken verbatim from
 * the `anthropic-ratelimit-unified-*` response headers that Claude subscription
 * (OAuth) traffic returns on every direct response, success or error. This is
 * ground truth from Anthropic, unlike the `window*` counters below which are
 * just our own local tally.
 *
 * Subscription plans use a "unified" rolling-window model: a 5-hour and a
 * 7-day account-wide window, plus optional model-scoped windows (e.g. a
 * separate, lower Fable allowance). Every window we can see in the headers is
 * captured here, so new window kinds Anthropic starts sending show up without
 * code changes. This is a different header family than the standard
 * token-bucket API headers (`anthropic-ratelimit-tokens-remaining`, …), which
 * this traffic never sends.
 */
export interface RateLimitSnapshot {
  /** Overall unified status across all windows, e.g. "allowed" | "rejected". */
  unifiedStatus: string | null;

  /** Every unified window seen in the headers, account-wide windows first. */
  windows: RateLimitWindow[];

  /** When this snapshot was captured. */
  updatedAt: number;
}

/** Duration-shaped key tokens ("5h", "7d", "30d", …) as opposed to model scopes. */
const DURATION_TOKEN = /^\d+(?:h|hr|hrs|d|day|days|w|wk|mo|min|m)$/i;

/**
 * Model family a unified-window key is scoped to, or null for account-wide
 * windows. "7d-fable" → "fable"; "5h" → null. Tolerates either token order
 * and `_` separators, since the exact header shape is undocumented.
 */
export function windowModelOf(key: string): string | null {
  const scopes = key.split(/[-_]/).filter((t) => t !== "" && !DURATION_TOKEN.test(t));
  return scopes.length > 0 ? scopes.join("-").toLowerCase() : null;
}

/**
 * Duration in milliseconds encoded by a window key's duration token, or null when
 * the key carries no duration token (e.g. "overage"). Tolerates model scopes and
 * `-`/`_` separators: "5h" → 5h, "7d-fable" → 7d, "7d_oi" → 7d. Units mirror
 * DURATION_TOKEN (min/m = minute, h = hour, d = day, w = week, mo = month≈30d).
 */
export function windowDurationMs(key: string): number | null {
  const token = key.split(/[-_]/).find((t) => DURATION_TOKEN.test(t));
  if (!token) return null;
  const m = /^(\d+)(mo|min|hrs|hr|days|day|wk|[hdwm])$/i.exec(token);
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  const MIN = 60_000;
  const H = 60 * MIN;
  const D = 24 * H;
  switch (m[2]!.toLowerCase()) {
    case "min":
    case "m":
      return n * MIN;
    case "h":
    case "hr":
    case "hrs":
      return n * H;
    case "d":
    case "day":
    case "days":
      return n * D;
    case "w":
    case "wk":
      return n * 7 * D;
    case "mo":
      return n * 30 * D;
    default:
      return null;
  }
}

/** Account-wide windows first, then model-scoped, stable by key. */
export function sortRateLimitWindows(windows: RateLimitWindow[]): RateLimitWindow[] {
  return [...windows].sort((a, b) => {
    if ((a.model == null) !== (b.model == null)) return a.model == null ? -1 : 1;
    return a.key.localeCompare(b.key);
  });
}

/** Model families we route on, matched as substrings of the requested model id. */
const MODEL_FAMILIES = ["fable", "mythos", "opus", "sonnet", "haiku"] as const;

/**
 * Canonical model family ("fable", "opus", …) of a requested model id, used to
 * match requests against model-scoped unified windows. Null when unknown.
 */
export function modelFamilyOf(modelId: string | undefined | null): string | null {
  if (!modelId) return null;
  const lower = modelId.toLowerCase();
  for (const family of MODEL_FAMILIES) {
    if (lower.includes(family)) return family;
  }
  return null;
}

/**
 * Coerce a persisted snapshot into the current shape. Older pool versions
 * stored fixed `fiveHour*` / `sevenDay*` fields instead of `windows`; usage
 * state persists across upgrades, so convert those on load.
 */
export function normalizeRateLimitSnapshot(raw: unknown): RateLimitSnapshot | null {
  if (raw == null || typeof raw !== "object") return null;
  const snap = raw as Record<string, unknown>;
  const unifiedStatus = typeof snap.unifiedStatus === "string" ? snap.unifiedStatus : null;
  const updatedAt = typeof snap.updatedAt === "number" ? snap.updatedAt : Date.now();

  if (Array.isArray(snap.windows)) {
    return { unifiedStatus, windows: snap.windows as RateLimitWindow[], updatedAt };
  }

  const legacy = (key: string, prefix: string): RateLimitWindow | null => {
    const status = snap[`${prefix}Status`];
    const utilization = snap[`${prefix}Utilization`];
    const reset = snap[`${prefix}Reset`];
    if (status == null && utilization == null && reset == null) return null;
    return {
      key,
      model: null,
      status: typeof status === "string" ? status : null,
      utilization: typeof utilization === "number" ? utilization : null,
      reset: typeof reset === "number" ? reset : null,
    };
  };
  const windows = [legacy("5h", "fiveHour"), legacy("7d", "sevenDay")].filter(
    (w): w is RateLimitWindow => w != null,
  );
  return { unifiedStatus, windows, updatedAt };
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
  provider: Provider;
  authenticated: boolean;
  subscriptionType: string | null;
  rateLimitTier: string | null;
  scopes: string[];
  /** Routing priority; lower = preferred. Default 100 (see DEFAULT_PRIORITY). */
  priority: number;
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
