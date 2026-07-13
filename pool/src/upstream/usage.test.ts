import { test, expect } from "bun:test";
import { mapUsageResponse, fetchUsageSnapshot } from "./usage.ts";
import { loadConfig } from "../config.ts";

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
