import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig } from "../config.ts";
import { AccountManager } from "./manager.ts";
import type { RateLimitSnapshot, RateLimitWindow } from "./types.ts";

function tempPool(accountNames: string[]): { poolDir: string; mgr: AccountManager } {
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
  const config = loadConfig({ poolDir, accountsDir, usageFile: join(poolDir, "usage.json") });
  return { poolDir, mgr: new AccountManager(config) };
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

test("accounts with no snapshot yet are treated as full headroom (no penalty)", async () => {
  const { poolDir, mgr } = tempPool(["no-data", "known-partial"]);
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
    expect(mgr.pick(undefined, undefined, "fable")).toBeNull();
    expect(mgr.pick(undefined, undefined, "sonnet")?.name).toBe("fable-spent");
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

    expect(mgr.pick(undefined, undefined, "fable")?.name).toBe("fable-cool");
    expect(mgr.pick(undefined, undefined, "sonnet")?.name).toBe("fable-hot");
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("session affinity re-routes when the pinned account's model window is spent", async () => {
  const { poolDir, mgr } = tempPool(["pinned", "fallback"]);
  try {
    expect(mgr.pick("session-1", undefined, "fable")?.name).toBeDefined();
    const pinned = mgr.pick("session-1", undefined, "fable")!.name;
    const other = pinned === "pinned" ? "fallback" : "pinned";

    mgr.recordRateLimitSnapshot(
      pinned,
      snapshot([win("7d-fable", { status: "rejected", utilization: 1, reset: Date.now() + 60 * 60_000 })]),
    );

    expect(mgr.pick("session-1", undefined, "fable")?.name).toBe(other);
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

    const config = loadConfig({ poolDir, accountsDir: join(poolDir, "accounts"), usageFile });
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
    expect(mgr.pick(undefined, undefined, "fable")).toBeNull();
    expect(mgr.pick(undefined, undefined, "sonnet")?.name).toBe("a");
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});
