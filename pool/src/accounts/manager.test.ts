import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig } from "../config.ts";
import { AccountManager, type KeychainOps } from "./manager.ts";
import type { RateLimitSnapshot, RateLimitWindow } from "./types.ts";
import { OPENAI_CREDS_FILENAME } from "./types.ts";

function tempPool(
  accountNames: string[],
  keychain?: KeychainOps,
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
  const config = loadConfig({ poolDir, accountsDir, usageFile: join(poolDir, "usage.json") });
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
