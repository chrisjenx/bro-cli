import { test, expect } from "bun:test";
import { mapUsageResponse, fetchUsageSnapshot, maybeRefreshUsage } from "./usage.ts";
import { loadConfig } from "../config.ts";
import type { RateLimitSnapshot } from "../accounts/types.ts";

function fakeMgr(): any {
  return { getOAuthCreds: () => ({ accessToken: "tok", refreshToken: "r", expiresAt: Date.now() + 3_600_000, scopes: [] }) };
}
const acct: any = { name: "a" };

// Trimmed from a real /api/oauth/usage capture (2026-07-12).
const SAMPLE = {
  five_hour: { utilization: 39.0, resets_at: "2026-07-13T07:59:59.883087+00:00" },
  seven_day: { utilization: 81.0, resets_at: "2026-07-15T08:59:59.883113+00:00" },
  seven_day_opus: null,
  limits: [
    { kind: "session", group: "session", percent: 39, severity: "normal", resets_at: "2026-07-13T07:59:59.883087+00:00", scope: null, is_active: false },
    { kind: "weekly_all", group: "weekly", percent: 81, severity: "warning", resets_at: "2026-07-15T08:59:59.883113+00:00", scope: null, is_active: true },
    { kind: "weekly_scoped", group: "weekly", percent: 68, severity: "normal", resets_at: "2026-07-15T08:59:59.883475+00:00", scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: false },
  ],
};

test("maps limits[] to windows with fraction utilization and ms resets", () => {
  const snap = mapUsageResponse(SAMPLE, 1_000)!;
  expect(snap).not.toBeNull();
  expect(snap.updatedAt).toBe(1_000);
  const w5 = snap.windows.find((w) => w.key === "5h")!;
  expect(w5.model).toBeNull();
  expect(w5.utilization).toBeCloseTo(0.39, 5);
  expect(w5.reset).toBe(Date.parse("2026-07-13T07:59:59.883087+00:00"));
  const w7 = snap.windows.find((w) => w.key === "7d")!;
  expect(w7.utilization).toBeCloseTo(0.81, 5);
  const wf = snap.windows.find((w) => w.key === "7d-fable")!;
  expect(wf.model).toBe("fable");
  expect(wf.utilization).toBeCloseTo(0.68, 5);
});

test("skips scoped limits with an unrecognized model name", () => {
  const snap = mapUsageResponse({
    limits: [{ kind: "weekly_scoped", percent: 10, resets_at: "2026-07-15T00:00:00Z", scope: { model: { display_name: "Nonesuch 9" } } }],
  }, 1)!;
  expect(snap).toBeNull();
});

test("falls back to top-level resets_at when a limit omits it", () => {
  const snap = mapUsageResponse({
    five_hour: { utilization: 5, resets_at: "2026-07-13T07:00:00Z" },
    limits: [{ kind: "session", percent: 5, scope: null }],
  }, 1)!;
  const w5 = snap.windows.find((w) => w.key === "5h")!;
  expect(w5.reset).toBe(Date.parse("2026-07-13T07:00:00Z"));
});

test("falls back to top-level objects when limits[] absent", () => {
  const snap = mapUsageResponse({
    five_hour: { utilization: 12, resets_at: "2026-07-13T07:00:00Z" },
    seven_day: { utilization: 90, resets_at: "2026-07-15T00:00:00Z" },
    seven_day_opus: null,
  }, 1)!;
  expect(snap.windows.map((w) => w.key).sort()).toEqual(["5h", "7d"]);
  expect(snap.windows.find((w) => w.key === "7d")!.utilization).toBeCloseTo(0.9, 5);
});

test("marks a fully-consumed window rejected", () => {
  const snap = mapUsageResponse({ limits: [{ kind: "session", percent: 100, resets_at: "2026-07-13T07:00:00Z", scope: null }] }, 1)!;
  expect(snap.windows[0]!.status).toBe("rejected");
  expect(snap.unifiedStatus).toBe("rejected");
});

