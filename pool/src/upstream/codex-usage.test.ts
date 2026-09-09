import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig } from "../config.ts";
import { AccountManager } from "../accounts/manager.ts";
import { OPENAI_CREDS_FILENAME } from "../accounts/types.ts";
import { CODEX_TOKEN_URL } from "./codex-constants.ts";
import { fetchCodexUsageSnapshot, mapCodexUsageResponse, maybeRefreshCodexUsage } from "./codex-usage.ts";

// Trimmed from a real GET /backend-api/wham/usage capture (2026-07-14):
// weekly window in the primary slot, 100% used but still allowed (unenforced).
const UNENFORCED = {
  plan_type: "plus",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 100, limit_window_seconds: 604800, reset_after_seconds: 583719, reset_at: 1784666164 },
    secondary_window: null,
  },
  rate_limit_reached_type: null,
};

test("keys the weekly-in-primary window as 7d, allowed, not spent", () => {
  const snap = mapCodexUsageResponse(UNENFORCED, 1_000)!;
  expect(snap).not.toBeNull();
  const w = snap.windows.find((x) => x.key === "7d")!;
  expect(w.model).toBeNull();
  expect(w.utilization).toBeCloseTo(1, 5);
  expect(w.status).toBe("allowed");
  expect(w.reset).toBe(1784666164 * 1000);
  expect(snap.windows.find((x) => x.key === "5h")).toBeUndefined();
  expect(snap.unifiedStatus).toBe("allowed");
});

test("marks windows rejected when the limit is enforced", () => {
  const enforced = {
    rate_limit: {
      allowed: false,
      limit_reached: true,
      primary_window: { used_percent: 100, limit_window_seconds: 604800, reset_at: 1784666164 },
      secondary_window: null,
    },
  };
  const snap = mapCodexUsageResponse(enforced, 1_000)!;
  expect(snap.windows.find((x) => x.key === "7d")?.status).toBe("rejected");
  expect(snap.unifiedStatus).toBe("rejected");
});

test("under an enforced weekly limit, an unfull session window stays allowed", () => {
  const enforcedWeekly = {
    rate_limit: {
      allowed: false,
      limit_reached: true,
      primary_window: { used_percent: 100, limit_window_seconds: 604800, reset_at: 1784666164 }, // weekly, full
      secondary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: 1784600000 }, // 5h, not full
    },
  };
  const snap = mapCodexUsageResponse(enforcedWeekly, 1_000)!;
  // Only the full weekly window is spent; the low-usage session window must NOT
  // be marked rejected, else the account would un-bench at the sooner 5h reset.
  expect(snap.windows.find((x) => x.key === "7d")?.status).toBe("rejected");
  expect(snap.windows.find((x) => x.key === "5h")?.status).toBe("allowed");
  expect(snap.unifiedStatus).toBe("rejected");
});

test("reads both windows and falls back to reset_after_seconds", () => {
  const both = {
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 40, limit_window_seconds: 18000, reset_after_seconds: 3600 },
      secondary_window: { used_percent: 12, limit_window_seconds: 604800, reset_at: 1784666164 },
    },
  };
  const snap = mapCodexUsageResponse(both, 5_000)!;
  expect(snap.windows.find((x) => x.key === "5h")?.reset).toBe(5_000 + 3600 * 1000);
  expect(snap.windows.find((x) => x.key === "7d")?.utilization).toBeCloseTo(0.12, 5);
});

test("returns null when there is no rate_limit data", () => {
  expect(mapCodexUsageResponse({ plan_type: "plus" }, 1_000)).toBeNull();
  expect(mapCodexUsageResponse(null, 1_000)).toBeNull();
});

