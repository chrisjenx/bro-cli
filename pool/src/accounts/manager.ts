/**
 * AccountManager owns the pool of Claude accounts.
 *
 * Each account is a directory under <poolDir>/accounts/<name>/ with its own
 * Claude Code OAuth credentials. The manager reads each account's credentials
 * for status, tracks rolling usage, sidelines rate-limited accounts, and picks
 * which account should serve a given request (sticky by session, else
 * least-loaded).
 */

import { mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync, rmSync, copyFileSync, statSync } from "fs";
import { join } from "path";
import type { Config } from "../config.ts";
import { defaultClaudeConfigDir } from "../config.ts";
import type {
  Account,
  AccountUsage,
  CredentialsFile,
  OpenAIOauthCreds,
  Provider,
  RateLimitSnapshot,
  RateLimitWindow,
} from "./types.ts";
import { emptyUsage, OPENAI_CREDS_FILENAME, normalizeRateLimitSnapshot, sortRateLimitWindows } from "./types.ts";
import {
  deleteKeychainCreds,
  keychainServiceForConfigDir,
  readKeychainCreds,
  readKeychainCredsForConfigDir,
} from "./keychain.ts";
import type { CliUsage } from "../subprocess/types.ts";

interface PersistedState {
  usage: Record<string, AccountUsage>;
}

/** Darwin Keychain access, injectable so tests can simulate leftover items. */
export interface KeychainOps {
  read: typeof readKeychainCreds;
  delete: typeof deleteKeychainCreds;
}

const defaultKeychainOps: KeychainOps = { read: readKeychainCreds, delete: deleteKeychainCreds };

export class AccountManager {
  private config: Config;
  private usage: Record<string, AccountUsage> = {};
  /** Maps a caller session key to the account chosen for it (stickiness). */
  private sessionAffinity = new Map<string, string>();
  /** Round-robin cursor for tie-breaking least-loaded selection. */
  private rrCursor = 0;
  private keychain: KeychainOps;

  constructor(config: Config, keychain: KeychainOps = defaultKeychainOps) {
    this.config = config;
    this.keychain = keychain;
    mkdirSync(this.config.accountsDir, { recursive: true });
    this.loadState();
  }

  // ---- persistence -------------------------------------------------------

