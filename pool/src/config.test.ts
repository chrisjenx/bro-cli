import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";

const ENV_KEYS = [
  "TOKEN_REFRESH_TIMEOUT_MS",
  "STREAM_KEEPALIVE_MS",
  "OVERLOAD_RETRY_MAX",
  "OVERLOAD_RETRY_BASE_MS",
  "OVERLOAD_RETRY_MAX_DELAY_MS",
  "POOL_MAX_CONTEXT",
  "POOL_AUTO_COMPACT_WINDOW",
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

describe("context window cap", () => {
  test("defaults to 500K", () => {
    delete process.env.POOL_MAX_CONTEXT;
    expect(loadConfig().contextWindowCap).toBe(500_000);
  });

  test("POOL_MAX_CONTEXT overrides it", () => {
    process.env.POOL_MAX_CONTEXT = "800000";
    expect(loadConfig().contextWindowCap).toBe(800_000);
  });

  test("out-of-range values clamp into what Claude Code accepts", () => {
    process.env.POOL_MAX_CONTEXT = "10000";
    expect(loadConfig().contextWindowCap).toBe(100_000);
    process.env.POOL_MAX_CONTEXT = "9999999";
    expect(loadConfig().contextWindowCap).toBe(1_000_000);
  });

  test("junk falls back to the default instead of NaN", () => {
    process.env.POOL_MAX_CONTEXT = "wide";
    expect(loadConfig().contextWindowCap).toBe(500_000);
  });
});

describe("auto-compact window override", () => {
  test("unset means null — the pool derives the window from the mapping", () => {
    delete process.env.POOL_AUTO_COMPACT_WINDOW;
    expect(loadConfig().autoCompactWindowOverride).toBeNull();
  });

  test("POOL_AUTO_COMPACT_WINDOW pins the session window explicitly", () => {
    process.env.POOL_AUTO_COMPACT_WINDOW = "300000";
    expect(loadConfig().autoCompactWindowOverride).toBe(300_000);
  });

  test("an out-of-range override clamps rather than being emitted unusable", () => {
    process.env.POOL_AUTO_COMPACT_WINDOW = "5000";
    expect(loadConfig().autoCompactWindowOverride).toBe(100_000);
  });

  test("junk is ignored, not treated as zero", () => {
    process.env.POOL_AUTO_COMPACT_WINDOW = "auto";
    expect(loadConfig().autoCompactWindowOverride).toBeNull();
  });

  test("zero is treated as unset, not as a valid window", () => {
    process.env.POOL_AUTO_COMPACT_WINDOW = "0";
    expect(loadConfig().autoCompactWindowOverride).toBeNull();
  });

  test("negative values are treated as unset, not clamped to the floor", () => {
    process.env.POOL_AUTO_COMPACT_WINDOW = "-100";
    expect(loadConfig().autoCompactWindowOverride).toBeNull();
  });
});
