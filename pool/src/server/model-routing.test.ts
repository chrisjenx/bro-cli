import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parseOpenAI } from "../adapters/openai.ts";
import { parseAnthropic } from "../adapters/anthropic.ts";
import { modelFamilyOf } from "../accounts/types.ts";
import type { RateLimitSnapshot, RateLimitWindow } from "../accounts/types.ts";
import { OPENAI_CREDS_FILENAME } from "../accounts/types.ts";
import { AccountManager } from "../accounts/manager.ts";
import { loadConfig } from "../config.ts";
import { chooseMappedService, CROSS_PROVIDER_RETRY_STATUSES } from "./server.ts";

/**
 * handleOpenAI/handleAnthropic in server.ts (the CLI-subprocess backend path)
 * must derive the routing `modelFamily` from `parsed.requestedModel` — the
 * raw model id the caller sent — not from `parsed.model`, which is the
 * CLI-resolved alias ("opus"/"sonnet"/"haiku") used only to pick a `claude`
 * CLI flag and can never represent "fable"/"mythos". These tests lock in the
 * distinction those handlers depend on.
 */

test("OpenAI adapter: requestedModel preserves the raw model id even though the CLI alias collapses it", () => {
  const parsed = parseOpenAI({
    model: "claude-fable-5",
    messages: [{ role: "user", content: "hi" }],
  });
  expect(parsed.model).toBe("sonnet"); // resolveModel() has no fable mapping
  expect(parsed.requestedModel).toBe("claude-fable-5");
  expect(modelFamilyOf(parsed.requestedModel)).toBe("fable");
  expect(modelFamilyOf(parsed.model)).not.toBe("fable");
});

test("Anthropic adapter: requestedModel preserves the raw model id even though the CLI alias collapses it", () => {
  const parsed = parseAnthropic({
    model: "claude-fable-5",
    messages: [{ role: "user", content: "hi" }],
  });
  expect(parsed.model).toBe("sonnet");
  expect(parsed.requestedModel).toBe("claude-fable-5");
  expect(modelFamilyOf(parsed.requestedModel)).toBe("fable");
});

/**
 * Mirrors the fixture style used by the "pickProvider" describe block in
 * accounts/manager.test.ts: one anthropic account + one openai account, built
 * via mgr.create() plus writing the credentials files pickProvider's usableFor
 * checks need to see each account as authenticated.
 */
function crossProviderPool(): { poolDir: string; mgr: AccountManager } {
  const poolDir = mkdtempSync(join(tmpdir(), "cmp-model-routing-"));
  const accountsDir = join(poolDir, "accounts");
  const config = loadConfig({
    poolDir,
    accountsDir,
    usageFile: join(poolDir, "usage.json"),
    sessionsFile: join(poolDir, "sessions.json"),
    routingStrategy: "expiring",
  });
  const mgr = new AccountManager(config);
  mgr.create("claude1");
  writeFileSync(
    join(mgr.configDirFor("claude1"), ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "at" } }),
  );
  mgr.create("gpt1");
  writeFileSync(join(mgr.configDirFor("gpt1"), OPENAI_CREDS_FILENAME), JSON.stringify({ accessToken: "at" }));
  return { poolDir, mgr };
}

function win(key: string, overrides: Partial<RateLimitWindow> = {}): RateLimitWindow {
  const model = key.split(/[-_]/).find((t) => !/^\d/.test(t)) ?? null;
  return { key, model, status: "allowed", utilization: null, reset: null, ...overrides };
}

function snapshot(windows: RateLimitWindow[]): RateLimitSnapshot {
  return { unifiedStatus: "allowed", windows, updatedAt: Date.now() };
}

describe("chooseMappedService", () => {
  test("returns the provider pickProvider selects, anthropic listed first", () => {
    // Only the openai account is usable -> "openai".
    {
      const { poolDir, mgr } = crossProviderPool();
      try {
        mgr.markRateLimited("claude1", Date.now() + 60 * 60_000);
        expect(chooseMappedService(mgr, undefined, "fable")).toBe("openai");
      } finally {
        rmSync(poolDir, { recursive: true, force: true });
      }
    }

    // Only the anthropic account is usable -> "anthropic".
    {
      const { poolDir, mgr } = crossProviderPool();
      try {
        mgr.markRateLimited("gpt1", Date.now() + 60 * 60_000);
        expect(chooseMappedService(mgr, undefined, "fable")).toBe("anthropic");
      } finally {
        rmSync(poolDir, { recursive: true, force: true });
      }
    }

    // Neither is usable -> null.
    {
      const { poolDir, mgr } = crossProviderPool();
      try {
        mgr.markRateLimited("claude1", Date.now() + 60 * 60_000);
        mgr.markRateLimited("gpt1", Date.now() + 60 * 60_000);
        expect(chooseMappedService(mgr, undefined, "fable")).toBeNull();
      } finally {
        rmSync(poolDir, { recursive: true, force: true });
      }
    }

    // Both usable, equal headroom -> ties keep anthropic (listed first) as the winner.
    {
      const { poolDir, mgr } = crossProviderPool();
      try {
        mgr.recordRateLimitSnapshot("claude1", snapshot([win("5h", { utilization: 0.5 })]));
        mgr.recordRateLimitSnapshot("gpt1", snapshot([win("5h", { utilization: 0.5 })]));
        expect(chooseMappedService(mgr, undefined, "fable")).toBe("anthropic");
      } finally {
        rmSync(poolDir, { recursive: true, force: true });
      }
    }
  });
});

describe("CROSS_PROVIDER_RETRY_STATUSES", () => {
  test("covers exhaustion statuses only", () => {
    expect([...CROSS_PROVIDER_RETRY_STATUSES].sort()).toEqual([429, 503, 529]);
    expect(CROSS_PROVIDER_RETRY_STATUSES.has(400)).toBe(false);
  });
});