  private loadState(): void {
    if (!existsSync(this.config.usageFile)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.config.usageFile, "utf8")) as PersistedState;
      this.usage = parsed.usage ?? {};
      // Snapshots persisted by older pool versions used fixed 5h/7d fields.
      for (const u of Object.values(this.usage)) {
        u.rateLimitStatus = normalizeRateLimitSnapshot(u.rateLimitStatus);
      }
    } catch {
      this.usage = {};
    }
  }

  private saveState(): void {
    const state: PersistedState = { usage: this.usage };
    try {
      writeFileSync(this.config.usageFile, JSON.stringify(state, null, 2));
    } catch {
      // Non-fatal: usage stats are best-effort.
    }
  }

  private usageFor(name: string): AccountUsage {
    let u = this.usage[name];
    if (!u) {
      u = emptyUsage(Date.now());
      this.usage[name] = u;
    }
    this.rollWindow(u);
    return u;
  }

  private rollWindow(u: AccountUsage): void {
    const now = Date.now();
    if (now - u.windowStart >= this.config.usageWindowMs) {
      u.windowStart = now;
      u.windowRequests = 0;
      u.windowInputTokens = 0;
      u.windowOutputTokens = 0;
      u.windowCostUsd = 0;
    }
  }

  // ---- account directory management -------------------------------------

  /** Names of every account directory present in the pool. */
  listNames(): string[] {
    if (!existsSync(this.config.accountsDir)) return [];
    return readdirSync(this.config.accountsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  }

  configDirFor(name: string): string {
    return join(this.config.accountsDir, name);
  }

  private credsPath(name: string): string {
    return join(this.configDirFor(name), ".credentials.json");
  }

  create(name: string): void {
    this.assertValidName(name);
    const dir = this.configDirFor(name);
    if (existsSync(dir)) throw new Error(`Account "${name}" already exists`);
    mkdirSync(dir, { recursive: true });
  }

  remove(name: string): void {
    const dir = this.configDirFor(name);
    if (!existsSync(dir)) throw new Error(`Account "${name}" does not exist`);
    rmSync(dir, { recursive: true, force: true });
    // macOS keeps this account's login in the Keychain, independent of the
    // directory — without this, readCreds()'s Keychain fallback would keep
    // reporting a removed account as authenticated forever.
    if (process.platform === "darwin") {
      this.keychain.delete(keychainServiceForConfigDir(dir));
    }
    delete this.usage[name];
    this.saveState();
  }

  /** Copy the machine's current Claude login into a new pool account. */
  importCurrent(name: string): void {
    this.create(name);
    const src = join(defaultClaudeConfigDir(), ".credentials.json");
    if (existsSync(src)) {
      copyFileSync(src, this.credsPath(name));
      return;
    }
    // macOS has no plaintext credentials file — read the current login from the
    // Keychain and materialize it into this account's `.credentials.json`.
    if (process.platform === "darwin") {
      const creds = readKeychainCredsForConfigDir(defaultClaudeConfigDir());
      if (creds?.claudeAiOauth?.accessToken) {
        writeFileSync(this.credsPath(name), JSON.stringify(creds, null, 2));
        return;
      }
      throw new Error(
        `No Claude Code login found in the macOS Keychain for ${defaultClaudeConfigDir()}. ` +
          `Log in with the base 'claude' CLI first, or use 'accounts login ${name}'.`,
      );
    }
    throw new Error(
      `No credentials found at ${src}. Log in with the base 'claude' CLI first, or use 'accounts login ${name}'.`,
    );
  }

  private assertValidName(name: string): void {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
      throw new Error(
        `Invalid account name "${name}". Use letters, numbers, dot, dash, underscore (max 64 chars).`,
      );
    }
  }

  // ---- status ------------------------------------------------------------

  private readCreds(name: string): CredentialsFile | null {
    // An account that's been removed has no directory. Without this check the
    // Keychain fallback below would keep resolving credentials for it forever
    // (macOS never deletes that item on its own), letting a removed account
    // silently keep serving traffic via stale session affinity in pick().
    if (!existsSync(this.configDirFor(name))) return null;
    const p = this.credsPath(name);
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, "utf8")) as CredentialsFile;
      } catch {
        return null;
      }
    }
    // macOS keeps Claude Code credentials in the login Keychain, not in a
    // `.credentials.json` file, so there is nothing on disk to read after an
    // `accounts login`. Fall back to the Keychain item for this account's
    // config dir. Rotated tokens are still cached to the file by
    // updateOAuthCreds(), which then takes precedence on the next read.
    if (process.platform === "darwin") {
      return this.keychain.read(keychainServiceForConfigDir(this.configDirFor(name)));
    }
    return null;
  }

  getOAuthCreds(name: string): CredentialsFile["claudeAiOauth"] | null {
    return this.readCreds(name)?.claudeAiOauth ?? null;
  }

  updateOAuthCreds(name: string, oauth: NonNullable<CredentialsFile["claudeAiOauth"]>): void {
    const existing = this.readCreds(name) ?? {};
    const next: CredentialsFile = { ...existing, claudeAiOauth: oauth };
    writeFileSync(this.credsPath(name), JSON.stringify(next, null, 2));
  }

  providerFor(name: string): Provider {
    return existsSync(join(this.configDirFor(name), OPENAI_CREDS_FILENAME)) ? "openai" : "anthropic";
  }

  private openaiCredsPath(name: string): string {
    return join(this.configDirFor(name), OPENAI_CREDS_FILENAME);
  }

  getOpenAICreds(name: string): OpenAIOauthCreds | null {
    try {
      return JSON.parse(readFileSync(this.openaiCredsPath(name), "utf8")) as OpenAIOauthCreds;
    } catch {
      return null;
    }
  }

  updateOpenAICreds(name: string, creds: OpenAIOauthCreds): void {
    writeFileSync(this.openaiCredsPath(name), JSON.stringify(creds, null, 2));
  }

  getAccount(name: string): Account {
    const provider = this.providerFor(name);
    const oauth = provider === "anthropic" ? (this.readCreds(name)?.claudeAiOauth ?? null) : null;
    const openai = provider === "openai" ? this.getOpenAICreds(name) : null;
    const authenticated = provider === "openai" ? Boolean(openai?.accessToken) : Boolean(oauth?.accessToken);
    const tokenExpiresAt = (provider === "openai" ? openai?.expiresAt : oauth?.expiresAt) ?? null;
    const tokenExpired = tokenExpiresAt != null && tokenExpiresAt < Date.now();

    const usage = this.usageFor(name);
    const now = Date.now();
    const cooling = usage.rateLimitedUntil != null && usage.rateLimitedUntil > now;

    let available = true;
    let reason: string | null = null;
    if (!authenticated) {
      available = false;
      reason = "not authenticated — run `accounts login`";
    } else if (cooling) {
      available = false;
      const mins = Math.ceil((usage.rateLimitedUntil! - now) / 60000);
      reason = `rate limited — retry in ~${mins} min`;
    } else {
      const soft = exhaustedReason(usage.rateLimitStatus, now);
      if (soft) {
        available = false;
        reason = soft;
      }
    }

    return {
      name,
      configDir: this.configDirFor(name),
      provider,
      authenticated,
      subscriptionType: provider === "openai" ? (openai?.planType ?? "chatgpt") : (oauth?.subscriptionType ?? null),
      rateLimitTier: oauth?.rateLimitTier ?? null,
      scopes: oauth?.scopes ?? [],
      tokenExpiresAt,
      tokenExpired,
      usage,
      available,
      unavailableReason: reason,
    };
  }

  listAccounts(): Account[] {
    return this.listNames().map((n) => this.getAccount(n));
  }

  // ---- routing -----------------------------------------------------------

  /**
   * Pick an account to serve a request. Honors session affinity when the chosen
   * account is still available and not excluded; otherwise prefers the account
   * with the most real headroom left (per Anthropic's own rate-limit headers,
   * when we've seen one), falling back to fewest requests in the current
   * window for accounts we have no live headroom data for yet. Round-robin on
   * ties.
   *
   * @param exclude account names to skip (e.g. ones already tried this request
   *   during failover).
   * @param modelFamily canonical family of the requested model ("fable",
   *   "opus", …). Model-scoped unified windows (e.g. Fable's own, lower
   *   allowance) sideline an account for matching requests only — the account
   *   stays in rotation for other models — and count toward headroom scoring
   *   for matching requests.
   */
  pick(
    sessionKey?: string,
    exclude?: ReadonlySet<string>,
    provider: Provider = "anthropic",
    modelFamily?: string | null,
  ): Account | null {
    const now = Date.now();
    const family = modelFamily ?? null;
    const affinityKey = sessionKey ? `${provider}:${sessionKey}` : undefined;
    // Available = right provider, not excluded, and not sidelined for this
    // model family (Fable's model-scoped windows) nor otherwise unavailable.
    const usable = (a: Account): boolean =>
      a.available &&
      a.provider === provider &&
      !exclude?.has(a.name) &&
      modelExhaustedReason(a.usage.rateLimitStatus, family, now) == null;

    if (affinityKey) {
      const prior = this.sessionAffinity.get(affinityKey);
      if (prior && !exclude?.has(prior)) {
        const acct = this.getAccount(prior);
        if (usable(acct)) return acct;
        this.sessionAffinity.delete(affinityKey);
      }
    }

    const available = this.listAccounts().filter(usable);
    if (available.length === 0) return null;

    let best = available[0]!;
    let bestHeadroom = headroomFraction(best.usage, family);
    for (const a of available) {
      const headroom = headroomFraction(a.usage, family);
      if (
        headroom > bestHeadroom ||
        (headroom === bestHeadroom && a.usage.windowRequests < best.usage.windowRequests)
      ) {
        best = a;
        bestHeadroom = headroom;
      }
    }
    // Round-robin among the accounts tied for the best headroom + load.
    const minLoad = best.usage.windowRequests;
    const tied = available.filter(
      (a) => headroomFraction(a.usage, family) === bestHeadroom && a.usage.windowRequests === minLoad,
    );
    if (tied.length > 1) {
      best = tied[this.rrCursor % tied.length]!;
      this.rrCursor = (this.rrCursor + 1) % tied.length;
    }

    if (affinityKey) this.sessionAffinity.set(affinityKey, best.name);
    return best;
  }

  /** Pin a session to the account that actually served it (post-failover). */
  setAffinity(sessionKey: string, accountName: string, provider: Provider = "anthropic"): void {
    this.sessionAffinity.set(`${provider}:${sessionKey}`, accountName);
  }

  // ---- usage recording ---------------------------------------------------

  recordSuccess(name: string, usage: CliUsage, costUsd: number): void {
    const u = this.usageFor(name);
    const now = Date.now();
    u.windowRequests += 1;
    u.windowInputTokens += usage.input_tokens ?? 0;
    u.windowOutputTokens += usage.output_tokens ?? 0;
    u.windowCostUsd += costUsd;
    u.totalRequests += 1;
    u.totalInputTokens += usage.input_tokens ?? 0;
    u.totalOutputTokens += usage.output_tokens ?? 0;
    u.totalCostUsd += costUsd;
    u.lastUsedAt = now;
    u.lastError = null;
    this.saveState();
  }

  recordError(name: string, message: string): void {
    const u = this.usageFor(name);
    u.lastError = message.slice(0, 500);
    u.lastUsedAt = Date.now();
    this.saveState();
  }

  markRateLimited(name: string, resetAt?: number): void {
    const u = this.usageFor(name);
    u.rateLimitedUntil = resetAt ?? Date.now() + this.config.rateLimitCooldownMs;
    u.lastError = "rate limited by Anthropic";
    // Drop affinity so sessions reroute away from this account.
    for (const [k, v] of this.sessionAffinity) if (v === name) this.sessionAffinity.delete(k);
    this.saveState();
  }

  /**
   * Record Anthropic's latest rate-limit headroom snapshot for this account.
   * Merges by window key rather than replacing wholesale: a response only
   * carries headers for the window(s) relevant to that request (e.g. a
   * model-scoped Fable window may only appear on Fable requests), so a window
   * absent from the latest snapshot is presumed still in effect, not cleared.
   */
  recordRateLimitSnapshot(name: string, snapshot: RateLimitSnapshot): void {
    const u = this.usageFor(name);
    u.rateLimitStatus = mergeRateLimitSnapshot(u.rateLimitStatus, snapshot);
    this.saveState();
  }

  clearRateLimit(name: string): void {
    const u = this.usageFor(name);
    u.rateLimitedUntil = null;
    this.saveState();
  }

  /** True if any account holds a valid-looking login. */
  hasUsableAccount(): boolean {
    return this.listAccounts().some((a) => a.authenticated);
  }

  poolMtime(): number {
    try {
      return statSync(this.config.accountsDir).mtimeMs;
    } catch {
      return 0;
    }
  }
}

