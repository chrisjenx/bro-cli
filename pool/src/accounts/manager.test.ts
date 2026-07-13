import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig, type Config } from "../config.ts";
import { AccountManager, type KeychainOps, DEFAULT_WEIGHT, isValidWeight } from "./manager.ts";
import type { RateLimitSnapshot, RateLimitWindow } from "./types.ts";
import { OPENAI_CREDS_FILENAME } from "./types.ts";

function tempPool(
  accountNames: string[],
  keychain?: KeychainOps,
  overrides: Partial<Config> = {},
): { poolDir: string; mgr: AccountManager } {
  const poolDir = mkdtempSync(join(tmpdir(), "cmp-manager-"));
  const accountsDir = join(poolDir, "accounts");
  for (const name of accountNames) {
    const dir = join(accountsDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "tok-" + name,
          refreshToken: "r",
          expiresAt: Date.now() + 3_600_000,
          subscriptionType: "max",
          rateLimitTier: "default_claude_max_5x",
        },
      }),
    );
  }
  const config = loadConfig({
    poolDir,
    accountsDir,
    usageFile: join(poolDir, "usage.json"),
    sessionsFile: join(poolDir, "sessions.json"),
    routingStrategy: "expiring",
    ...overrides,
  });
  return { poolDir, mgr: keychain ? new AccountManager(config, keychain) : new AccountManager(config) };
}

function win(key: string, overrides: Partial<RateLimitWindow> = {}): RateLimitWindow {
  const model = key.split(/[-_]/).find((t) => !/^\d/.test(t)) ?? null;
  return { key, model, status: "allowed", utilization: null, reset: null, ...overrides };
}

function snapshot(windows: RateLimitWindow[]): RateLimitSnapshot {
  return { unifiedStatus: "allowed", windows, updatedAt: Date.now() };
}

