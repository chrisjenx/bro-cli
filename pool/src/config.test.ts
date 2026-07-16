import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";

const ENV_KEYS = [
  "TOKEN_REFRESH_TIMEOUT_MS",
  "STREAM_KEEPALIVE_MS",
  "OVERLOAD_RETRY_MAX",
  "OVERLOAD_RETRY_BASE_MS",
  "OVERLOAD_RETRY_MAX_DELAY_MS",
] as const;
const originalEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) originalEnv[key] = process.env[key];

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe("timeout/interval config floors", () => {
  test("TOKEN_REFRESH_TIMEOUT_MS below the floor is clamped up, not passed through", () => {
    process.env.TOKEN_REFRESH_TIMEOUT_MS = "-5000";
    expect(loadConfig().tokenRefreshTimeoutMs).toBe(1000);

    process.env.TOKEN_REFRESH_TIMEOUT_MS = "0";
    expect(loadConfig().tokenRefreshTimeoutMs).toBe(1000);
  });

  test("STREAM_KEEPALIVE_MS below the floor is clamped up, not passed through", () => {
    process.env.STREAM_KEEPALIVE_MS = "0";
    expect(loadConfig().streamKeepAliveMs).toBe(100);

    process.env.STREAM_KEEPALIVE_MS = "-1";
    expect(loadConfig().streamKeepAliveMs).toBe(100);
  });

  test("valid values above the floor pass through unchanged", () => {
    process.env.TOKEN_REFRESH_TIMEOUT_MS = "5000";
    process.env.STREAM_KEEPALIVE_MS = "2000";
    const config = loadConfig();
    expect(config.tokenRefreshTimeoutMs).toBe(5000);
    expect(config.streamKeepAliveMs).toBe(2000);
  });
});

test("usage-refresh config defaults", () => {
  const c = loadConfig();
  expect(c.usageRefreshEnabled).toBe(true);
  expect(c.usageRefreshTtlMs).toBe(120_000);
  expect(c.usageFetchTimeoutMs).toBe(2500);
  expect(c.usageUserAgent).toBe("claude-code/2.1.207");
});

test("overload backoff config defaults", () => {
  const c = loadConfig();
  expect(c.overloadRetryMax).toBe(4);
  expect(c.overloadRetryBaseMs).toBe(500);
  expect(c.overloadRetryMaxDelayMs).toBe(8000);
});

test("overload backoff knobs are env-overridable and floored at 0", () => {
  process.env.OVERLOAD_RETRY_MAX = "0"; // 0 is valid: disables backoff
  process.env.OVERLOAD_RETRY_BASE_MS = "-100"; // below floor → clamped to 0
  process.env.OVERLOAD_RETRY_MAX_DELAY_MS = "1500";
  const c = loadConfig();
  expect(c.overloadRetryMax).toBe(0);
  expect(c.overloadRetryBaseMs).toBe(0);
  expect(c.overloadRetryMaxDelayMs).toBe(1500);
});