/**
 * Merges a freshly-parsed snapshot into the previously-recorded one, keyed by
 * window key. A window carried over from `prev` but absent from `next` is
 * kept as-is rather than dropped — the response that produced `next` simply
 * didn't report on that window (e.g. a Sonnet request's response has no
 * reason to include a Fable-scoped window), it doesn't mean the window no
 * longer applies.
 */
function mergeRateLimitSnapshot(
  prev: RateLimitSnapshot | null,
  next: RateLimitSnapshot,
): RateLimitSnapshot {
  const windows = new Map<string, RateLimitWindow>();
  for (const w of prev?.windows ?? []) windows.set(w.key, w);
  for (const w of next.windows) windows.set(w.key, w); // fresh data wins per key
  return {
    unifiedStatus: next.unifiedStatus ?? prev?.unifiedStatus ?? null,
    windows: sortRateLimitWindows([...windows.values()]),
    updatedAt: next.updatedAt,
  };
}

/**
 * Windows that bind for a request targeting `modelFamily`: account-wide
 * windows always do; model-scoped windows only when the request's model
 * matches (a spent Fable window shouldn't affect Sonnet traffic).
 */
function bindingWindows(rl: RateLimitSnapshot | null, modelFamily: string | null): RateLimitWindow[] {
  if (!rl?.windows) return [];
  return rl.windows.filter((w) => w.model == null || (modelFamily != null && w.model === modelFamily));
}