for (const retryStatus of [200, 401]) {
  test(`refreshes a locally fresh token rejected by usage, retry returns ${retryStatus}`, async () => {
    const dir = mkdtempSync(join(process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, "tmp") : tmpdir(), "codex-usage-"));
    try {
      const accountsDir = join(dir, "accounts");
      mkdirSync(join(accountsDir, "test"), { recursive: true });
      writeFileSync(join(accountsDir, "test", OPENAI_CREDS_FILENAME), JSON.stringify({
        accessToken: "old", refreshToken: "refresh", accountId: "acct", expiresAt: Date.now() + 604800000,
      }));
      const config = loadConfig({ poolDir: dir, accountsDir, usageFile: join(dir, "usage.json"), sessionsFile: join(dir, "sessions.json") });
      const mgr = new AccountManager(config);
      let usageCalls = 0;
      let refreshCalls = 0;
      const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url) === CODEX_TOKEN_URL) {
          refreshCalls++;
          return Response.json({ access_token: "new", refresh_token: "rotated", expires_in: 3600 });
        }
        usageCalls++;
        const headers = new Headers(init?.headers);
        if (headers.get("authorization") === "Bearer old" || retryStatus === 401) return new Response("expired", { status: 401 });
        expect(headers.get("authorization")).toBe("Bearer new");
        expect(headers.get("chatgpt-account-id")).toBe("acct");
        return Response.json(UNENFORCED);
      }) as typeof fetch;
      const result = fetchCodexUsageSnapshot(mgr.listAccounts()[0]!, mgr, config, fetchFn);
      if (retryStatus === 200) expect((await result)?.unifiedStatus).toBe("allowed");
      else await expect(result).rejects.toThrow("HTTP 401");
      expect(usageCalls).toBe(2);
      expect(refreshCalls).toBe(1);
      expect(mgr.getOpenAICreds("test")?.accessToken).toBe("new");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("reports usage HTTP failures instead of hiding the cause", async () => {
  const mgr = { getOpenAICreds: () => ({ accessToken: "token", expiresAt: Date.now() + 3600000 }) } as unknown as AccountManager;
  const account = { name: "http-failure" } as Parameters<typeof fetchCodexUsageSnapshot>[0];
  const fetchFn = (async (_url: string | URL | Request) => new Response("private upstream body", { status: 429 })) as typeof fetch;
  await expect(fetchCodexUsageSnapshot(account, mgr, loadConfig(), fetchFn)).rejects.toThrow("Codex usage request failed (HTTP 429)");
});

test("gives each usage attempt its own timeout after a slow token refresh", async () => {
  let creds = { accessToken: "old", refreshToken: "refresh", expiresAt: Date.now() + 3600000 };
  const mgr = {
    getOpenAICreds: () => creds,
    updateOpenAICreds: (_: string, next: typeof creds) => { creds = next; },
  } as unknown as AccountManager;
  const account = { name: "slow-refresh" } as Parameters<typeof fetchCodexUsageSnapshot>[0];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === CODEX_TOKEN_URL) {
      await Bun.sleep(40);
      return Response.json({ access_token: "new", expires_in: 3600 });
    }
    init?.signal?.throwIfAborted();
    return new Headers(init?.headers).get("authorization") === "Bearer old"
      ? new Response("expired", { status: 401 }) : Response.json(UNENFORCED);
  }) as typeof fetch;
  const snap = await fetchCodexUsageSnapshot(account, mgr, loadConfig({ usageFetchTimeoutMs: 10 }), fetchFn);
  expect(snap?.unifiedStatus).toBe("allowed");
});


test("reports rejected refresh credentials without exposing the upstream body", async () => {
  const mgr = { getOpenAICreds: () => ({ accessToken: "old", refreshToken: "secret", expiresAt: Date.now() + 3600000 }) } as unknown as AccountManager;
  const account = { name: "rejected-refresh" } as Parameters<typeof fetchCodexUsageSnapshot>[0];
  const fetchFn = (async (url: string | URL | Request) => String(url) === CODEX_TOKEN_URL
    ? new Response("sensitive-provider-body", { status: 400 })
    : new Response("expired", { status: 401 })) as typeof fetch;
  await expect(fetchCodexUsageSnapshot(account, mgr, loadConfig(), fetchFn)).rejects.toThrow(
    "Codex token refresh failed (HTTP 400); re-run accounts login",
  );
});

