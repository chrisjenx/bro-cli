import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig } from "../config.ts";
import { AccountManager } from "./manager.ts";
import type { RateLimitSnapshot } from "./types.ts";

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
    requestsLimit: null,
    requestsRemaining: null,
    requestsReset: null,
    tokensLimit: null,
    tokensRemaining: null,
    tokensReset: null,
    inputTokensLimit: null,
    inputTokensRemaining: null,
    inputTokensReset: null,
    outputTokensLimit: null,
    outputTokensRemaining: null,
    outputTokensReset: null,
    updatedAt: Date.now(),
    ...overrides,
  };
}

test("pick() prefers the account with more real headroom over pure round-robin", async () => {
  const { poolDir, mgr } = tempPool(["low-headroom", "high-headroom"]);
  try {
    mgr.recordRateLimitSnapshot(
      "low-headroom",
      snapshot({ requestsLimit: 100, requestsRemaining: 5, tokensLimit: 100000, tokensRemaining: 5000 }),
    );
    mgr.recordRateLimitSnapshot(
      "high-headroom",
      snapshot({ requestsLimit: 100, requestsRemaining: 90, tokensLimit: 100000, tokensRemaining: 90000 }),
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
      snapshot({ requestsLimit: 100, requestsRemaining: 50, tokensLimit: 100000, tokensRemaining: 50000 }),
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

test("getAccount() proactively sidelines an account with zero remaining headroom before its reset", async () => {
  const { poolDir, mgr } = tempPool(["exhausted"]);
  try {
    mgr.recordRateLimitSnapshot(
      "exhausted",
      snapshot({
        requestsLimit: 100,
        requestsRemaining: 0,
        requestsReset: Date.now() + 10 * 60_000,
        tokensLimit: 100000,
        tokensRemaining: 50000,
      }),
    );

    const acct = mgr.getAccount("exhausted");
    expect(acct.available).toBe(false);
    expect(acct.unavailableReason).toMatch(/usage limit reached \(requests\)/);
    expect(mgr.pick()).toBeNull();
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("an account with zero remaining is available again once its reset has passed", async () => {
  const { poolDir, mgr } = tempPool(["reset-account"]);
  try {
    mgr.recordRateLimitSnapshot(
      "reset-account",
      snapshot({ requestsLimit: 100, requestsRemaining: 0, requestsReset: Date.now() - 1000 }),
    );

    const acct = mgr.getAccount("reset-account");
    expect(acct.available).toBe(true);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});
