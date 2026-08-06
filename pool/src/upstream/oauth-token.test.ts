import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadConfig, type Config } from "../config.ts";
import { AccountManager } from "../accounts/manager.ts";
import { accessTokenFor } from "./oauth-token.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function tempPool(name: string): { poolDir: string; mgr: AccountManager; config: Config } {
  const poolDir = mkdtempSync(join(tmpdir(), "cmp-oauth-"));
  const accountsDir = join(poolDir, "accounts");
  mkdirSync(join(accountsDir, name), { recursive: true });
  writeFileSync(
    join(accountsDir, name, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "tok-" + name,
        refreshToken: "refresh-" + name,
        expiresAt: Date.now() + 3_600_000,
        subscriptionType: "max",
      },
    }),
  );
  const config = loadConfig({
    poolDir,
    accountsDir,
    usageFile: join(poolDir, "usage.json"),
    sessionsFile: join(poolDir, "sessions.json"),
    oauthTokenUrl: "https://oauth.test/token",
    usageRefreshEnabled: false,
  });
  return { poolDir, mgr: new AccountManager(config), config };
}

function respondWith(status: number, body: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

test("an invalid_grant refresh sidelines the account and explains the fix", async () => {
  const { poolDir, mgr, config } = tempPool("dead");
  try {
    respondWith(400, { error: "invalid_grant", error_description: "Refresh token expired" });

    // Raw OAuth JSON reads like a transient blip; the message must name the cure.
    await expect(accessTokenFor(mgr.getAccount("dead"), mgr, config, true)).rejects.toThrow(
      /accounts login/,
    );

    const account = mgr.getAccount("dead");
    expect(account.available).toBe(false);
    expect(account.unavailableReason).toContain("accounts login");
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("a transient OAuth failure leaves the account in rotation", async () => {
  const { poolDir, mgr, config } = tempPool("blip");
  try {
    respondWith(503, { error: { message: "upstream unavailable" } });

    await expect(accessTokenFor(mgr.getAccount("blip"), mgr, config, true)).rejects.toThrow();

    expect(mgr.getAccount("blip").available).toBe(true);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("a successful refresh clears an earlier invalid_grant sideline", async () => {
  const { poolDir, mgr, config } = tempPool("revived");
  try {
    mgr.markRefreshTokenDead("revived", "refresh-revived");
    expect(mgr.getAccount("revived").available).toBe(false);

    // The endpoint may hand back the same refresh token, so recovery cannot
    // rely on the fingerprint changing.
    respondWith(200, {
      access_token: "tok-new",
      refresh_token: "refresh-revived",
      expires_in: 3600,
    });

    const token = await accessTokenFor(mgr.getAccount("revived"), mgr, config, true);

    expect(token).toBe("tok-new");
    expect(mgr.getAccount("revived").available).toBe(true);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});
