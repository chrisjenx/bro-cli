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
import { anthropicServePlan, chooseMappedService, CROSS_PROVIDER_RETRY_STATUSES, serveWithCrossProviderFallback } from "./server.ts";
import type { FailoverHooks } from "./failover.ts";
import { RETRYABLE_TRANSPORT_HEADER } from "../upstream/shared.ts";

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

describe("serveWithCrossProviderFallback", () => {
  test("does not hop providers for a per-request upstream refusal", async () => {
    const failoverCalls: [string, string][] = [];
    const served: string[] = [];
    const serve = async (svc: "anthropic" | "openai") => {
      served.push(svc);
      return new Response("{}", { status: 429, headers: { "x-pool-upstream-rejected": "1" } });
    };
    const res = await serveWithCrossProviderFallback("anthropic", serve, trackingHooks(failoverCalls));
    expect(res.status).toBe(429);
    expect(served).toEqual(["anthropic"]);
    expect(failoverCalls).toEqual([]);
  });

  /** Records which providers were served, in order. */
  function trackingHooks(calls: Array<[string, string]>): FailoverHooks {
    return { onFailover: (from, to) => calls.push([from, to]) };
  }

  test("first succeeds -> returned as-is, other provider never called, no onFailover", async () => {
    const called: Array<"anthropic" | "openai"> = [];
    const failoverCalls: Array<[string, string]> = [];
    const first200 = new Response("ok", { status: 200, headers: { "X-Marker": "first" } });
    const serve = async (svc: "anthropic" | "openai") => {
      called.push(svc);
      return svc === "anthropic" ? first200 : new Response("should not be called", { status: 200 });
    };

    const res = await serveWithCrossProviderFallback("anthropic", serve, trackingHooks(failoverCalls));

    expect(res).toBe(first200);
    expect(called).toEqual(["anthropic"]);
    expect(failoverCalls).toEqual([]);
  });

  test("first exhausts (503) -> onFailover fires anthropic->openai, retry's 200 is returned", async () => {
    const called: Array<"anthropic" | "openai"> = [];
    const failoverCalls: Array<[string, string]> = [];
    const retry200 = new Response("ok", { status: 200, headers: { "X-Marker": "retry" } });
    const serve = async (svc: "anthropic" | "openai") => {
      called.push(svc);
      return svc === "anthropic" ? new Response("busy", { status: 503 }) : retry200;
    };

    const res = await serveWithCrossProviderFallback("anthropic", serve, trackingHooks(failoverCalls));

    expect(res).toBe(retry200);
    expect(called).toEqual(["anthropic", "openai"]);
    expect(failoverCalls).toEqual([["anthropic pool", "openai pool"]]);
  });

  test("both exhaust (503 then 429) -> the FIRST response object is returned", async () => {
    const failoverCalls: Array<[string, string]> = [];
    const first503 = new Response("busy", { status: 503, headers: { "X-Marker": "first" } });
    const retry429 = new Response("busy too", { status: 429, headers: { "X-Marker": "retry" } });
    const serve = async (svc: "anthropic" | "openai") => (svc === "anthropic" ? first503 : retry429);

    const res = await serveWithCrossProviderFallback("anthropic", serve, trackingHooks(failoverCalls));

    // Identity check, not just status: the caller must see the primary
    // provider's own response object, not merely "a 503".
    expect(res).toBe(first503);
    expect(res).not.toBe(retry429);
    expect(res.headers.get("X-Marker")).toBe("first");
  });

  test("mapped transport exhaustion falls back even when surfaced as 401 or 502", async () => {
    for (const status of [401, 502]) {
      const called: Array<"anthropic" | "openai"> = [];
      const retry200 = new Response("ok", { status: 200 });
      const serve = async (svc: "anthropic" | "openai") => {
        called.push(svc);
        return svc === "anthropic"
          ? new Response("transport failed", { status, headers: { [RETRYABLE_TRANSPORT_HEADER]: "1" } })
          : retry200;
      };

      expect(await serveWithCrossProviderFallback("anthropic", serve, {})).toBe(retry200);
      expect(called).toEqual(["anthropic", "openai"]);
    }
  });

  test("auth 401 and deterministic 502 do not fall back without transport classification", async () => {
    for (const status of [401, 502]) {
      const called: Array<"anthropic" | "openai"> = [];
      const first = new Response("terminal", { status });
      const serve = async (svc: "anthropic" | "openai") => {
        called.push(svc);
        return svc === "anthropic" ? first : new Response("should not be called", { status: 200 });
      };

      expect(await serveWithCrossProviderFallback("anthropic", serve, {})).toBe(first);
      expect(called).toEqual(["anthropic"]);
    }
  });

  test("non-retry error (400) from first -> returned as-is, no retry", async () => {
    const called: Array<"anthropic" | "openai"> = [];
    const failoverCalls: Array<[string, string]> = [];
    const first400 = new Response("bad request", { status: 400 });
    const serve = async (svc: "anthropic" | "openai") => {
      called.push(svc);
      return svc === "anthropic" ? first400 : new Response("should not be called", { status: 200 });
    };

    const res = await serveWithCrossProviderFallback("anthropic", serve, trackingHooks(failoverCalls));

    expect(res).toBe(first400);
    expect(called).toEqual(["anthropic"]);
    expect(failoverCalls).toEqual([]);
  });

  test("symmetric: first=openai retries onto anthropic", async () => {
    const called: Array<"anthropic" | "openai"> = [];
    const failoverCalls: Array<[string, string]> = [];
    const retry200 = new Response("ok", { status: 200, headers: { "X-Marker": "retry" } });
    const serve = async (svc: "anthropic" | "openai") => {
      called.push(svc);
      return svc === "openai" ? new Response("busy", { status: 529 }) : retry200;
    };

    const res = await serveWithCrossProviderFallback("openai", serve, trackingHooks(failoverCalls));

    expect(res).toBe(retry200);
    expect(called).toEqual(["openai", "anthropic"]);
    expect(failoverCalls).toEqual([["openai pool", "anthropic pool"]]);
  });
});