test("returns null for empty/garbage input", () => {
  expect(mapUsageResponse(null, 1)).toBeNull();
  expect(mapUsageResponse({}, 1)).toBeNull();
});

test("backfills 5h/7d from top-level even when limits[] is partial", () => {
  // session present but its percent is null (5h window inactive in limits[]);
  // weekly_all fills 7d. The top-level five_hour still carries the real 5h data.
  const snap = mapUsageResponse({
    five_hour: { utilization: 95, resets_at: "2026-07-13T07:00:00Z" },
    limits: [
      { kind: "session", percent: null, resets_at: "2026-07-13T07:00:00Z", scope: null },
      { kind: "weekly_all", percent: 40, resets_at: "2026-07-15T00:00:00Z", scope: null },
    ],
  }, 1)!;
  expect(snap.windows.find((w) => w.key === "5h")!.utilization).toBeCloseTo(0.95, 5);
  expect(snap.windows.find((w) => w.key === "7d")!.utilization).toBeCloseTo(0.4, 5);
});

test("synthesizes a duration-bounded reset for a spent window missing resets_at", () => {
  const now = 1_000_000;
  const snap = mapUsageResponse({ limits: [{ kind: "weekly_all", percent: 100, scope: null }] }, now)!;
  const w = snap.windows.find((x) => x.key === "7d")!;
  expect(w.status).toBe("rejected");
  expect(w.reset).toBe(now + 7 * 24 * 60 * 60 * 1000); // now + windowDurationMs("7d")
});

test("fetchUsageSnapshot sends required headers and maps a 200", async () => {
  const calls: Request[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push(new Request(url, init));
    return new Response(JSON.stringify({ five_hour: { utilization: 20, resets_at: "2026-07-13T07:00:00Z" }, limits: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as any;
  try {
    const cfg = loadConfig();
    const snap = await fetchUsageSnapshot(acct, fakeMgr(), cfg);
    expect(snap!.windows.find((w) => w.key === "5h")!.utilization).toBeCloseTo(0.2, 5);
    const req = calls[0]!;
    expect(req.url).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(req.headers.get("authorization")).toBe("Bearer tok");
    expect(req.headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
    expect(req.headers.get("user-agent")).toBe("claude-code/2.1.207");
  } finally {
    globalThis.fetch = orig;
  }
});

test("fetchUsageSnapshot returns null on 429", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response("rate_limit", { status: 429 })) as any;
  try {
    expect(await fetchUsageSnapshot(acct, fakeMgr(), loadConfig())).toBeNull();
  } finally {
    globalThis.fetch = orig;
  }
});

test("fetchUsageSnapshot returns null on non-JSON body", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response("<html>nope", { status: 200 })) as any;
  try {
    expect(await fetchUsageSnapshot(acct, fakeMgr(), loadConfig())).toBeNull();
  } finally {
    globalThis.fetch = orig;
  }
});

test("fetchUsageSnapshot returns null when res.text() rejects", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    text: async () => {
      throw new Error("aborted mid-body");
    },
  })) as any;
  try {
    expect(await fetchUsageSnapshot(acct, fakeMgr(), loadConfig())).toBeNull();
  } finally {
    globalThis.fetch = orig;
  }
});

test("fetchUsageSnapshot returns null when signal combination throws", async () => {
  // Simulates a runtime lacking AbortSignal.any: the throw must be caught, not
  // propagated out of the fail-closed fetch.
  const origFetch = globalThis.fetch;
  const origAny = (AbortSignal as any).any;
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as any;
  (AbortSignal as any).any = () => {
    throw new Error("no AbortSignal.any");
  };
  try {
    const snap = await fetchUsageSnapshot(acct, fakeMgr(), loadConfig(), new AbortController().signal);
    expect(snap).toBeNull();
  } finally {
    globalThis.fetch = origFetch;
    (AbortSignal as any).any = origAny;
  }
});

