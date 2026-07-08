import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig } from "../config.ts";
import { AccountManager } from "./manager.ts";
import type { RateLimitSnapshot } from "./types.ts";
import { OPENAI_CREDS_FILENAME } from "./types.ts";

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

function snapshot(overrides: Partial<RateLimitSnapshot> = {}): RateLimitSnapshot {
  return {
    unifiedStatus: "allowed",
    fiveHourStatus: "allowed",
    fiveHourUtilization: null,
    fiveHourReset: null,
    sevenDayStatus: "allowed",
    sevenDayUtilization: null,
    sevenDayReset: null,
    updatedAt: Date.now(),
    ...overrides,
  };
}

test("pick() prefers the account with more real headroom over pure round-robin", async () => {
  const { poolDir, mgr } = tempPool(["low-headroom", "high-headroom"]);
  try {
    // low-headroom has burned 95% of its 5h window; high-headroom only 10%.
    mgr.recordRateLimitSnapshot(
      "low-headroom",
      snapshot({ fiveHourUtilization: 0.95, sevenDayUtilization: 0.5 }),
    );
    mgr.recordRateLimitSnapshot(
      "high-headroom",
      snapshot({ fiveHourUtilization: 0.1, sevenDayUtilization: 0.2 }),
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
      snapshot({ fiveHourUtilization: 0.5, sevenDayUtilization: 0.5 }),
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
      snapshot({
        fiveHourStatus: "rejected",
        fiveHourUtilization: 1,
        fiveHourReset: Date.now() + 10 * 60_000,
        sevenDayUtilization: 0.5,
      }),
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
      snapshot({ fiveHourStatus: "rejected", fiveHourUtilization: 1, fiveHourReset: Date.now() - 1000 }),
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