for (const status of [401, 403]) {
  test(`reuses credentials rotated during a usage request returning ${status}`, async () => {
    let creds = { accessToken: "old", refreshToken: "refresh", accountId: "acct", expiresAt: Date.now() + 3600000 };
    const mgr = {
      getOpenAICreds: () => creds,
      updateOpenAICreds: (_: string, next: typeof creds) => { creds = next; },
    } as unknown as AccountManager;
    const account = { name: `concurrent-refresh-${status}` } as Parameters<typeof fetchCodexUsageSnapshot>[0];
    let usageCalls = 0;
    let refreshCalls = 0;
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === CODEX_TOKEN_URL) {
        refreshCalls++;
        return new Response("unexpected redundant refresh", { status: 500 });
      }
      usageCalls++;
      if (usageCalls === 1) {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer old");
        // Another request completed its token refresh while this request was in flight.
        creds = { ...creds, accessToken: "new", refreshToken: "rotated" };
        return new Response("expired", { status });
      }
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer new");
      return Response.json(UNENFORCED);
    }) as typeof fetch;
    expect((await fetchCodexUsageSnapshot(account, mgr, loadConfig(), fetchFn))?.unifiedStatus).toBe("allowed");
    expect(usageCalls).toBe(2);
    expect(refreshCalls).toBe(0);
  });
}

// A serving Codex account has its rateLimitStatus.updatedAt bumped by the
// per-response x-codex-* header tap. Those headers only describe the request
// that just happened: they cannot report that a limit was lifted upstream
// (e.g. the user spent a "Reset usage" credit). Only GET /wham/usage can. So
// the ground-truth poll must run on its own cadence, keyed to its own
// lastUsageCheckAt, rather than being starved by header-tap freshness.
function pollAccount(name: string, usage: Record<string, unknown>): Parameters<typeof maybeRefreshCodexUsage>[0] {
  return { name, provider: "openai", authenticated: true, usage } as unknown as Parameters<typeof maybeRefreshCodexUsage>[0];
}

function pollMgr(): { mgr: AccountManager; snapshots: string[]; errors: string[] } {
  const snapshots: string[] = [];
  const errors: string[] = [];
  const mgr = {
    getOpenAICreds: () => ({ accessToken: "tok", refreshToken: "r", accountId: "acct", expiresAt: Date.now() + 3_600_000 }),
    updateOpenAICreds: () => {},
    recordUsageSnapshot: (n: string) => snapshots.push(n),
    recordUsageCheckError: (n: string, m: string) => errors.push(`${n}: ${m}`),
  } as unknown as AccountManager;
  return { mgr, snapshots, errors };
}

test("polls ground truth for a busy account whose header tap keeps updatedAt fresh", async () => {
  const { mgr, snapshots, errors } = pollMgr();
  let usageCalls = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request) => { usageCalls++; return Response.json(UNENFORCED); }) as unknown as typeof fetch;
  try {
    // Header tap ran 2s ago (account is serving); the usage endpoint has not
    // been polled in 20 minutes. This is the starvation case seen in the wild.
    await maybeRefreshCodexUsage(
      pollAccount("busy", {
        rateLimitStatus: { unifiedStatus: "rejected", windows: [], updatedAt: Date.now() - 2_000 },
        lastUsageCheckAt: Date.now() - 1_200_000,
      }),
      mgr,
      loadConfig(),
    );
  } finally {
    globalThis.fetch = orig;
  }
  expect(errors).toEqual([]);
  expect(usageCalls).toBe(1);
  expect(snapshots).toEqual(["busy"]);
});

test("still honours its own poll cadence after a recent usage check", async () => {
  const { mgr, snapshots } = pollMgr();
  let usageCalls = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request) => { usageCalls++; return Response.json(UNENFORCED); }) as unknown as typeof fetch;
  try {
    await maybeRefreshCodexUsage(
      pollAccount("recently-checked", {
        rateLimitStatus: { unifiedStatus: "allowed", windows: [], updatedAt: Date.now() - 1_200_000 },
        lastUsageCheckAt: Date.now() - 5_000,
      }),
      mgr,
      loadConfig(),
    );
  } finally {
    globalThis.fetch = orig;
  }
  expect(usageCalls).toBe(0);
  expect(snapshots).toEqual([]);
});