function mgrSpy(overrides: any = {}) {
  const recorded: RateLimitSnapshot[] = [];
  const errors: string[] = [];
  return {
    recorded,
    errors,
    getOAuthCreds: () => ({ accessToken: "tok", refreshToken: "r", expiresAt: Date.now() + 3_600_000, scopes: [] }),
    recordUsageSnapshot: (_n: string, s: any) => recorded.push(s),
    recordUsageCheckError: (_n: string, m: string) => errors.push(m),
    ...overrides,
  } as any;
}

test("maybeRefreshUsage skips when the snapshot is fresh", async () => {
  let fetched = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => { fetched++; return new Response("{}", { status: 200 }); }) as any;
  try {
    const fresh: any = { name: "a", usage: { rateLimitStatus: { unifiedStatus: "allowed", windows: [], updatedAt: Date.now() } } };
    await maybeRefreshUsage(fresh, mgrSpy(), loadConfig());
    expect(fetched).toBe(0);
  } finally {
    globalThis.fetch = orig;
  }
});

test("maybeRefreshUsage coalesces concurrent calls into one fetch", async () => {
  let fetched = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => { fetched++; await new Promise((r) => setTimeout(r, 10)); return new Response(JSON.stringify({ five_hour: { utilization: 3, resets_at: "2026-07-13T07:00:00Z" }, limits: [] }), { status: 200 }); }) as any;
  try {
    const stale: any = { name: "dupe", usage: { rateLimitStatus: null } };
    const mgr = mgrSpy();
    await Promise.all([maybeRefreshUsage(stale, mgr, loadConfig()), maybeRefreshUsage(stale, mgr, loadConfig())]);
    expect(fetched).toBe(1);
    expect(mgr.recorded.length).toBeGreaterThanOrEqual(1);
  } finally {
    globalThis.fetch = orig;
  }
});

test("maybeRefreshUsage records an error when the fetch yields null", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response("nope", { status: 500 })) as any;
  try {
    const stale: any = { name: "err", usage: { rateLimitStatus: null } };
    const mgr = mgrSpy();
    await maybeRefreshUsage(stale, mgr, loadConfig());
    expect(mgr.errors.length).toBe(1);
    expect(mgr.recorded.length).toBe(0);
  } finally {
    globalThis.fetch = orig;
  }
});

test("maybeRefreshUsage backs off after a failed refresh, within the TTL", async () => {
  let fetched = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetched++;
    return new Response("nope", { status: 500 });
  }) as any;
  try {
    const usage: any = { rateLimitStatus: null, lastUsageCheckAt: null };
    const account: any = { name: "backoff", usage };
    const mgr = mgrSpy({
      recordUsageCheckError: (_n: string, m: string) => {
        usage.lastUsageCheckError = m;
        usage.lastUsageCheckAt = Date.now();
      },
      recordUsageSnapshot: (_n: string, s: any) => {
        usage.rateLimitStatus = s;
        usage.lastUsageCheckAt = Date.now();
      },
    });

    await maybeRefreshUsage(account, mgr, loadConfig());
    expect(fetched).toBe(1);
    expect(usage.lastUsageCheckAt).not.toBeNull();

    fetched = 0;
    await maybeRefreshUsage(account, mgr, loadConfig());
    expect(fetched).toBe(0);
  } finally {
    globalThis.fetch = orig;
  }
});

test("maybeRefreshUsage is a no-op when disabled", async () => {
  let fetched = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => { fetched++; return new Response("{}", { status: 200 }); }) as any;
  try {
    const stale: any = { name: "off", usage: { rateLimitStatus: null } };
    await maybeRefreshUsage(stale, mgrSpy(), loadConfig({ usageRefreshEnabled: false }));
    expect(fetched).toBe(0);
  } finally {
    globalThis.fetch = orig;
  }
});
