/**
 * SessionLedger: persistent session→account pins.
 *
 * Replaces the old in-memory sessionAffinity map. Each entry pins a caller
 * session (keyed "<provider>:<sessionKey>") to the account serving it, with a
 * lastSeenAt refreshed on every request. An entry idle longer than idleMs is
 * expired: it stops counting toward the account's active-session load and the
 * session re-routes fresh on its next request. Persisted to sessions.json so
 * pins and load counts survive a server restart — switching accounts
 * mid-session re-pays the full prompt-cache/context cost, so pins are precious.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import type { Provider } from "./types.ts";

export interface SessionEntry {
  account: string;
  provider: Provider;
  lastSeenAt: number;
}

interface PersistedSessions {
  sessions: Record<string, SessionEntry>;
}

export class SessionLedger {
  private entries = new Map<string, SessionEntry>();

  constructor(
    private filePath: string,
    private idleMs: number,
  ) {
    this.load();
  }

  private key(provider: Provider, sessionKey: string): string {
    return `${provider}:${sessionKey}`;
  }

  private isLive(e: SessionEntry, now: number): boolean {
    return now - e.lastSeenAt < this.idleMs;
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as PersistedSessions;
      const now = Date.now();
      for (const [k, e] of Object.entries(parsed.sessions ?? {})) {
        if (
          e != null &&
          typeof e.account === "string" &&
          typeof e.lastSeenAt === "number" &&
          this.isLive(e, now)
        ) {
          this.entries.set(k, e);
        }
      }
    } catch {
      // Corrupt ledger: start empty. Sessions re-pin on their next request.
    }
  }

  private save(): void {
    try {
      writeFileSync(
        this.filePath,
        JSON.stringify({ sessions: Object.fromEntries(this.entries) }, null, 2),
      );
    } catch {
      // Non-fatal: pins are best-effort across restarts.
    }
  }

  /** Account this session is pinned to, or null when unknown or idle-expired. */
  get(provider: Provider, sessionKey: string, now: number = Date.now()): string | null {
    const e = this.entries.get(this.key(provider, sessionKey));
    if (!e || !this.isLive(e, now)) return null;
    return e.account;
  }

  /** Create or refresh a pin and persist it. */
  touch(provider: Provider, sessionKey: string, account: string, now: number = Date.now()): void {
    this.entries.set(this.key(provider, sessionKey), { account, provider, lastSeenAt: now });
    this.save();
  }

  /** Drop every pin to this account (it went rate-limited/unusable). */
  evictAccount(account: string): void {
    let changed = false;
    for (const [k, e] of this.entries) {
      if (e.account === account) {
        this.entries.delete(k);
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /** Live pins pointing at this account — the routing load signal. */
  activeCount(account: string, now: number = Date.now()): number {
    let n = 0;
    for (const e of this.entries.values()) {
      if (e.account === account && this.isLive(e, now)) n += 1;
    }
    return n;
  }

  /** Delete expired entries; persists only when something was removed. */
  prune(now: number = Date.now()): void {
    let changed = false;
    for (const [k, e] of this.entries) {
      if (!this.isLive(e, now)) {
        this.entries.delete(k);
        changed = true;
      }
    }
    if (changed) this.save();
  }
}