/**
 * Fraction of headroom [0, 1] left before Anthropic's own limits kick in,
 * derived from the tightest unified rolling window's utilization among the
 * windows that bind for this request's model (account-wide windows, plus any
 * window scoped to the requested model family). 1 (full headroom, i.e. no
 * penalty) when we have no live snapshot for this account yet — e.g. it just
 * joined the pool, or it's served via the CLI-subprocess backend, which has no
 * HTTP access to these headers.
 */
function headroomFraction(usage: AccountUsage, modelFamily: string | null): number {
  const utilizations = bindingWindows(usage.rateLimitStatus, modelFamily)
    .map((w) => w.utilization)
    .filter((u): u is number => u != null);
  if (utilizations.length === 0) return 1;
  // The window closest to full (highest utilization) is the binding constraint.
  return Math.max(0, 1 - Math.max(...utilizations));
}

/** A unified-window status that means the account can't currently serve traffic. */
function isBlockingStatus(status: string | null): boolean {
  if (!status) return false;
  const s = status.toLowerCase();
  return s === "rejected" || s === "blocked" || s === "exhausted";
}

/**
 * True (with a human-readable reason) when Anthropic reports one of `windows`
 * fully consumed (utilization ≥ 1) or explicitly blocked, and that window's
 * reset hasn't passed yet — i.e. the account is going to 429 if we route to
 * it, so sideline it proactively.
 */
function spentWindowReason(windows: RateLimitWindow[], now: number): string | null {
  for (const w of windows) {
    const spent = (w.utilization != null && w.utilization >= 1) || isBlockingStatus(w.status);
    if (spent && w.reset != null && w.reset > now) {
      const mins = Math.ceil((w.reset - now) / 60000);
      return `usage limit reached (${w.key} window) — resets in ~${mins} min`;
    }
  }
  return null;
}

/**
 * Account-wide exhaustion only — drives `Account.available`. Model-scoped
 * windows are deliberately excluded here: an account whose Fable allowance is
 * spent can still serve every other model, so it stays "available" and the
 * per-request model check in pick() handles the rest.
 */
function exhaustedReason(rl: RateLimitSnapshot | null, now: number): string | null {
  if (!rl) return null;
  return spentWindowReason((rl.windows ?? []).filter((w) => w.model == null), now);
}

/** Exhaustion of a window scoped to the requested model family, if any. */
function modelExhaustedReason(
  rl: RateLimitSnapshot | null,
  modelFamily: string | null,
  now: number,
): string | null {
  if (!rl || modelFamily == null) return null;
  return spentWindowReason((rl.windows ?? []).filter((w) => w.model === modelFamily), now);
}
