/**
 * AccountManager owns the pool of Claude accounts.
 *
 * Each account is a directory under <poolDir>/accounts/<name>/ with its own
 * Claude Code OAuth credentials. The manager reads each account's credentials
 * for status, tracks rolling usage, sidelines rate-limited accounts, and picks
 * which account should serve a given request, blending manual weight, expiry
 * urgency, active-session load, and headroom into one placement score by
 * default (see the `weighted` routing strategy).
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
import { emptyUsage, OPENAI_CREDS_FILENAME, normalizeRateLimitSnapshot, sortRateLimitWindows, windowDurationMs } from "./types.ts";
import {
  deleteKeychainCreds,
  keychainServiceForConfigDir,
  readKeychainCreds,
  readKeychainCredsForConfigDir,
} from "./keychain.ts";
import { SessionLedger } from "./sessions.ts";
import type { CliUsage } from "../subprocess/types.ts";

/** Priority assigned to any account without a routing.json. Lower = preferred. */
export const DEFAULT_PRIORITY = 100;

/**
 * The single source of truth for a valid priority value: a non-negative integer.
 * Shared by setPriority, the CLI, and the /api/routing handler so the rule can
 * only change in one place.
 */
export function isValidPriority(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

/** Manual routing weight bounds; a soft bias multiplier within a priority tier. */
export const DEFAULT_WEIGHT = 1;
export const MIN_WEIGHT = 0.1;
export const MAX_WEIGHT = 10;

/** The single source of truth for a valid weight: a finite number in [0.1, 10]. */
export function isValidWeight(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= MIN_WEIGHT && n <= MAX_WEIGHT;
}

/**
 * Live-editable knobs behind the `weighted` placement score. Persisted to
 * <poolDir>/tuning.json and editable from the dashboard, so the blend can be
 * retuned without a redeploy. See scoreWeighted for how each is applied.
 */
export interface RoutingTuning {
  /** Exponent on the 7d ("weekly") headroom factor. Higher = weekly matters more. */
  weeklyExp: number;
  /** Exponent on the 5h headroom factor. */
  fiveHourExp: number;
  /** Active-session load decay: 0 sessions → 1.0, 1 → 1/(1+slope), … */
  loadSlope: number;
  /** 7d-expiry urgency rank decay: soonest → 1.0, next → 1/(1+decay), … */
  urgencyDecay: number;
  /** Minimum gate headroom for an account to stay viable (else best-effort). */
  minHeadroom: number;
}

/**
 * Per-knob bounds. Exponents/slopes share a generous [0, 5] range (0 disables a
 * factor, 5 makes it dominate); minHeadroom is a fraction in [0, 1]. Each field
 * validates independently so one bad value never rejects the rest.
 */
export const TUNING_BOUNDS: Record<keyof RoutingTuning, { min: number; max: number }> = {
  weeklyExp: { min: 0, max: 5 },
  fiveHourExp: { min: 0, max: 5 },
  loadSlope: { min: 0, max: 5 },
  urgencyDecay: { min: 0, max: 5 },
  minHeadroom: { min: 0, max: 1 },
};

/** Defaults for the tuning knobs except minHeadroom, which seeds from config (env). */
const DEFAULT_TUNING_EXP: Omit<RoutingTuning, "minHeadroom"> = {
  weeklyExp: 1.5,
  fiveHourExp: 1,
  loadSlope: 0.5,
  urgencyDecay: 0.25,
};

/** True when `n` is a finite number within `key`'s bounds. */
export function isValidTuningField(key: keyof RoutingTuning, n: unknown): n is number {
  const b = TUNING_BOUNDS[key];
  return typeof n === "number" && Number.isFinite(n) && n >= b.min && n <= b.max;
}

/** One step of the routing decision, showing where the chosen account stood. */
export interface NextPickFactor {
  /** Short label, e.g. "Priority tier", "5h gate", "7d expiry", "Tie-break". */
  label: string;
  /** Human-readable detail with the actual values this step contributed. */
  detail: string;
  /** True for the step that actually determined the winner. */
  decisive: boolean;
}

/** Structured "why this account is next" for the dashboard/status. */
export interface NextPickReason {
  /** Compact one-line summary, kept for logs and narrow displays. */
  summary: string;
  /** Ordered decision steps (tier → gate → primary key → tie-break). */
  factors: NextPickFactor[];
}

/** Read-only view of the current routing decision, for the dashboard/status. */
export interface RoutingSnapshot {
  activeTier: number | null;
  nextPick: { account: string; reason: NextPickReason } | null;
  tiers: { priority: number; accounts: string[]; available: number }[];
  /** Per-candidate factor breakdown; present only for the weighted strategy. */
  candidates?: ({ account: string } & WeightedFactors)[];
}

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
  /** Persistent session→account pins + per-account active-session load. */
  private sessions: SessionLedger;
  /** Round-robin cursor for tie-breaking least-loaded selection. */
  private rrCursor = 0;
  private keychain: KeychainOps;
  /** Per-account routing.json cache, keyed to the file's mtime (see routingFileFor). */
  private routingCache = new Map<string, { mtimeMs: number; priority: number; weight: number }>();
  /** tuning.json cache, keyed to the file's mtime (see getTuning). */
  private tuningCache: { mtimeMs: number; tuning: RoutingTuning } | null = null;

  constructor(config: Config, keychain: KeychainOps = defaultKeychainOps) {
    this.config = config;
    this.keychain = keychain;
    this.sessions = new SessionLedger(config.sessionsFile, config.sessionIdleMs);
    mkdirSync(this.config.accountsDir, { recursive: true });
    this.loadState();
  }

  // ---- persistence -------------------------------------------------------

  private loadState(): void {
    if (!existsSync(this.config.usageFile)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.config.usageFile, "utf8")) as PersistedState;
      this.usage = this.pruneToLiveAccounts(parsed.usage ?? {});
      // Snapshots persisted by older pool versions used fixed 5h/7d fields.
      for (const u of Object.values(this.usage)) {
        u.rateLimitStatus = normalizeRateLimitSnapshot(u.rateLimitStatus);
      }
    } catch {
      this.usage = {};
    }
  }

  private saveState(): void {
    this.usage = this.pruneToLiveAccounts(this.usage);
    const state: PersistedState = { usage: this.usage };
    try {
      writeFileSync(this.config.usageFile, JSON.stringify(state, null, 2));
    } catch {
      // Non-fatal: usage stats are best-effort.
    }
  }

  /**
   * Drop usage entries for accounts no longer in the pool. A long-running
   * server process holds this map in memory for its whole lifetime and never
   * learns about an `accounts remove` that ran in a separate CLI process —
   * without this, the next saveState() call (triggered by recording usage
   * for any *other* account) would blindly rewrite usage.json with the
   * server's stale in-memory snapshot, resurrecting the removed account's
   * entry. Scoping usage validity to `listNames()` (the on-disk source of
   * truth) makes every write self-healing regardless of which process's
   * stale copy triggered it.
   */
  private pruneToLiveAccounts(usage: Record<string, AccountUsage>): Record<string, AccountUsage> {
    const live = new Set(this.listNames());
    const pruned: Record<string, AccountUsage> = {};
    for (const [name, u] of Object.entries(usage)) {
      if (live.has(name)) pruned[name] = u;
    }
    return pruned;
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

  private routingPath(name: string): string {
    return join(this.configDirFor(name), "routing.json");
  }

  /**
   * Routing priority for an account; lower = preferred. Cached per account and
   * invalidated by routing.json's mtime: a CLI edit in a separate process is
   * still seen by the running server (the file's mtime changes on write), but
   * the common unchanged case costs a single stat() instead of a read+parse on
   * every request. Returns DEFAULT_PRIORITY when the file is missing, unreadable,
   * or holds a non-integer/negative value — routing must never throw on this.
   */
  private routingFileFor(name: string): { priority: number; weight: number } {
    const fallback = { priority: DEFAULT_PRIORITY, weight: DEFAULT_WEIGHT };
    const path = this.routingPath(name);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      this.routingCache.delete(name);
      return fallback;
    }
    const cached = this.routingCache.get(name);
    if (cached && cached.mtimeMs === mtimeMs) return cached;
    let priority = DEFAULT_PRIORITY;
    let weight = DEFAULT_WEIGHT;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { priority?: unknown; weight?: unknown };
      if (isValidPriority(parsed.priority)) priority = parsed.priority;
      if (isValidWeight(parsed.weight)) weight = parsed.weight;
    } catch {
      /* fall through to defaults */
    }
    const entry = { mtimeMs, priority, weight };
    this.routingCache.set(name, entry);
    return entry;
  }

  priorityFor(name: string): number {
    return this.routingFileFor(name).priority;
  }

  /** Manual routing weight; soft score multiplier, default 1 (see DEFAULT_WEIGHT). */
  weightFor(name: string): number {
    return this.routingFileFor(name).weight;
  }

  setPriority(name: string, priority: number): void {
    if (!isValidPriority(priority)) {
      throw new Error(`Priority must be a non-negative integer, got ${priority}`);
    }
    this.writeRoutingField(name, { priority });
  }

  setWeight(name: string, weight: number): void {
    if (!isValidWeight(weight)) {
      throw new Error(`Weight must be a number between ${MIN_WEIGHT} and ${MAX_WEIGHT}, got ${weight}`);
    }
    this.writeRoutingField(name, { weight });
  }

  /** Merge one field into routing.json, preserving the other, then drop the cache. */
  private writeRoutingField(name: string, patch: { priority?: number; weight?: number }): void {
    if (!existsSync(this.configDirFor(name))) {
      throw new Error(`Account "${name}" does not exist`);
    }
    const current = this.routingFileFor(name);
    const next = { priority: current.priority, weight: current.weight, ...patch };
    writeFileSync(this.routingPath(name), JSON.stringify(next, null, 2));
    // Drop the cache so the next read re-parses even if the mtime is unchanged
    // (two writes within one filesystem mtime tick would otherwise look stale).
    this.routingCache.delete(name);
  }

  private tuningPath(): string {
    return join(this.config.poolDir, "tuning.json");
  }

  /** Default tuning; minHeadroom seeds from config so ROUTING_MIN_HEADROOM keeps working. */
  private tuningDefaults(): RoutingTuning {
    return { ...DEFAULT_TUNING_EXP, minHeadroom: this.config.routingMinHeadroom };
  }

  /**
   * Resolved routing tuning: defaults overlaid with any valid fields from
   * tuning.json. mtime-cached like routingFileFor so a live server sees an
   * external edit without re-parsing on every request. Each field validates
   * independently — a malformed value falls back to its default, never throwing.
   */
  getTuning(): RoutingTuning {
    const defaults = this.tuningDefaults();
    const path = this.tuningPath();
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      this.tuningCache = null;
      return defaults;
    }
    if (this.tuningCache && this.tuningCache.mtimeMs === mtimeMs) return this.tuningCache.tuning;
    const tuning = { ...defaults };
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Record<keyof RoutingTuning, unknown>>;
      for (const key of Object.keys(TUNING_BOUNDS) as (keyof RoutingTuning)[]) {
        if (isValidTuningField(key, parsed[key])) tuning[key] = parsed[key];
      }
    } catch {
      /* fall through to defaults */
    }
    this.tuningCache = { mtimeMs, tuning };
    return tuning;
  }

  /** Merge validated knobs into tuning.json, preserving the rest, then drop the cache. */
  setTuning(patch: Partial<RoutingTuning>): void {
    const current = this.getTuning();
    const next = { ...current };
    for (const key of Object.keys(patch) as (keyof RoutingTuning)[]) {
      const value = patch[key];
      if (value === undefined) continue;
      if (!isValidTuningField(key, value)) {
        const b = TUNING_BOUNDS[key];
        throw new Error(`${key} must be a number between ${b.min} and ${b.max}, got ${value}`);
      }
      next[key] = value;
    }
    writeFileSync(this.tuningPath(), JSON.stringify(next, null, 2));
    // Drop the cache so a second write within one mtime tick is still seen.
    this.tuningCache = null;
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
    // saveState()'s pruneToLiveAccounts() drops this account's usage entry
    // now that its directory is gone — no need to delete it here too.
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
      priority: this.priorityFor(name),
      weight: this.weightFor(name),
      activeSessions: this.sessions.activeCount(name),
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

  /** Serveable right now for this provider/model, honoring the failover exclude set. */
  private usableFor(
    a: Account,
    provider: Provider,
    family: string | null,
    now: number,
    exclude?: ReadonlySet<string>,
  ): boolean {
    return (
      a.available &&
      a.provider === provider &&
      !exclude?.has(a.name) &&
      modelExhaustedReason(a.usage.rateLimitStatus, family, now) == null
    );
  }

  /**
   * Pick an account to serve a request. A session with a live pin always stays
   * on its account (see the hard-pin block below); otherwise the default
   * `weighted` strategy scores each candidate on manual weight, expiry
   * urgency, active-session load, and headroom (see scoreWeighted), the
   * optional `expiring` strategy spends viable quota with the soonest known
   * reset first, and the optional `headroom` strategy prefers the
   * most-headroom account.
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

    const available = this.listAccounts().filter((a) => this.usableFor(a, provider, family, now, exclude));
    if (available.length === 0) return null;

    // Priority tiers: only spend the highest-priority (lowest number) tier that
    // still has an available account; hold lower tiers in reserve until it
    // drains. Failover re-picks with `exclude` populated, so once a tier's
    // accounts are all excluded/unavailable the next pick descends on its own.
    const minPriority = Math.min(...available.map((a) => a.priority));
    const tierPool = available.filter((a) => a.priority === minPriority);

    if (sessionKey) {
      const pinned = this.sessions.get(provider, sessionKey, now);
      if (pinned && !exclude?.has(pinned)) {
        const acct = this.getAccount(pinned);
        // Hard pin: switching accounts mid-session re-pays the full context
        // cost, so an existing session stays put while its account is usable
        // AND in the active tier — a session pinned to a fallback during a
        // primary outage must still move back once primary recovers.
        if (this.usableFor(acct, provider, family, now, exclude) && acct.priority === minPriority) {
          this.sessions.touch(provider, sessionKey, pinned, now);
          return acct;
        }
      }
    }

    const best =
      this.config.routingStrategy === "headroom"
        ? this.pickByHeadroom(tierPool, family, now)
        : this.config.routingStrategy === "expiring"
          ? this.pickByExpiringQuota(tierPool, family, now)
          : this.pickByWeighted(tierPool, family, now);
    if (sessionKey) this.sessions.touch(provider, sessionKey, best.name, now);
    return best;
  }

  private pickByHeadroom(available: Account[], family: string | null, now: number): Account {
    return this.pickRoundRobin(this.rankHeadroom(available, family, now));
  }

  private pickByExpiringQuota(available: Account[], family: string | null, now: number): Account {
    return this.pickRoundRobin(this.rankExpiring(available, family, now));
  }

  /**
   * The tied set of headroom-strategy winners (most headroom, then fewest
   * requests), in pool order. Pure ranking — no round-robin, no mutation — so
   * both pick() (via pickRoundRobin) and the read-only preview can share it and
   * never drift apart.
   */
  private rankHeadroom(pool: Account[], family: string | null, now: number): Account[] {
    let best = pool[0]!;
    let bestHeadroom = headroomFraction(best.usage, family, now);
    for (const a of pool) {
      const headroom = headroomFraction(a.usage, family, now);
      if (
        headroom > bestHeadroom ||
        (headroom === bestHeadroom && a.usage.windowRequests < best.usage.windowRequests)
      ) {
        best = a;
        bestHeadroom = headroom;
      }
    }
    const minLoad = best.usage.windowRequests;
    return pool.filter(
      (a) => headroomFraction(a.usage, family, now) === bestHeadroom && a.usage.windowRequests === minLoad,
    );
  }

  /**
   * Fully-ranked expiring-strategy candidates (best first). Viable candidates
   * (gate headroom ≥ min) are preferred; if none are viable we rank them all as
   * a best-effort fallback. Pure — no round-robin, no mutation — so pick() and
   * the read-only snapshot share one ordering and never drift.
   */
  private sortExpiringCandidates(pool: Account[], family: string | null, now: number): ExpiringCandidate[] {
    const candidates: ExpiringCandidate[] = pool.map((account) => {
      const gateHeadroom = candidateGateHeadroom(account.usage, family, now);
      return {
        account,
        gateHeadroom,
        expiryReset: candidateExpiryReset(account.usage, family, now),
        viable: gateHeadroom >= this.config.routingMinHeadroom,
      };
    });
    return [...viableFirst(candidates)].sort(compareExpiringCandidates);
  }

  /** The tied set of expiring winners (see sortExpiringCandidates), in ranked order. */
  private rankExpiring(pool: Account[], family: string | null, now: number): Account[] {
    const sorted = this.sortExpiringCandidates(pool, family, now);
    const best = sorted[0]!;
    return sorted.filter((c) => compareExpiringCandidates(c, best) === 0).map((c) => c.account);
  }

  /**
   * Weighted placement score for every tier-pool candidate:
   *   score = weight × urgency × loadFactor × headroom5h^fiveHourExp × weekly^weeklyExp
   * urgency is rank-based over 7d expiry (soonest first, nulls first to keep
   * probing unknown accounts), loadFactor decays with live pinned sessions,
   * headroom is the same 5h gate the expiring strategy uses, and `weekly` is the
   * remaining 7d headroom — the window the gate deliberately drains, weighted
   * here so the emptiest weekly allowance is preferred among eligible accounts.
   * Exponents/slopes come from getTuning(). Pure — no round-robin, no mutation —
   * shared by pick() and routingSnapshot().
   */
  private scoreWeighted(pool: Account[], family: string | null, now: number): WeightedCandidate[] {
    const tuning = this.getTuning();
    const resets = pool.map((a) => candidateExpiryReset(a.usage, family, now));
    // Rank distinct reset values (nulls collapse to one, equal timestamps share
    // a rank); a Map gives O(1) rank lookup instead of a linear scan per account.
    const distinct = [...new Set(resets)].sort(compareNullableReset);
    const rankByReset = new Map(distinct.map((r, i) => [r, i] as const));

    return pool.map((account, i) => {
      const expiryReset = resets[i]!;
      const urgency = 1 / (1 + rankByReset.get(expiryReset)! * tuning.urgencyDecay);
      const headroom = candidateGateHeadroom(account.usage, family, now);
      const weeklyHeadroom = candidateExpiryHeadroom(account.usage, family, now);
      const loadFactor = 1 / (1 + this.sessions.activeCount(account.name, now) * tuning.loadSlope);
      const weight = this.weightFor(account.name);
      const score =
        weight * urgency * loadFactor * headroom ** tuning.fiveHourExp * weeklyHeadroom ** tuning.weeklyExp;
      return {
        account,
        expiryReset,
        weight,
        urgency,
        loadFactor,
        headroom,
        weeklyHeadroom,
        score,
        viable: headroom >= tuning.minHeadroom,
      };
    });
  }

  /** Rank already-scored candidates best-first: viable subset when any is viable. */
  private rankWeighted(scored: WeightedCandidate[]): WeightedCandidate[] {
    return [...viableFirst(scored)].sort((a, b) => b.score - a.score);
  }

  /** Weighted candidates best-first: viable subset when any is viable, sorted by score. */
  private sortWeightedCandidates(pool: Account[], family: string | null, now: number): WeightedCandidate[] {
    return this.rankWeighted(this.scoreWeighted(pool, family, now));
  }

  private pickByWeighted(pool: Account[], family: string | null, now: number): Account {
    const sorted = this.sortWeightedCandidates(pool, family, now);
    const best = sorted[0]!;
    const tied = sorted.filter((c) => c.score === best.score).map((c) => c.account);
    return this.pickRoundRobin(tied);
  }

  private pickRoundRobin(tied: Account[]): Account {
    if (tied.length <= 1) return tied[0]!;
    const best = tied[this.rrCursor % tied.length]!;
    this.rrCursor = (this.rrCursor + 1) % tied.length;
    return best;
  }

  /**
   * Current routing decision for one provider: every tier (grouped by priority,
   * with an available count), the active tier, and the account that would serve
   * the next non-sticky request with a human-readable reason. The decision is
   * model-agnostic (family = null): it describes general routing, not a specific
   * model's windows.
   */
  routingSnapshot(provider: Provider = "anthropic", now: number = Date.now()): RoutingSnapshot {
    const family: string | null = null;
    const accounts = this.listAccounts().filter((a) => a.provider === provider);

    const byPriority = new Map<number, Account[]>();
    for (const a of accounts) {
      const list = byPriority.get(a.priority) ?? [];
      list.push(a);
      byPriority.set(a.priority, list);
    }
    const tiers = [...byPriority.entries()]
      .sort((x, y) => x[0] - y[0])
      .map(([priority, accts]) => ({
        priority,
        accounts: accts.map((a) => a.name),
        available: accts.filter((a) => this.usableFor(a, provider, family, now)).length,
      }));

    const available = accounts.filter((a) => this.usableFor(a, provider, family, now));
    if (available.length === 0) return { activeTier: null, nextPick: null, tiers };

    const minPriority = Math.min(...available.map((a) => a.priority));
    const tierPool = available.filter((a) => a.priority === minPriority);
    const reserveTiers = tiers.map((t) => t.priority).filter((p) => p > minPriority);

    let best: Account;
    let reason: NextPickReason;
    let candidates: RoutingSnapshot["candidates"];
    if (this.config.routingStrategy === "headroom") {
      // Same winner as pickByHeadroom (max headroom, then fewest requests); a
      // deterministic sort standing in for rankHeadroom + first-in-pool-order.
      const ranked = tierPool
        .map((a) => ({ account: a, headroom: headroomFraction(a.usage, family, now) }))
        .sort((x, y) => y.headroom - x.headroom || x.account.usage.windowRequests - y.account.usage.windowRequests);
      best = ranked[0]!.account;
      reason = buildHeadroomReason(minPriority, reserveTiers, tierPool.length, ranked);
    } else if (this.config.routingStrategy === "expiring") {
      const ranked = this.sortExpiringCandidates(tierPool, family, now);
      best = ranked[0]!.account;
      reason = buildExpiringReason(minPriority, reserveTiers, this.config.routingMinHeadroom, ranked, now, tierPool.length);
    } else {
      const scored = this.scoreWeighted(tierPool, family, now);
      const ranked = this.rankWeighted(scored);
      best = ranked[0]!.account;
      reason = buildWeightedReason(minPriority, reserveTiers, ranked, now, tierPool.length, this.getTuning());
      candidates = scored.map((c) => ({
        account: c.account.name,
        weight: c.weight,
        urgency: c.urgency,
        loadFactor: c.loadFactor,
        headroom: c.headroom,
        weeklyHeadroom: c.weeklyHeadroom,
        score: c.score,
      }));
    }
    return { activeTier: minPriority, nextPick: { account: best.name, reason }, tiers, candidates };
  }

  /** Pin a session to the account that actually served it (post-failover). */
  setAffinity(sessionKey: string, accountName: string, provider: Provider = "anthropic"): void {
    this.sessions.touch(provider, sessionKey, accountName);
  }

  /** Expire idle session pins; called periodically by the server. */
  pruneSessions(): void {
    this.sessions.prune();
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
    const now = Date.now();
    u.rateLimitedUntil =
      resetAt ?? blockingWindowReset(u.rateLimitStatus, now) ?? now + this.config.rateLimitCooldownMs;
    u.lastError = "rate limited by Anthropic";
    // Drop pins so sessions reroute away from this account.
    this.sessions.evictAccount(name);
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

/** Terse human ETA for a future timestamp delta in ms: "41m", "~3.5h", "~2.6d". */
function formatEta(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 90) return `${Math.max(0, min)}m`;
  const hours = ms / 3_600_000;
  if (hours < 24) return `~${hours.toFixed(1)}h`;
  return `~${(ms / 86_400_000).toFixed(1)}d`;
}

/** Shared "Priority tier" factor for both strategies. */
function tierFactor(activeTier: number, tierCount: number, reserveTiers: number[]): NextPickFactor {
  const accts = `${tierCount} account${tierCount === 1 ? "" : "s"}`;
  const reserve = reserveTiers.length
    ? `tier${reserveTiers.length === 1 ? "" : "s"} ${reserveTiers.join(", ")} held in reserve`
    : "no lower tiers in reserve";
  return { label: "Priority tier", detail: `${activeTier} active (${accts}) · ${reserve}`, decisive: reserveTiers.length > 0 };
}

/** Build the structured reason for the expiring strategy from ranked candidates. */
function buildExpiringReason(
  activeTier: number,
  reserveTiers: number[],
  minHeadroom: number,
  ranked: ExpiringCandidate[],
  now: number,
  poolSize: number,
): NextPickReason {
  const chosen = ranked[0]!;
  const runnerUp = ranked[1] ?? null;
  // sortExpiringCandidates() pre-filters to the viable subset whenever any
  // candidate is viable (falling back to the full pool only when none are),
  // so `ranked` alone can't distinguish "1 of 1 eligible" from "1 of 2
  // eligible". `poolSize` carries the true tier-pool size for that count.
  const eligible = chosen.viable ? ranked.length : 0;
  const pool = poolSize;

  const chosenPct = Math.round(chosen.gateHeadroom * 100);
  const minPct = Math.round(minHeadroom * 100);
  const gateFactor: NextPickFactor = {
    label: "5h gate",
    detail: `${eligible}/${pool} eligible (≥${minPct}% headroom) · chosen ${chosenPct}% headroom`,
    decisive: eligible < pool,
  };

  let chosenEta: string;
  if (chosen.expiryReset != null) {
    chosenEta = `resets in ${formatEta(chosen.expiryReset - now)}`;
  } else if (chosen.account.usage.rateLimitStatus == null) {
    chosenEta = "no live window data yet — probing to refresh headers";
  } else {
    chosenEta = "prior window data expired — probing to refresh";
  }
  let nextPart = "";
  if (runnerUp) {
    nextPart = runnerUp.expiryReset != null
      ? ` (next: ${runnerUp.account.name} ${formatEta(runnerUp.expiryReset - now)})`
      : ` (next: ${runnerUp.account.name} no reset data)`;
  }
  const resetDecisive = runnerUp != null && compareNullableReset(chosen.expiryReset, runnerUp.expiryReset) !== 0;
  const expiryFactor: NextPickFactor = {
    label: "7d expiry",
    detail: `${chosenEta} · soonest eligible${nextPart}`,
    decisive: resetDecisive,
  };

  let tiebreakDetail = "not needed";
  let tiebreakDecisive = false;
  if (runnerUp && !resetDecisive) {
    let rule: string;
    if (chosen.gateHeadroom !== runnerUp.gateHeadroom) rule = "more 5h headroom";
    else if (chosen.account.usage.windowRequests !== runnerUp.account.usage.windowRequests) rule = "fewer requests";
    else rule = "round-robin";
    tiebreakDetail = `broke tie on ${rule}`;
    tiebreakDecisive = true;
  }
  const tiebreakFactor: NextPickFactor = { label: "Tie-break", detail: tiebreakDetail, decisive: tiebreakDecisive };

  const summary = `tier ${activeTier} · ${chosen.expiryReset != null ? `7d resets in ${formatEta(chosen.expiryReset - now)}` : "no 7d data"} · ${chosenPct}% 5h headroom`;
  return { summary, factors: [tierFactor(activeTier, pool, reserveTiers), gateFactor, expiryFactor, tiebreakFactor] };
}

/** Build the structured reason for the weighted strategy from ranked candidates. */
function buildWeightedReason(
  activeTier: number,
  reserveTiers: number[],
  ranked: WeightedCandidate[],
  now: number,
  poolSize: number,
  tuning: RoutingTuning,
): NextPickReason {
  const chosen = ranked[0]!;
  const runnerUp = ranked[1] ?? null;
  const f = (n: number) => n.toFixed(2);
  // Post-exponent effective factor values, so the shown numbers still multiply
  // to the score (h5 = 5h headroom, h7 = weekly/7d headroom).
  const h5 = chosen.headroom ** tuning.fiveHourExp;
  const h7 = chosen.weeklyHeadroom ** tuning.weeklyExp;

  const expiryDetail =
    chosen.expiryReset != null
      ? `7d resets in ${formatEta(chosen.expiryReset - now)}`
      : "no 7d reset data — probing";
  const expiryFactor: NextPickFactor = {
    label: "7d expiry",
    detail: `${expiryDetail} · urgency ${f(chosen.urgency)}`,
    decisive: false,
  };
  const scoreDecisive = runnerUp != null && chosen.score !== runnerUp.score;
  const scoreFactor: NextPickFactor = {
    label: "Score",
    detail:
      `${f(chosen.weight)}w × ${f(chosen.urgency)}u × ${f(chosen.loadFactor)}l × ${f(h5)}h5 × ${f(h7)}h7 = ${f(chosen.score)}` +
      (runnerUp ? ` (next: ${runnerUp.account.name} ${f(runnerUp.score)})` : ""),
    decisive: scoreDecisive,
  };
  const tiebreakFactor: NextPickFactor = {
    label: "Tie-break",
    detail: runnerUp && !scoreDecisive ? "round-robin among tied scores" : "not needed",
    decisive: runnerUp != null && !scoreDecisive,
  };
  const summary = `tier ${activeTier} · score ${f(chosen.score)} · ${expiryDetail}`;
  return {
    summary,
    factors: [tierFactor(activeTier, poolSize, reserveTiers), expiryFactor, scoreFactor, tiebreakFactor],
  };
}

/** Build a compact structured reason for the headroom strategy. */
function buildHeadroomReason(
  activeTier: number,
  reserveTiers: number[],
  tierCount: number,
  ranked: { account: Account; headroom: number }[],
): NextPickReason {
  const chosen = ranked[0]!;
  const runnerUp = ranked[1] ?? null;
  const chosenPct = Math.round(chosen.headroom * 100);
  const primaryDecisive = runnerUp != null && chosen.headroom !== runnerUp.headroom;
  const primary: NextPickFactor = {
    label: "Most headroom",
    detail: `chosen ${chosenPct}% headroom${runnerUp ? ` (next: ${runnerUp.account.name} ${Math.round(runnerUp.headroom * 100)}%)` : ""}`,
    decisive: primaryDecisive,
  };
  let tiebreakDetail = "not needed";
  let tiebreakDecisive = false;
  if (runnerUp && !primaryDecisive) {
    tiebreakDetail =
      chosen.account.usage.windowRequests !== runnerUp.account.usage.windowRequests
        ? "broke tie on fewer requests"
        : "broke tie on round-robin among ties";
    tiebreakDecisive = true;
  }
  const tiebreak: NextPickFactor = { label: "Tie-break", detail: tiebreakDetail, decisive: tiebreakDecisive };
  const summary = `tier ${activeTier} · ${chosenPct}% headroom`;
  return { summary, factors: [tierFactor(activeTier, tierCount, reserveTiers), primary, tiebreak] };
}

/**
 * Windows that bind for a request targeting `modelFamily`: account-wide
 * windows always do; model-scoped windows only when the request's model
 * matches (a spent Fable window shouldn't affect Sonnet traffic).
 */
function bindingWindows(
  rl: RateLimitSnapshot | null,
  modelFamily: string | null,
  now: number,
): RateLimitWindow[] {
  if (!rl?.windows) return [];
  return rl.windows
    .filter((w) => w.model == null || (modelFamily != null && w.model === modelFamily))
    .filter((w) => w.reset == null || w.reset > now);
}

/** Factor breakdown behind one weighted-strategy candidate's score. */
export interface WeightedFactors {
  weight: number;
  urgency: number;
  loadFactor: number;
  /** Remaining 5h gate headroom (raw, pre-exponent). */
  headroom: number;
  /** Remaining 7d/weekly headroom (raw, pre-exponent). */
  weeklyHeadroom: number;
  score: number;
}

interface WeightedCandidate extends WeightedFactors {
  account: Account;
  expiryReset: number | null;
  viable: boolean;
}

interface ExpiringCandidate {
  account: Account;
  gateHeadroom: number;
  expiryReset: number | null;
  viable: boolean;
}

/**
 * Prefer candidates that clear the headroom gate; fall back to the whole pool
 * only when none are viable (best-effort, so a request is never stranded).
 * Shared by the expiring and weighted strategies.
 */
function viableFirst<T extends { viable: boolean }>(candidates: T[]): T[] {
  const viable = candidates.filter((c) => c.viable);
  return viable.length > 0 ? viable : candidates;
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
function headroomFraction(usage: AccountUsage, modelFamily: string | null, now: number): number {
  return candidateMinHeadroom(usage, modelFamily, now);
}

/**
 * Remaining headroom [0, 1] over a window set: 1 minus the highest utilization
 * seen (the window closest to full is the binding constraint), or 1 (full) when
 * no window reports a utilization.
 */
function headroomOf(windows: RateLimitWindow[]): number {
  const utilizations = windows.map((w) => w.utilization).filter((u): u is number => u != null);
  if (utilizations.length === 0) return 1;
  return Math.max(0, 1 - Math.max(...utilizations));
}

function candidateMinHeadroom(usage: AccountUsage, modelFamily: string | null, now: number): number {
  return headroomOf(bindingWindows(usage.rateLimitStatus, modelFamily, now));
}

/**
 * The "expiry" window for a request is the longest-duration binding window
 * (account-wide 7d, or a model-scoped 7d-<model> when it is the longest for a
 * model request). Its reset — soonest among any duration ties, and only when in
 * the future and not fully spent — is the primary ranking key: the soonest to
 * roll over is spent first so its allowance isn't wasted. null when unknown.
 */
function candidateExpiryReset(usage: AccountUsage, modelFamily: string | null, now: number): number | null {
  const windows = bindingWindows(usage.rateLimitStatus, modelFamily, now);
  const maxDur = Math.max(-1, ...windows.map((w) => windowDurationMs(w.key) ?? -1));
  if (maxDur < 0) return null;
  const resets = windows
    .filter((w) => (windowDurationMs(w.key) ?? -1) === maxDur)
    .filter((w) => w.reset != null && w.reset > now && (w.utilization == null || w.utilization < 1))
    .map((w) => w.reset!);
  return resets.length > 0 ? Math.min(...resets) : null;
}

/**
 * Headroom [0, 1] that gates eligibility and breaks headroom ties for the
 * expiring strategy: the tightest binding window EXCEPT the account-wide expiry
 * (longest-duration account-wide) window, which is deliberately excluded so we
 * keep draining it ("pending headroom on the 5-hour window", not the 7-day one).
 * The exclusion only applies when a shorter account-wide window also exists, so
 * a lone 5h window still gates. 1 (full) when the gate set is empty / no snapshot.
 */
function candidateGateHeadroom(usage: AccountUsage, modelFamily: string | null, now: number): number {
  const windows = bindingWindows(usage.rateLimitStatus, modelFamily, now);
  const accountWide = windows.filter((w) => w.model == null);
  let excluded: RateLimitWindow | null = null;
  if (accountWide.length >= 2) {
    excluded = accountWide.reduce((a, w) =>
      (windowDurationMs(w.key) ?? -1) > (windowDurationMs(a.key) ?? -1) ? w : a,
    );
  }
  return headroomOf(windows.filter((w) => w !== excluded));
}

/**
 * Remaining headroom [0, 1] of the account-wide "expiry" window — the
 * longest-duration account-wide binding window (typically 7d), i.e. exactly the
 * one candidateGateHeadroom excludes. The weighted strategy prefers the account
 * with the most weekly room; the gate ignores this window, so the two compose
 * (gate for eligibility, this for preference). 1 (full, no penalty) when that
 * window is absent or reports no utilization / no snapshot.
 */
function candidateExpiryHeadroom(usage: AccountUsage, modelFamily: string | null, now: number): number {
  const accountWide = bindingWindows(usage.rateLimitStatus, modelFamily, now).filter((w) => w.model == null);
  // Mirror candidateGateHeadroom: a lone account-wide window IS the gate window,
  // so there is no separate expiry/7d window — return full (no double-counting).
  if (accountWide.length < 2) return 1;
  const expiry = accountWide.reduce((a, w) =>
    (windowDurationMs(w.key) ?? -1) > (windowDurationMs(a.key) ?? -1) ? w : a,
  );
  return headroomOf([expiry]);
}

function compareNullableReset(a: number | null, b: number | null): number {
  if (a != null && b != null) return a - b;
  if (a == null && b == null) return 0;
  // null == "no usable expiry data" -> probe it first to refresh real headers.
  return a == null ? -1 : 1;
}

function compareExpiringCandidates(a: ExpiringCandidate, b: ExpiringCandidate): number {
  const reset = compareNullableReset(a.expiryReset, b.expiryReset);
  if (reset !== 0) return reset;
  if (a.gateHeadroom !== b.gateHeadroom) return b.gateHeadroom - a.gateHeadroom;
  if (a.account.usage.windowRequests !== b.account.usage.windowRequests) {
    return a.account.usage.windowRequests - b.account.usage.windowRequests;
  }
  return 0;
}

/** A unified-window status that means the account can't currently serve traffic. */
function isBlockingStatus(status: string | null): boolean {
  if (!status) return false;
  const s = status.toLowerCase();
  return s === "rejected" || s === "blocked" || s === "exhausted";
}

/**
 * Soonest future reset among windows Anthropic currently reports as blocking
 * (fully consumed or explicitly rejected). Used as markRateLimited's fallback
 * when the 429 carried no explicit reset — the snapshot recorded moments
 * earlier on the same request already knows the real reset. null when no
 * blocking window has a future reset.
 */
function blockingWindowReset(rl: RateLimitSnapshot | null, now: number): number | null {
  if (!rl?.windows) return null;
  const resets = rl.windows
    .filter((w) => (w.utilization != null && w.utilization >= 1) || isBlockingStatus(w.status))
    .filter((w) => w.reset != null && w.reset > now)
    .map((w) => w.reset!);
  return resets.length > 0 ? Math.min(...resets) : null;
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