describe("anthropicServePlan", () => {
  const classifier = { model: "claude-sonnet-5", max_tokens: 64, system: "You are a security monitor for autonomous AI coding agents.", messages: [] };
  const normal = { model: "claude-sonnet-5", max_tokens: 64000, stream: true, tools: [{ name: "Bash" }], system: "You are a Claude agent.", messages: [] };

  test("classifier with a Sonnet mapping: anthropic first, cross-provider fallback kept, no session affinity", () => {
    const { poolDir, mgr } = crossProviderPool();
    try {
      const config = loadConfig({ classifierRoute: "anthropic" });
      const plan = anthropicServePlan(mgr, config, classifier, "sess", true);
      expect(plan).toEqual({ first: "anthropic", fallback: true, affinity: false, classifier: true });
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("classifier with anthropic accounts exhausted still starts on anthropic so the fallback can carry it", () => {
    const { poolDir, mgr } = crossProviderPool();
    try {
      mgr.markRateLimited("claude1", Date.now() + 60 * 60_000);
      const plan = anthropicServePlan(mgr, loadConfig({ classifierRoute: "anthropic" }), classifier, "sess", true);
      expect(plan?.first).toBe("anthropic");
      expect(plan?.fallback).toBe(true);
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("classifier without a mapping: anthropic only, no fallback", () => {
    const { poolDir, mgr } = crossProviderPool();
    try {
      const plan = anthropicServePlan(mgr, loadConfig({ classifierRoute: "anthropic" }), classifier, "sess", false);
      expect(plan).toEqual({ first: "anthropic", fallback: false, affinity: false, classifier: true });
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("ordinary mapped request: provider chosen by headroom, affinity kept; unmapped ordinary request: no plan", () => {
    const { poolDir, mgr } = crossProviderPool();
    try {
      const config = loadConfig({ classifierRoute: "anthropic" });
      const plan = anthropicServePlan(mgr, config, normal, "sess", true);
      expect(plan?.classifier).toBe(false);
      expect(plan?.fallback).toBe(true);
      expect(plan?.affinity).toBe(true);
      expect(["anthropic", "openai"]).toContain(plan?.first ?? "");
      expect(anthropicServePlan(mgr, config, normal, "sess", false)).toBeNull();
      expect(anthropicServePlan(mgr, loadConfig({ classifierRoute: "default" }), classifier, "sess", false)).toBeNull();
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });
});