test("pick() prefers the account with more real headroom over pure round-robin", async () => {
  const { poolDir, mgr } = tempPool(["low-headroom", "high-headroom"]);
  try {
    // low-headroom has burned 95% of its 5h window; high-headroom only 10%.
    mgr.recordRateLimitSnapshot(
      "low-headroom",
      snapshot([win("5h", { utilization: 0.95 }), win("7d", { utilization: 0.5 })]),
    );
    mgr.recordRateLimitSnapshot(
      "high-headroom",
      snapshot([win("5h", { utilization: 0.1 }), win("7d", { utilization: 0.2 })]),
    );

    const picked = mgr.pick();
    expect(picked?.name).toBe("high-headroom");
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("accounts with no snapshot yet are treated as full headroom in headroom strategy", async () => {
  const { poolDir, mgr } = tempPool(["no-data", "known-partial"], undefined, { routingStrategy: "headroom" });
  try {
    mgr.recordRateLimitSnapshot(
      "known-partial",
      snapshot([win("5h", { utilization: 0.5 }), win("7d", { utilization: 0.5 })]),
    );

    const picked = mgr.pick();
    expect(picked?.name).toBe("no-data");
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("pick() prefers soonest-resetting quota when accounts have enough headroom", async () => {
  const { poolDir, mgr } = tempPool(["soon", "later"]);
  try {
    const now = Date.now();
    mgr.recordRateLimitSnapshot("soon", snapshot([win("5h", { utilization: 0.5, reset: now + 30 * 60_000 })]));
    mgr.recordRateLimitSnapshot("later", snapshot([win("5h", { utilization: 0.1, reset: now + 5 * 60 * 60_000 })]));

    expect(mgr.pick()?.name).toBe("soon");
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("pick() skips soonest-resetting quota when it is below minimum headroom", async () => {
  const { poolDir, mgr } = tempPool(["soon-low", "later-ok"]);
  try {
    const now = Date.now();
    mgr.recordRateLimitSnapshot("soon-low", snapshot([win("5h", { utilization: 0.95, reset: now + 10 * 60_000 })]));
    mgr.recordRateLimitSnapshot("later-ok", snapshot([win("5h", { utilization: 0.3, reset: now + 5 * 60 * 60_000 })]));

    expect(mgr.pick()?.name).toBe("later-ok");
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("expiring: ranks by soonest 7d reset even when 5h resets are ordered the opposite way", () => {
  const { poolDir, mgr } = tempPool(["burn-me", "keep"]);
  try {
    const now = Date.now();
    // burn-me: 5h resets LATER, but its 7d window expires SOONER -> should win.
    mgr.recordRateLimitSnapshot(
      "burn-me",
      snapshot([
        win("5h", { utilization: 0.2, reset: now + 4 * 60 * 60_000 }),
        win("7d", { utilization: 0.3, reset: now + 2 * 86_400_000 }),
      ]),
    );
    // keep: 5h resets sooner (old code would pick this), but 7d expires later.
    mgr.recordRateLimitSnapshot(
      "keep",
      snapshot([
        win("5h", { utilization: 0.2, reset: now + 20 * 60_000 }),
        win("7d", { utilization: 0.3, reset: now + 5 * 86_400_000 }),
      ]),
    );

    expect(mgr.pick()?.name).toBe("burn-me");
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("expiring: a nearly-spent account-wide 7d does NOT bench the account (7d excluded from the gate)", () => {
  const { poolDir, mgr } = tempPool(["almost-out", "fresh"]);
  try {
    const now = Date.now();
    // almost-out: 7d 95% used (headroom 0.05) but healthy 5h, and expires soonest.
    mgr.recordRateLimitSnapshot(
      "almost-out",
      snapshot([
        win("5h", { utilization: 0.2, reset: now + 60 * 60_000 }),
        win("7d", { utilization: 0.95, reset: now + 1 * 86_400_000 }),
      ]),
    );
    mgr.recordRateLimitSnapshot(
      "fresh",
      snapshot([
        win("5h", { utilization: 0.2, reset: now + 60 * 60_000 }),
        win("7d", { utilization: 0.1, reset: now + 5 * 86_400_000 }),
      ]),
    );

    // Old min-across-all gate would bench almost-out (min headroom 0.05 < 0.1);
    // the new gate ignores the account-wide 7d, so it stays viable and wins.
    expect(mgr.pick()?.name).toBe("almost-out");
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("expiring: soonest-7d account is skipped when its 5h headroom is below the minimum", () => {
  const { poolDir, mgr } = tempPool(["soon-but-hot", "later-ok"]);
  try {
    const now = Date.now();
    mgr.recordRateLimitSnapshot(
      "soon-but-hot",
      snapshot([
        win("5h", { utilization: 0.95, reset: now + 60 * 60_000 }),
        win("7d", { utilization: 0.2, reset: now + 1 * 86_400_000 }),
      ]),
    );
    mgr.recordRateLimitSnapshot(
      "later-ok",
      snapshot([
        win("5h", { utilization: 0.3, reset: now + 60 * 60_000 }),
        win("7d", { utilization: 0.2, reset: now + 5 * 86_400_000 }),
      ]),
    );

    expect(mgr.pick()?.name).toBe("later-ok");
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("expiring: a stale 5h window does not bench an account with a healthy live 7d", () => {
  const { poolDir, mgr } = tempPool(["stale-5h", "fresh-5h"]);
  try {
    const now = Date.now();
    // stale-5h: 5h looks 97% spent but its reset is in the PAST (rolled over);
    // its live 7d expires SOONEST -> should win once the stale 5h is ignored.
    mgr.recordRateLimitSnapshot(
      "stale-5h",
      snapshot([
        win("5h", { utilization: 0.97, reset: now - 60 * 60_000 }),
        win("7d", { utilization: 0.3, reset: now + 1 * 86_400_000 }),
      ]),
    );
    // fresh-5h: healthy live 5h, but its 7d expires LATER.
    mgr.recordRateLimitSnapshot(
      "fresh-5h",
      snapshot([
        win("5h", { utilization: 0.2, reset: now + 3 * 60 * 60_000 }),
        win("7d", { utilization: 0.3, reset: now + 3 * 86_400_000 }),
      ]),
    );

    // Without the staleness fix, stale-5h's gate headroom is ~0.03 (< default
    // 0.1 min) -> benched -> fresh-5h picked. With the fix, the stale 5h is
    // dropped, stale-5h is viable, and its sooner 7d reset wins.
    expect(mgr.pick()?.name).toBe("stale-5h");
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("expiring: stale windows are ignored after a cold reload from usage.json", () => {
  const { poolDir, mgr } = tempPool(["stale-5h", "fresh-5h"]);
  try {
    const now = Date.now();
    // recordRateLimitSnapshot writes usage.json each time.
    mgr.recordRateLimitSnapshot(
      "stale-5h",
      snapshot([
        win("5h", { utilization: 0.97, reset: now - 60 * 60_000 }),
        win("7d", { utilization: 0.3, reset: now + 1 * 86_400_000 }),
      ]),
    );
    mgr.recordRateLimitSnapshot(
      "fresh-5h",
      snapshot([
        win("5h", { utilization: 0.2, reset: now + 3 * 60 * 60_000 }),
        win("7d", { utilization: 0.3, reset: now + 3 * 86_400_000 }),
      ]),
    );

    // Fresh manager on the same pool dir -> loadState() reads usage.json.
    const config = loadConfig({
      poolDir,
      accountsDir: join(poolDir, "accounts"),
      usageFile: join(poolDir, "usage.json"),
      sessionsFile: join(poolDir, "sessions.json"),
    });
    const reloaded = new AccountManager(config);
    expect(reloaded.pick()?.name).toBe("stale-5h");
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("model-family reset timing only applies to matching model requests", async () => {
  const { poolDir, mgr } = tempPool(["fable-soon", "fable-later"]);
  try {
    const now = Date.now();
    mgr.recordRateLimitSnapshot(
      "fable-soon",
      snapshot([
        win("5h", { utilization: 0.2, reset: now + 5 * 60 * 60_000 }),
        win("7d-fable", { utilization: 0.5, reset: now + 30 * 60_000 }),
      ]),
    );
    mgr.recordRateLimitSnapshot(
      "fable-later",
      snapshot([
        win("5h", { utilization: 0.1, reset: now + 60 * 60_000 }),
        win("7d-fable", { utilization: 0.1, reset: now + 5 * 60 * 60_000 }),
      ]),
    );

    expect(mgr.pick(undefined, undefined, "anthropic", "fable")?.name).toBe("fable-soon");
    expect(mgr.pick(undefined, undefined, "anthropic", "sonnet")?.name).toBe("fable-later");
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("expiring: session pin is a hard pin and beats better expiring quota", async () => {
  const { poolDir, mgr } = tempPool(["soon", "later"]);
  try {
    const now = Date.now();
    mgr.setAffinity("session-1", "later");
    mgr.recordRateLimitSnapshot("soon", snapshot([win("5h", { utilization: 0.5, reset: now + 30 * 60_000 })]));
    mgr.recordRateLimitSnapshot("later", snapshot([win("5h", { utilization: 0.1, reset: now + 5 * 60 * 60_000 })]));

    // "soon" has better expiring quota, but the pin to "later" is hard now.
    expect(mgr.pick("session-1")?.name).toBe("later");
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("session affinity wins among tied expiring-quota candidates", async () => {
  const { poolDir, mgr } = tempPool(["a", "b"]);
  try {
    const now = Date.now();
    mgr.setAffinity("session-1", "b");
    mgr.recordRateLimitSnapshot("a", snapshot([win("5h", { utilization: 0.2, reset: now + 60 * 60_000 })]));
    mgr.recordRateLimitSnapshot("b", snapshot([win("5h", { utilization: 0.2, reset: now + 60 * 60_000 })]));

    expect(mgr.pick("session-1")?.name).toBe("b");
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("expiring: an account with no window data is probed first (before a known reset)", async () => {
  const withKnown = tempPool(["known-soon", "unknown"]);
  try {
    const now = Date.now();
    withKnown.mgr.recordRateLimitSnapshot(
      "known-soon",
      snapshot([win("5h", { utilization: 0.5, reset: now + 30 * 60_000 })]),
    );

    // "unknown" has no snapshot -> expiryReset null -> probe-first picks it so
    // its real headers get refreshed.
    expect(withKnown.mgr.pick()?.name).toBe("unknown");
  } finally {
    rmSync(withKnown.poolDir, { recursive: true, force: true });
  }

  const allUnknown = tempPool(["busy", "idle"]);
  try {
    // Both unknown -> tie on expiryReset -> fewer-requests tie-break picks idle.
    allUnknown.mgr.recordSuccess("busy", { input_tokens: 1, output_tokens: 1 }, 0);
    expect(allUnknown.mgr.pick()?.name).toBe("idle");
  } finally {
    rmSync(allUnknown.poolDir, { recursive: true, force: true });
  }
});

test("expiring: a probed account ranks by real reset once its snapshot arrives", () => {
  const { poolDir, mgr } = tempPool(["known-later", "probed"]);
  try {
    const now = Date.now();
    // known-later: live 7d that resets in 3 days.
    mgr.recordRateLimitSnapshot("known-later", snapshot([win("7d", { utilization: 0.3, reset: now + 3 * 86_400_000 })]));

    // probed has no data yet -> picked first.
    expect(mgr.pick()?.name).toBe("probed");

    // Its response arrives with a LATER 7d reset than known-later.
    mgr.recordRateLimitSnapshot("probed", snapshot([win("7d", { utilization: 0.3, reset: now + 5 * 86_400_000 })]));

    // Now both are known; known-later resets sooner -> it wins.
    expect(mgr.pick()?.name).toBe("known-later");
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("expiring: multiple no-data accounts are probed round-robin, not one repeatedly", () => {
  const { poolDir, mgr } = tempPool(["a", "b", "c"]);
  try {
    // No snapshots -> all tie on null expiryReset and gate headroom 1 and 0
    // requests -> pickRoundRobin cycles them.
    const picks = new Set([mgr.pick()?.name, mgr.pick()?.name, mgr.pick()?.name]);
    expect(picks.size).toBe(3);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("falls back to fewest-requests tie-break when headroom is equal", async () => {
  const { poolDir, mgr } = tempPool(["a", "b"]);
  try {
    // Both fully unknown -> headroom ties at 1 for both; b has fewer requests recorded.
    mgr.recordSuccess("a", { input_tokens: 1, output_tokens: 1 }, 0);
    mgr.recordSuccess("a", { input_tokens: 1, output_tokens: 1 }, 0);

    const picked = mgr.pick();
    expect(picked?.name).toBe("b");
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("getAccount() proactively sidelines an account with a fully-consumed window before its reset", async () => {
  const { poolDir, mgr } = tempPool(["exhausted"]);
  try {
    mgr.recordRateLimitSnapshot(
      "exhausted",
      snapshot([
        win("5h", { status: "rejected", utilization: 1, reset: Date.now() + 10 * 60_000 }),
        win("7d", { utilization: 0.5 }),
      ]),
    );

    const acct = mgr.getAccount("exhausted");
    expect(acct.available).toBe(false);
    expect(acct.unavailableReason).toMatch(/usage limit reached \(5h window\)/);
    expect(mgr.pick()).toBeNull();
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("an account with a spent window is available again once its reset has passed", async () => {
  const { poolDir, mgr } = tempPool(["reset-account"]);
  try {
    mgr.recordRateLimitSnapshot(
      "reset-account",
      snapshot([win("5h", { status: "rejected", utilization: 1, reset: Date.now() - 1000 })]),
    );

    const acct = mgr.getAccount("reset-account");
    expect(acct.available).toBe(true);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

describe("provider tagging", () => {
  test("account with openai-auth.json is provider openai; default is anthropic", () => {
    const { poolDir, mgr } = tempPool([]);
    try {
      mgr.create("claude1");
      writeFileSync(
        join(mgr.configDirFor("claude1"), ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: "at", refreshToken: "rt" } }),
      );
      mgr.create("gpt1");
      writeFileSync(
        join(mgr.configDirFor("gpt1"), OPENAI_CREDS_FILENAME),
        JSON.stringify({ accessToken: "at", refreshToken: "rt", accountId: "acc_1" }),
      );

      expect(mgr.getAccount("claude1").provider).toBe("anthropic");
      expect(mgr.getAccount("gpt1").provider).toBe("openai");
      expect(mgr.getAccount("gpt1").authenticated).toBe(true);
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });
});

describe("provider-aware pick", () => {
  test("pick filters by provider and keeps one affinity pin per provider", () => {
    const { poolDir, mgr } = tempPool([]);
    try {
      mgr.create("claude1");
      writeFileSync(
        join(mgr.configDirFor("claude1"), ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: "at" } }),
      );
      mgr.create("gpt1");
      writeFileSync(
        join(mgr.configDirFor("gpt1"), OPENAI_CREDS_FILENAME),
        JSON.stringify({ accessToken: "at" }),
      );

      const a = mgr.pick("sess1"); // default: anthropic
      const o = mgr.pick("sess1", undefined, "openai");
      expect(a?.name).toBe("claude1");
      expect(o?.name).toBe("gpt1");
      // Pins are independent: re-picking either provider returns the same account.
      expect(mgr.pick("sess1")?.name).toBe("claude1");
      expect(mgr.pick("sess1", undefined, "openai")?.name).toBe("gpt1");
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("pick returns null when no account of the provider exists", () => {
    const { poolDir, mgr } = tempPool([]);
    try {
      mgr.create("claude1");
      writeFileSync(
        join(mgr.configDirFor("claude1"), ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: "at" } }),
      );
      expect(mgr.pick(undefined, undefined, "openai")).toBeNull();
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });
});

test("a spent model-scoped (Fable) window sidelines the account for that model only", async () => {
  const { poolDir, mgr } = tempPool(["fable-spent"]);
  try {
    mgr.recordRateLimitSnapshot(
      "fable-spent",
      snapshot([
        win("5h", { utilization: 0.2 }),
        win("7d", { utilization: 0.3 }),
        win("7d-fable", { status: "rejected", utilization: 1, reset: Date.now() + 60 * 60_000 }),
      ]),
    );

    // Fable's own allowance is spent, but the account can still serve other models.
    expect(mgr.getAccount("fable-spent").available).toBe(true);
    expect(mgr.pick(undefined, undefined, "anthropic", "fable")).toBeNull();
    expect(mgr.pick(undefined, undefined, "anthropic", "sonnet")?.name).toBe("fable-spent");
    expect(mgr.pick()?.name).toBe("fable-spent");
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("Fable requests route by Fable headroom; other models ignore the Fable window", async () => {
  const { poolDir, mgr } = tempPool(["fable-hot", "fable-cool"]);
  try {
    // fable-hot: barely-used account overall, but its Fable window is nearly spent.
    mgr.recordRateLimitSnapshot(
      "fable-hot",
      snapshot([win("5h", { utilization: 0.1 }), win("7d-fable", { utilization: 0.9 })]),
    );
    // fable-cool: more account-wide use, plenty of Fable headroom.
    mgr.recordRateLimitSnapshot(
      "fable-cool",
      snapshot([win("5h", { utilization: 0.3 }), win("7d-fable", { utilization: 0.2 })]),
    );

    expect(mgr.pick(undefined, undefined, "anthropic", "fable")?.name).toBe("fable-cool");
    expect(mgr.pick(undefined, undefined, "anthropic", "sonnet")?.name).toBe("fable-hot");
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("session affinity re-routes when the pinned account's model window is spent", async () => {
  const { poolDir, mgr } = tempPool(["pinned", "fallback"]);
  try {
    expect(mgr.pick("session-1", undefined, "anthropic", "fable")?.name).toBeDefined();
    const pinned = mgr.pick("session-1", undefined, "anthropic", "fable")!.name;
    const other = pinned === "pinned" ? "fallback" : "pinned";

    mgr.recordRateLimitSnapshot(
      pinned,
      snapshot([win("7d-fable", { status: "rejected", utilization: 1, reset: Date.now() + 60 * 60_000 })]),
    );

    expect(mgr.pick("session-1", undefined, "anthropic", "fable")?.name).toBe(other);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("legacy persisted snapshots (fixed 5h/7d fields) are upgraded on load", async () => {
  const { poolDir, mgr } = tempPool(["legacy"]);
  try {
    const usageFile = join(poolDir, "usage.json");
    writeFileSync(
      usageFile,
      JSON.stringify({
        usage: {
          legacy: {
            windowStart: Date.now(),
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
            rateLimitStatus: {
              unifiedStatus: "allowed",
              fiveHourStatus: "rejected",
              fiveHourUtilization: 1,
              fiveHourReset: Date.now() + 30 * 60_000,
              sevenDayStatus: "allowed",
              sevenDayUtilization: 0.4,
              sevenDayReset: Date.now() + 6 * 86_400_000,
              updatedAt: Date.now(),
            },
          },
        },
      }),
    );

    const config = loadConfig({
      poolDir,
      accountsDir: join(poolDir, "accounts"),
      usageFile,
      sessionsFile: join(poolDir, "sessions.json"),
    });
    const fresh = new AccountManager(config);
    const rl = fresh.getAccount("legacy").usage.rateLimitStatus;
    expect(rl?.windows.map((w) => w.key)).toEqual(["5h", "7d"]);
    // The upgraded snapshot still proactively sidelines the account.
    expect(fresh.getAccount("legacy").available).toBe(false);
    expect(fresh.getAccount("legacy").unavailableReason).toMatch(/usage limit reached \(5h window\)/);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("recordRateLimitSnapshot merges by window key instead of replacing wholesale", async () => {
  const { poolDir, mgr } = tempPool(["a"]);
  try {
    // A Fable request's response reports the account-wide windows plus a
    // model-scoped Fable window that's now exhausted.
    mgr.recordRateLimitSnapshot(
      "a",
      snapshot([
        win("5h", { utilization: 0.2 }),
        win("7d", { utilization: 0.3 }),
        win("7d-fable", { status: "rejected", utilization: 1, reset: Date.now() + 60 * 60_000 }),
      ]),
    );

    // A subsequent Sonnet request's response only reports the account-wide
    // windows — Anthropic has no reason to include the Fable-scoped header on
    // a non-Fable request. The previously-recorded exhausted Fable window must
    // survive, not be silently dropped.
    mgr.recordRateLimitSnapshot(
      "a",
      snapshot([win("5h", { utilization: 0.25 }), win("7d", { utilization: 0.35 })]),
    );

    const rl = mgr.getAccount("a").usage.rateLimitStatus;
    expect(rl?.windows.map((w) => w.key).sort()).toEqual(["5h", "7d", "7d-fable"]);
    const fiveHour = rl?.windows.find((w) => w.key === "5h");
    const fable = rl?.windows.find((w) => w.key === "7d-fable");
    // Account-wide windows pick up the fresher values from the latest response...
    expect(fiveHour?.utilization).toBe(0.25);
    // ...while the Fable window (absent from that response) is carried over unchanged.
    expect(fable?.utilization).toBe(1);
    expect(fable?.status).toBe("rejected");

    // Fable routing still sees the account as exhausted for Fable specifically.
    expect(mgr.pick(undefined, undefined, "anthropic", "fable")).toBeNull();
    expect(mgr.pick(undefined, undefined, "anthropic", "sonnet")?.name).toBe("a");
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

// A macOS Keychain never forgets a login on its own — `remove()` only deletes
// the account's directory. This fake simulates a leftover Keychain item that
// would still resolve for a removed account's hashed service name, the way
// the real `security` CLI would, to prove readCreds() no longer trusts it.
function stubKeychainStillRemembersEverything(): KeychainOps {
  return {
    read: () => ({
      claudeAiOauth: {
        accessToken: "leftover-keychain-token",
        refreshToken: "r",
        expiresAt: Date.now() + 3_600_000,
      },
    }),
    delete: () => {},
  };
}

test("remove() severs the account even if its macOS Keychain item is never deleted", () => {
  const keychain = stubKeychainStillRemembersEverything();
  const { poolDir, mgr } = tempPool(["gone"], keychain);
  try {
    expect(mgr.getAccount("gone").authenticated).toBe(true);
    mgr.remove("gone");

    // The account's directory is gone, but the stubbed Keychain would still
    // hand back a valid-looking credential for it if readCreds() asked.
    const acct = mgr.getAccount("gone");
    expect(acct.authenticated).toBe(false);
    expect(acct.available).toBe(false);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("pick() drops stale session affinity to a removed account instead of resurrecting it via Keychain", () => {
  const keychain = stubKeychainStillRemembersEverything();
  const { poolDir, mgr } = tempPool(["work", "personal"], keychain);
  try {
    const sessionKey = "session-1";
    // Sticky-pin the session to whichever account pick() lands on first.
    const first = mgr.pick(sessionKey);
    expect(first).not.toBeNull();
    const removedName = first!.name;
    const otherName = removedName === "work" ? "personal" : "work";

    mgr.remove(removedName);

    // Same session key, after its pinned account was removed out from under
    // it: must fail over to the remaining account, not keep routing to the
    // removed one via the stale affinity entry + leftover Keychain item.
    const second = mgr.pick(sessionKey);
    expect(second?.name).toBe(otherName);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("a stale in-memory manager's saveState() doesn't resurrect a removed account's usage.json entry", () => {
  // Simulates the real architecture: a long-running pool server holds one
  // AccountManager in memory for its whole lifetime, while `accounts remove`
  // runs as a separate, short-lived CLI process with its own AccountManager
  // pointed at the same pool directory.
  const { poolDir, mgr: serverMgr } = tempPool(["work", "gone"]);
  try {
    serverMgr.recordSuccess("gone", { input_tokens: 1, output_tokens: 1 }, 0);

    const config = loadConfig({
      poolDir,
      accountsDir: join(poolDir, "accounts"),
      usageFile: join(poolDir, "usage.json"),
      sessionsFile: join(poolDir, "sessions.json"),
    });
    const cliMgr = new AccountManager(config);
    cliMgr.remove("gone");

    // serverMgr's in-memory usage map still thinks "gone" exists — recording
    // usage for an unrelated account must not rewrite "gone" back into
    // usage.json.
    serverMgr.recordSuccess("work", { input_tokens: 1, output_tokens: 1 }, 0);

    const onDisk = JSON.parse(readFileSync(join(poolDir, "usage.json"), "utf8"));
    expect(onDisk.usage.gone).toBeUndefined();
    expect(onDisk.usage.work).toBeDefined();
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("priorityFor defaults to 100 and setPriority round-trips", () => {
  const { poolDir, mgr } = tempPool(["a"]);
  try {
    expect(mgr.priorityFor("a")).toBe(100);
    expect(mgr.getAccount("a").priority).toBe(100);
    mgr.setPriority("a", 1);
    expect(mgr.priorityFor("a")).toBe(1);
    expect(mgr.getAccount("a").priority).toBe(1);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("priorityFor picks up an out-of-band routing.json change via mtime (cache invalidation)", () => {
  const { poolDir, mgr } = tempPool(["a"]);
  try {
    mgr.setPriority("a", 1);
    expect(mgr.priorityFor("a")).toBe(1); // populates the mtime cache
    // Simulate a different process rewriting routing.json, then force a newer
    // mtime so the change is unambiguously visible regardless of fs resolution.
    const p = join(mgr.configDirFor("a"), "routing.json");
    writeFileSync(p, JSON.stringify({ priority: 5 }));
    const future = new Date(Date.now() + 10_000);
    utimesSync(p, future, future);
    expect(mgr.priorityFor("a")).toBe(5);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("priorityFor returns 100 for a malformed routing.json", () => {
  const { poolDir, mgr } = tempPool(["a"]);
  try {
    writeFileSync(join(mgr.configDirFor("a"), "routing.json"), "{ not json");
    expect(mgr.priorityFor("a")).toBe(100);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("setPriority rejects negative or non-integer priorities", () => {
  const { poolDir, mgr } = tempPool(["a"]);
  try {
    expect(() => mgr.setPriority("a", -1)).toThrow();
    expect(() => mgr.setPriority("a", 1.5)).toThrow();
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("pick() prefers a lower-priority-number tier", () => {
  const { poolDir, mgr } = tempPool(["primary", "fallback"]);
  try {
    mgr.setPriority("primary", 1);
    mgr.setPriority("fallback", 2);
    expect(mgr.pick()?.name).toBe("primary");
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("pick() descends to fallback only when every primary is unavailable", () => {
  const { poolDir, mgr } = tempPool(["primaryA", "primaryB", "fallback"]);
  try {
    mgr.setPriority("primaryA", 1);
    mgr.setPriority("primaryB", 1);
    mgr.setPriority("fallback", 2);
    // One primary down, one still up -> stay on tier 1.
    mgr.markRateLimited("primaryA", Date.now() + 60 * 60_000);
    expect(mgr.pick()?.name).toBe("primaryB");
    // Both primaries down -> descend to fallback.
    mgr.markRateLimited("primaryB", Date.now() + 60 * 60_000);
    expect(mgr.pick()?.name).toBe("fallback");
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("failover exclude cascades from tier 1 to tier 2", () => {
  const { poolDir, mgr } = tempPool(["primary", "fallback"]);
  try {
    mgr.setPriority("primary", 1);
    mgr.setPriority("fallback", 2);
    // Simulate failover having already tried "primary" this request.
    expect(mgr.pick(undefined, new Set(["primary"]))?.name).toBe("fallback");
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("affinity to a fallback account is dropped once a primary recovers", () => {
  const { poolDir, mgr } = tempPool(["primary", "fallback"]);
  try {
    mgr.setPriority("primary", 1);
    mgr.setPriority("fallback", 2);
    // Pin the session to fallback while the primary is down.
    mgr.markRateLimited("primary", Date.now() + 60 * 60_000);
    expect(mgr.pick("s1")?.name).toBe("fallback"); // pins s1 -> fallback
    // Primary recovers; the pinned fallback must be abandoned for the primary.
    mgr.clearRateLimit("primary");
    expect(mgr.pick("s1")?.name).toBe("primary");
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("routingSnapshot groups tiers and picks the active (lowest-number) tier", () => {
  const { poolDir, mgr } = tempPool(["primary", "fallback"]);
  try {
    mgr.setPriority("primary", 1);
    mgr.setPriority("fallback", 2);
    const snap = mgr.routingSnapshot();
    expect(snap.tiers.map((t) => t.priority)).toEqual([1, 2]);
    expect(snap.activeTier).toBe(1);
    expect(snap.nextPick?.account).toBe("primary");
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("routingSnapshot descends to the next tier when the active tier is unavailable", () => {
  const { poolDir, mgr } = tempPool(["primary", "fallback"]);
  try {
    mgr.setPriority("primary", 1);
    mgr.setPriority("fallback", 2);
    mgr.markRateLimited("primary", Date.now() + 60 * 60_000);
    const snap = mgr.routingSnapshot();
    expect(snap.activeTier).toBe(2);
    expect(snap.nextPick?.account).toBe("fallback");
    expect(snap.tiers.find((t) => t.priority === 1)?.available).toBe(0);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("routingSnapshot is read-only: it does not advance the round-robin cursor", () => {
  const { poolDir, mgr } = tempPool(["a", "b"]);
  try {
    // Both accounts tie (no snapshot, 0 requests) -> pick() round-robins a,b,a,b...
    const p1 = mgr.pick()?.name;
    mgr.routingSnapshot(); // must NOT consume a round-robin step
    const p2 = mgr.pick()?.name;
    expect(p1).not.toBe(p2);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("routingSnapshot reason: 7d expiry is the decisive factor and names the runner-up", () => {
  const { poolDir, mgr } = tempPool(["burn-me", "keep"]);
  try {
    const now = Date.now();
    mgr.recordRateLimitSnapshot(
      "burn-me",
      snapshot([win("5h", { utilization: 0.2 }), win("7d", { utilization: 0.3, reset: now + 2 * 86_400_000 })]),
    );
    mgr.recordRateLimitSnapshot(
      "keep",
      snapshot([win("5h", { utilization: 0.2 }), win("7d", { utilization: 0.3, reset: now + 5 * 86_400_000 })]),
    );

    const snap = mgr.routingSnapshot();
    expect(snap.nextPick?.account).toBe("burn-me");
    const reason = snap.nextPick!.reason;
    expect(reason.summary.length).toBeGreaterThan(0);
    const labels = reason.factors.map((f) => f.label);
    expect(labels).toContain("Priority tier");
    expect(labels).toContain("5h gate");
    expect(labels).toContain("7d expiry");
    const expiry = reason.factors.find((f) => f.label === "7d expiry")!;
    expect(expiry.decisive).toBe(true);
    expect(expiry.detail).toContain("keep"); // runner-up named for contrast
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("routingSnapshot: expiry factor says 'probing' for a no-data account", () => {
  const { poolDir, mgr } = tempPool(["fresh"]);
  try {
    const snap = mgr.routingSnapshot();
    const expiry = snap.nextPick?.reason.factors.find((f) => f.label === "7d expiry");
    expect(expiry?.detail).toMatch(/no live window data yet — probing/);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("routingSnapshot: expiry factor says 'expired — probing' when a snapshot went stale", () => {
  const { poolDir, mgr } = tempPool(["went-stale"]);
  try {
    const now = Date.now();
    mgr.recordRateLimitSnapshot("went-stale", snapshot([win("7d", { utilization: 0.3, reset: now - 1000 })]));
    const snap = mgr.routingSnapshot();
    const expiry = snap.nextPick?.reason.factors.find((f) => f.label === "7d expiry");
    expect(expiry?.detail).toMatch(/prior window data expired — probing/);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("routingSnapshot reason: a tie on 7d reset is settled by a decisive Tie-break factor", () => {
  const { poolDir, mgr } = tempPool(["a", "b"]);
  try {
    const now = Date.now();
    // Identical 7d reset + headroom; b has fewer requests -> tie-break decides.
    mgr.recordRateLimitSnapshot("a", snapshot([win("5h", { utilization: 0.2 }), win("7d", { utilization: 0.3, reset: now + 3 * 86_400_000 })]));
    mgr.recordRateLimitSnapshot("b", snapshot([win("5h", { utilization: 0.2 }), win("7d", { utilization: 0.3, reset: now + 3 * 86_400_000 })]));
    mgr.recordSuccess("a", { input_tokens: 1, output_tokens: 1 }, 0);

    const snap = mgr.routingSnapshot();
    expect(snap.nextPick?.account).toBe("b");
    const reason = snap.nextPick!.reason;
    const expiry = reason.factors.find((f) => f.label === "7d expiry")!;
    const tiebreak = reason.factors.find((f) => f.label === "Tie-break")!;
    expect(expiry.decisive).toBe(false);
    expect(tiebreak.decisive).toBe(true);
    expect(tiebreak.detail).toContain("fewer requests");
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("routingSnapshot reason: 5h gate factor reflects an excluded candidate", () => {
  const { poolDir, mgr } = tempPool(["hot", "ok"]);
  try {
    const now = Date.now();
    mgr.recordRateLimitSnapshot("hot", snapshot([win("5h", { utilization: 0.95 }), win("7d", { utilization: 0.2, reset: now + 1 * 86_400_000 })]));
    mgr.recordRateLimitSnapshot("ok", snapshot([win("5h", { utilization: 0.3 }), win("7d", { utilization: 0.2, reset: now + 5 * 86_400_000 })]));

    const snap = mgr.routingSnapshot();
    expect(snap.nextPick?.account).toBe("ok");
    const gate = snap.nextPick!.reason.factors.find((f) => f.label === "5h gate")!;
    expect(gate.decisive).toBe(true);
    expect(gate.detail).toContain("1/2"); // one of two eligible
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("routingSnapshot reason: headroom strategy describes most-headroom + fewer-requests", () => {
  const { poolDir, mgr } = tempPool(["big", "small"], undefined, { routingStrategy: "headroom" });
  try {
    mgr.recordRateLimitSnapshot("big", snapshot([win("5h", { utilization: 0.1 })]));
    mgr.recordRateLimitSnapshot("small", snapshot([win("5h", { utilization: 0.6 })]));

    const snap = mgr.routingSnapshot();
    expect(snap.nextPick?.account).toBe("big");
    const labels = snap.nextPick!.reason.factors.map((f) => f.label);
    expect(labels).toContain("Most headroom");
    expect(labels).toContain("Tie-break");
    const primary = snap.nextPick!.reason.factors.find((f) => f.label === "Most headroom")!;
    expect(primary.decisive).toBe(true);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("routingSnapshot reason (headroom): equal headroom but differing requests → tie-break names fewer requests", () => {
  const { poolDir, mgr } = tempPool(["busy", "idle"], undefined, { routingStrategy: "headroom" });
  try {
    // No snapshots → headroom ties at 1; busy has one more request than idle.
    mgr.recordSuccess("busy", { input_tokens: 1, output_tokens: 1 }, 0);

    const snap = mgr.routingSnapshot();
    expect(snap.nextPick?.account).toBe("idle");
    const tb = snap.nextPick!.reason.factors.find((f) => f.label === "Tie-break")!;
    expect(tb.decisive).toBe(true);
    expect(tb.detail).toContain("fewer requests");
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("routingSnapshot reason (headroom): headroom AND requests tied → tie-break is round-robin, not 'fewer requests'", () => {
  const { poolDir, mgr } = tempPool(["a", "b"], undefined, { routingStrategy: "headroom" });
  try {
    // Both fresh: headroom 1==1 and windowRequests 0==0, so the real tiebreak
    // is round-robin — the reason must NOT claim "fewer requests".
    const snap = mgr.routingSnapshot();
    const tb = snap.nextPick!.reason.factors.find((f) => f.label === "Tie-break")!;
    expect(tb.decisive).toBe(true);
    expect(tb.detail).not.toContain("fewer requests");
    expect(tb.detail).toContain("round-robin");
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("markRateLimited uses the unified blocking-window reset when no explicit resetAt", () => {
  const { poolDir, mgr } = tempPool(["acct"]);
  try {
    const now = Date.now();
    const realReset = now + 6 * 60 * 60_000; // 6h out — well past the 1h cooldown.
    // Snapshot recorded first on the request path shows a blocking 5h window.
    mgr.recordRateLimitSnapshot("acct", snapshot([win("5h", { status: "rejected", utilization: 1, reset: realReset })]));

    mgr.markRateLimited("acct"); // no explicit resetAt (e.g. 429 without retry-after)

    const until = mgr.getAccount("acct").usage.rateLimitedUntil;
    expect(until).toBe(realReset);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("markRateLimited falls back to the synthetic cooldown when no future blocking reset exists", () => {
  const { poolDir, mgr } = tempPool(["acct"]);
  try {
    const now = Date.now();
    // Blocking window whose reset already elapsed -> not a usable fallback.
    mgr.recordRateLimitSnapshot("acct", snapshot([win("5h", { status: "rejected", utilization: 1, reset: now - 1000 })]));

    mgr.markRateLimited("acct");

    const until = mgr.getAccount("acct").usage.rateLimitedUntil ?? 0;
    // Default rateLimitCooldownMs is 1h; allow scheduling slack.
    expect(until).toBeGreaterThan(now + 55 * 60_000);
    expect(until).toBeLessThan(now + 65 * 60_000);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

describe("routing weight", () => {
  test("weightFor defaults to 1 and setWeight round-trips", () => {
    const { poolDir, mgr } = tempPool(["a"]);
    try {
      expect(mgr.weightFor("a")).toBe(1);
      mgr.setWeight("a", 2.5);
      expect(mgr.weightFor("a")).toBe(2.5);
      expect(mgr.getAccount("a").weight).toBe(2.5);
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("setWeight preserves priority and setPriority preserves weight", () => {
    const { poolDir, mgr } = tempPool(["a"]);
    try {
      mgr.setPriority("a", 5);
      mgr.setWeight("a", 3);
      expect(mgr.priorityFor("a")).toBe(5);
      mgr.setPriority("a", 7);
      expect(mgr.weightFor("a")).toBe(3);
      expect(mgr.priorityFor("a")).toBe(7);
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("malformed weight in routing.json falls back to 1", () => {
    const { poolDir, mgr } = tempPool(["a"]);
    try {
      writeFileSync(join(poolDir, "accounts", "a", "routing.json"), '{"priority": 1, "weight": "big"}');
      expect(mgr.weightFor("a")).toBe(1);
      expect(mgr.priorityFor("a")).toBe(1);
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("isValidWeight accepts [0.1,10] numbers and rejects everything else", () => {
    expect(isValidWeight(0.1)).toBe(true);
    expect(isValidWeight(10)).toBe(true);
    expect(isValidWeight(1.5)).toBe(true);
    expect(isValidWeight(0.05)).toBe(false);
    expect(isValidWeight(11)).toBe(false);
    expect(isValidWeight(NaN)).toBe(false);
    expect(isValidWeight("2")).toBe(false);
  });

  test("setWeight rejects out-of-range values", () => {
    const { poolDir, mgr } = tempPool(["a"]);
    try {
      expect(() => mgr.setWeight("a", 0)).toThrow();
      expect(() => mgr.setWeight("missing", 1)).toThrow();
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });
});

describe("session ledger integration", () => {
  test("hard pin: a pinned session stays on its account even when another has better expiring quota", () => {
    const { poolDir, mgr } = tempPool(["pinned", "better"]);
    try {
      const now = Date.now();
      // "better" would win on soonest 7d reset; the pin must override that.
      mgr.recordRateLimitSnapshot("pinned", snapshot([
        win("5h", { utilization: 0.2, reset: now + 3600_000 }),
        win("7d", { utilization: 0.2, reset: now + 6 * 86_400_000 }),
      ]));
      mgr.recordRateLimitSnapshot("better", snapshot([
        win("5h", { utilization: 0.2, reset: now + 3600_000 }),
        win("7d", { utilization: 0.2, reset: now + 1 * 86_400_000 }),
      ]));
      mgr.setAffinity("sess", "pinned");
      expect(mgr.pick("sess")?.name).toBe("pinned");
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("pin is dropped when the account is rate limited, and the session re-routes", () => {
    const { poolDir, mgr } = tempPool(["a", "b"]);
    try {
      mgr.setAffinity("sess", "a");
      mgr.markRateLimited("a");
      expect(mgr.pick("sess")?.name).toBe("b");
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("pin yields when its account leaves the active tier", () => {
    const { poolDir, mgr } = tempPool(["primary", "fallback"]);
    try {
      mgr.setPriority("primary", 1);
      mgr.setPriority("fallback", 2);
      mgr.setAffinity("sess", "fallback"); // pinned during a primary outage
      expect(mgr.pick("sess")?.name).toBe("primary"); // primary recovered: move back
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("pins survive a manager restart", () => {
    const { poolDir, mgr } = tempPool(["a", "b"]);
    try {
      mgr.setAffinity("sess", "b");
      const config = loadConfig({
        poolDir,
        accountsDir: join(poolDir, "accounts"),
        usageFile: join(poolDir, "usage.json"),
        sessionsFile: join(poolDir, "sessions.json"),
      });
      const reborn = new AccountManager(config);
      expect(reborn.pick("sess")?.name).toBe("b");
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("activeSessions on Account counts live pins", () => {
    const { poolDir, mgr } = tempPool(["a", "b"]);
    try {
      mgr.setAffinity("s1", "a");
      mgr.setAffinity("s2", "a");
      mgr.setAffinity("s3", "b");
      expect(mgr.getAccount("a").activeSessions).toBe(2);
      expect(mgr.getAccount("b").activeSessions).toBe(1);
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("pick() itself pins the chosen account for the session", () => {
    const { poolDir, mgr } = tempPool(["a", "b"]);
    try {
      const first = mgr.pick("sess")!;
      // Round-robin would alternate without a pin; repeated picks must not.
      expect(mgr.pick("sess")?.name).toBe(first.name);
      expect(mgr.pick("sess")?.name).toBe(first.name);
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });
});

function weightedPool(names: string[]) {
  return tempPool(names, undefined, { routingStrategy: "weighted" });
}

describe("weighted strategy", () => {
  test("urgency dominates when weight, load, and headroom are equal (soonest 7d reset wins)", () => {
    const { poolDir, mgr } = weightedPool(["soon", "later"]);
    try {
      const now = Date.now();
      mgr.recordRateLimitSnapshot("soon", snapshot([
        win("5h", { utilization: 0.2, reset: now + 3600_000 }),
        win("7d", { utilization: 0.2, reset: now + 1 * 86_400_000 }),
      ]));
      mgr.recordRateLimitSnapshot("later", snapshot([
        win("5h", { utilization: 0.2, reset: now + 3600_000 }),
        win("7d", { utilization: 0.2, reset: now + 6 * 86_400_000 }),
      ]));
      expect(mgr.pick()?.name).toBe("soon");
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("load flips the winner: a crowded soonest-expiring sub loses to the next one", () => {
    const { poolDir, mgr } = weightedPool(["soon-busy", "later-idle"]);
    try {
      const now = Date.now();
      mgr.recordRateLimitSnapshot("soon-busy", snapshot([
        win("5h", { utilization: 0.2, reset: now + 3600_000 }),
        win("7d", { utilization: 0.2, reset: now + 1 * 86_400_000 }),
      ]));
      mgr.recordRateLimitSnapshot("later-idle", snapshot([
        win("5h", { utilization: 0.2, reset: now + 3600_000 }),
        win("7d", { utilization: 0.2, reset: now + 6 * 86_400_000 }),
      ]));
      // soon-busy: urgency 1.0 but 2 sessions -> load 0.5 -> 0.5
      // later-idle: urgency 0.8, 0 sessions -> 0.8 -> wins
      mgr.setAffinity("s1", "soon-busy");
      mgr.setAffinity("s2", "soon-busy");
      expect(mgr.pick("new-session")?.name).toBe("later-idle");
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("expiry order beats weekly headroom: the soonest-resetting account is drained first even when nearly full", () => {
    const { poolDir, mgr } = weightedPool(["expiring-soon", "fresh"]);
    try {
      const now = Date.now();
      // expiring-soon: 7d window 97% used but resets in ~3h -> burn it before reset.
      mgr.recordRateLimitSnapshot("expiring-soon", snapshot([
        win("5h", { utilization: 0, reset: now + 3600_000 }),
        win("7d", { utilization: 0.97, reset: now + 3 * 3600_000 }),
      ]));
      // fresh: half the weekly window left, but resets days away.
      mgr.recordRateLimitSnapshot("fresh", snapshot([
        win("5h", { utilization: 0, reset: now + 3600_000 }),
        win("7d", { utilization: 0.49, reset: now + 65 * 3600_000 }),
      ]));
      // Old formula multiplied by weekly headroom (0.03) and buried the expiring
      // account; the fix ranks purely on reset order at equal 5h load.
      expect(mgr.pick()?.name).toBe("expiring-soon");
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("manual weight biases selection between otherwise-equal accounts", () => {
    const { poolDir, mgr } = weightedPool(["plain", "boosted"]);
    try {
      const now = Date.now();
      const same = () => snapshot([
        win("5h", { utilization: 0.2, reset: now + 3600_000 }),
        win("7d", { utilization: 0.2, reset: now + 3 * 86_400_000 }),
      ]);
      mgr.recordRateLimitSnapshot("plain", same());
      mgr.recordRateLimitSnapshot("boosted", same());
      mgr.setWeight("boosted", 2);
      expect(mgr.pick()?.name).toBe("boosted");
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("5h headroom collapse drops an account below a later-expiring alternative", () => {
    const { poolDir, mgr } = weightedPool(["soon-full", "later-fresh"]);
    try {
      const now = Date.now();
      mgr.recordRateLimitSnapshot("soon-full", snapshot([
        win("5h", { utilization: 0.9, reset: now + 3600_000 }),
        win("7d", { utilization: 0.2, reset: now + 1 * 86_400_000 }),
      ]));
      mgr.recordRateLimitSnapshot("later-fresh", snapshot([
        win("5h", { utilization: 0.1, reset: now + 3600_000 }),
        win("7d", { utilization: 0.2, reset: now + 6 * 86_400_000 }),
      ]));
      // soon-full: 1.0 urgency × 0.1 headroom = 0.1; later-fresh: 0.8 × 0.9 = 0.72
      expect(mgr.pick()?.name).toBe("later-fresh");
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("accounts below routingMinHeadroom fall to a fallback pool, not a hard exclusion", () => {
    const { poolDir, mgr } = weightedPool(["nearly-out", "also-out"]);
    try {
      const now = Date.now();
      mgr.recordRateLimitSnapshot("nearly-out", snapshot([
        win("5h", { utilization: 0.95, reset: now + 3600_000 }),
        win("7d", { utilization: 0.2, reset: now + 86_400_000 }),
      ]));
      mgr.recordRateLimitSnapshot("also-out", snapshot([
        win("5h", { utilization: 0.99, reset: now + 3600_000 }),
        win("7d", { utilization: 0.2, reset: now + 2 * 86_400_000 }),
      ]));
      // Nobody is viable; best-effort still serves the higher score.
      expect(mgr.pick()?.name).toBe("nearly-out");
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("priority tiers still gate hard: a heavy weight cannot pull a lower tier forward", () => {
    const { poolDir, mgr } = weightedPool(["tier1", "tier2-heavy"]);
    try {
      mgr.setPriority("tier1", 1);
      mgr.setPriority("tier2-heavy", 2);
      mgr.setWeight("tier2-heavy", 10);
      expect(mgr.pick()?.name).toBe("tier1");
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("routingSnapshot exposes the per-candidate factor breakdown", () => {
    const { poolDir, mgr } = weightedPool(["a", "b"]);
    try {
      mgr.setWeight("a", 2);
      mgr.setAffinity("s1", "b");
      const snap = mgr.routingSnapshot();
      expect(snap.nextPick).not.toBe(null);
      const cands = snap.candidates!;
      expect(cands.length).toBe(2);
      const a = cands.find((c) => c.account === "a")!;
      const b = cands.find((c) => c.account === "b")!;
      expect(a.weight).toBe(2);
      expect(b.loadFactor).toBeCloseTo(1 / 1.5, 5);
      const t = mgr.getTuning();
      for (const c of cands) {
        expect(c.score).toBeCloseTo(
          c.weight * c.urgency * c.loadFactor * c.headroom ** t.fiveHourExp,
          8,
        );
      }
      // Factors render into the reason list for the dashboard panel.
      const labels = snap.nextPick!.reason.factors.map((f) => f.label);
      expect(labels).toContain("Score");
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("a weekly-spent account with an unknown reset ranks last, not first (no probe-boost)", () => {
    const { poolDir, mgr } = weightedPool(["spent", "known-later"]);
    try {
      const now = Date.now();
      // spent: 5h window healthy (viable) but the 7d allowance is fully consumed
      // with NO known reset -> usableFor keeps it in the pool (spentWindowReason
      // needs a future reset to sideline), and candidateExpiryReset returns null
      // for the exhausted 7d window. It must NOT be treated like an unprobed
      // account (which would hand it max urgency and jump it to the front).
      mgr.recordRateLimitSnapshot("spent", snapshot([
        win("5h", { utilization: 0, reset: now + 3600_000 }),
        win("7d", { utilization: 1 }), // spent, reset unknown (null) -> stays available
      ]));
      // known-later: a real future reset, days out.
      mgr.recordRateLimitSnapshot("known-later", snapshot([
        win("5h", { utilization: 0, reset: now + 3600_000 }),
        win("7d", { utilization: 0.5, reset: now + 5 * 86_400_000 }),
      ]));
      expect(mgr.pick()?.name).toBe("known-later");
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

});

describe("routing tuning", () => {
  test("getTuning returns defaults when no tuning.json exists", () => {
    const { poolDir, mgr } = weightedPool(["a"]);
    try {
      const t = mgr.getTuning();
      expect(t.fiveHourExp).toBe(1);
      expect(t.loadSlope).toBe(0.5);
      expect(t.urgencyDecay).toBe(0.75);
      expect(t.minHeadroom).toBeCloseTo(0.1, 8);
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("setTuning round-trips and is visible immediately (cache invalidated within one mtime tick)", () => {
    const { poolDir, mgr } = weightedPool(["a"]);
    try {
      mgr.setTuning({ fiveHourExp: 2 });
      mgr.setTuning({ loadSlope: 1 }); // second write within the same fs mtime tick
      const t = mgr.getTuning();
      expect(t.fiveHourExp).toBe(2);
      expect(t.loadSlope).toBe(1);
      // Persisted to tuning.json in the pool dir.
      const onDisk = JSON.parse(readFileSync(join(poolDir, "tuning.json"), "utf8"));
      expect(onDisk.fiveHourExp).toBe(2);
      expect(onDisk.loadSlope).toBe(1);
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("an out-of-bounds field in tuning.json falls back to its default; valid fields still apply", () => {
    const { poolDir, mgr } = weightedPool(["a"]);
    try {
      writeFileSync(join(poolDir, "tuning.json"), JSON.stringify({ urgencyDecay: 99, fiveHourExp: 2 }));
      const t = mgr.getTuning();
      expect(t.urgencyDecay).toBe(0.75); // 99 > max 5 -> default
      expect(t.fiveHourExp).toBe(2); // valid -> applied
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("setTuning rejects out-of-bounds values", () => {
    const { poolDir, mgr } = weightedPool(["a"]);
    try {
      expect(() => mgr.setTuning({ minHeadroom: 2 })).toThrow();
      expect(() => mgr.setTuning({ fiveHourExp: -1 })).toThrow();
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("setTuning persists only explicit overrides, so untouched knobs keep seeding from config", () => {
    const { poolDir, mgr } = weightedPool(["a"]);
    try {
      mgr.setTuning({ fiveHourExp: 2 });
      const onDisk = JSON.parse(readFileSync(join(poolDir, "tuning.json"), "utf8"));
      expect(onDisk.fiveHourExp).toBe(2);
      expect("minHeadroom" in onDisk).toBe(false); // NOT frozen at the current default
      // A restart with a different ROUTING_MIN_HEADROOM still takes effect for the
      // untouched minHeadroom knob, while the explicit fiveHourExp override persists.
      const cfg2 = loadConfig({
        poolDir,
        accountsDir: join(poolDir, "accounts"),
        usageFile: join(poolDir, "usage.json"),
        sessionsFile: join(poolDir, "sessions.json"),
        routingStrategy: "weighted",
        routingMinHeadroom: 0.3,
      });
      const mgr2 = new AccountManager(cfg2);
      const t = mgr2.getTuning();
      expect(t.minHeadroom).toBeCloseTo(0.3, 8);
      expect(t.fiveHourExp).toBe(2);
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("expiry ordering: unknown (probe) first, known-reset next, weekly-spent last", () => {
    const { poolDir, mgr } = weightedPool(["unprobed", "known", "spent"]);
    try {
      const now = Date.now();
      // unprobed: no snapshot recorded -> no window data -> ranks FIRST (probe it).
      mgr.recordRateLimitSnapshot("known", snapshot([
        win("5h", { utilization: 0, reset: now + 3600_000 }),
        win("7d", { utilization: 0.5, reset: now + 5 * 86_400_000 }),
      ]));
      // spent: 7d fully consumed with unknown reset (stays available) -> ranks LAST.
      mgr.recordRateLimitSnapshot("spent", snapshot([
        win("5h", { utilization: 0, reset: now + 3600_000 }),
        win("7d", { utilization: 1 }),
      ]));
      expect(mgr.pick()?.name).toBe("unprobed");
      expect(mgr.pick(undefined, new Set(["unprobed"]))?.name).toBe("known");
      expect(mgr.pick(undefined, new Set(["unprobed", "known"]))?.name).toBe("spent");
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("a tuned minHeadroom gate also applies to the expiring strategy", () => {
    const { poolDir, mgr } = tempPool(["mid", "fresh"], undefined, { routingStrategy: "expiring" });
    try {
      const now = Date.now();
      // mid: 5h 40% used (gate headroom 0.6), 7d expires SOONEST → normally wins.
      mgr.recordRateLimitSnapshot("mid", snapshot([
        win("5h", { utilization: 0.4, reset: now + 60 * 60_000 }),
        win("7d", { utilization: 0.2, reset: now + 1 * 86_400_000 }),
      ]));
      mgr.recordRateLimitSnapshot("fresh", snapshot([
        win("5h", { utilization: 0.1, reset: now + 60 * 60_000 }),
        win("7d", { utilization: 0.2, reset: now + 5 * 86_400_000 }),
      ]));
      expect(mgr.pick()?.name).toBe("mid"); // default gate 0.1 keeps mid viable
      mgr.setTuning({ minHeadroom: 0.7 }); // above mid's 0.6 headroom → mid benched
      expect(mgr.pick()?.name).toBe("fresh");
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("expiring strategy demotes a weekly-spent account below one with real remaining quota", () => {
    const { poolDir, mgr } = tempPool(["spent", "known-later"], undefined, { routingStrategy: "expiring" });
    try {
      const now = Date.now();
      // spent: 7d consumed, unknown reset -> stays available but its allowance is
      // already gone, so it must NOT be treated as the soonest-to-drain account.
      mgr.recordRateLimitSnapshot("spent", snapshot([
        win("5h", { utilization: 0, reset: now + 3600_000 }),
        win("7d", { utilization: 1 }),
      ]));
      mgr.recordRateLimitSnapshot("known-later", snapshot([
        win("5h", { utilization: 0, reset: now + 3600_000 }),
        win("7d", { utilization: 0.5, reset: now + 5 * 86_400_000 }),
      ]));
      expect(mgr.pick()?.name).toBe("known-later");
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("expiring reason marks 7d expiry decisive when an unprobed account beats a spent one", () => {
    const { poolDir, mgr } = tempPool(["unprobed", "spent"], undefined, { routingStrategy: "expiring" });
    try {
      const now = Date.now();
      // unprobed: no snapshot -> ranks first (probe). spent: 7d fully consumed,
      // unknown reset -> ranks last. Both have null expiryReset, so the reason's
      // "decisive" flag must come from the shared rank key, not raw reset compare.
      mgr.recordRateLimitSnapshot("spent", snapshot([
        win("5h", { utilization: 0, reset: now + 3600_000 }),
        win("7d", { utilization: 1 }),
      ]));
      const reason = mgr.routingSnapshot().nextPick!.reason;
      const byLabel = (l: string) => reason.factors.find((f) => f.label === l)!;
      expect(mgr.routingSnapshot().nextPick!.account).toBe("unprobed");
      expect(byLabel("7d expiry").decisive).toBe(true);
      expect(byLabel("Tie-break").decisive).toBe(false);
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });
});

test("recordUsageSnapshot replaces scoped windows and preserves overage", () => {
  const { poolDir, mgr } = tempPool(["acct"]);
  try {
    // Seed a stale snapshot with a scoped window + a non-duration overage window.
    mgr.recordRateLimitSnapshot(
      "acct",
      snapshot([
        win("7d-opus", { utilization: 0.9, reset: 999 }),
        win("overage", { model: null, utilization: 0.1, reset: null }),
      ]),
    );
    // Endpoint now reports only 5h + 7d (the opus window is gone).
    mgr.recordUsageSnapshot("acct", {
      unifiedStatus: "allowed",
      updatedAt: 2,
      windows: [win("5h", { utilization: 0.2, reset: 111 }), win("7d", { utilization: 0.5, reset: 222 })],
    });
    const rl = mgr.listAccounts().find((a) => a.name === "acct")!.usage.rateLimitStatus;
    const keys = rl!.windows.map((w) => w.key).sort();
    expect(keys).toEqual(["5h", "7d", "overage"]); // stale 7d-opus dropped, overage kept
    expect(rl!.updatedAt).toBe(2);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("recordUsageCheckError sets the field without touching lastError", () => {
  const { poolDir, mgr } = tempPool(["acct"]);
  try {
    mgr.recordUsageCheckError("acct", "boom");
    const a = mgr.listAccounts().find((x) => x.name === "acct")!;
    expect(a.usage.lastUsageCheckError).toBe("boom");
    expect(a.usage.lastError).toBeNull();
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});
