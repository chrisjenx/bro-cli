import { expect, test } from "bun:test";
import { windowDurationMs, sortRateLimitWindows, type RateLimitWindow } from "../accounts/types.ts";
import { accountFixture, candidateFixture, FIXTURE_NOW as now, statusFixture } from "./dashboard-test-helpers.ts";
const { createDashboardPresentation } = await import("./dashboard-presentation.ts").catch(() => ({ createDashboardPresentation: undefined }));

const p = () => { expect(typeof createDashboardPresentation).toBe("function"); return createDashboardPresentation!(windowDurationMs, sortRateLimitWindows, { priority: 100, weight: 1 }); };
const window = (patch: Partial<RateLimitWindow> = {}): RateLimitWindow => ({ key: "5h", model: null, status: "allowed", utilization: 0, reset: now + 1000, ...patch });
const filters = { search: "", provider: "all", status: "all" } as const;
const sort = { key: "name", direction: "asc" } as const;

test("missing quota stays unknown while a reported zero stays zero", () => {
  const usage = accountFixture("a").usage;
  expect(p().projectWindow(null, usage, now).percent).toBeNull();
  expect(p().projectWindow(window(), usage, now).percent).toBe(0);
  expect(p().projectWindow(window({ utilization: null }), usage, now).provenance).toBe("missing");
});
test("expired known windows project a labeled reset, not fresh provider data", () => {
  const v = p().projectWindow(window({ utilization: 0.8, reset: now - 1000 }), accountFixture("a").usage, now);
  expect(v.percent).toBe(0);
  expect(v.resetAt).toBe(now + 18_000_000 - 1000);
  expect(v.provenance).toBe("assumed-reset");
  expect(v.reportedResetAt).toBe(now - 1000);
});
test("unrecognized expired windows retain observations without inventing boundaries", () => {
  const v = p().projectWindow(window({ key: "overage", utilization: 0.8, reset: now - 1 }), accountFixture("a").usage, now);
  expect(v.percent).toBe(80);
  expect(v.resetAt).toBeNull();
});
test("model-only limits never fill account-wide slots; details retain all windows", () => {
  const a = accountFixture("a", {}, { rateLimitStatus: { updatedAt: now, unifiedStatus: "allowed", windows: [window({ key: "7d-fable", model: "fable", utilization: 0.5 })] } });
  const s = statusFixture([a]);
  expect(p().overviewModel(s, filters, sort, now).rows[0]!.sevenDay.percent).toBeNull();
  expect(p().accountDetailModel(s, a, now).windows[0]!.percent).toBe(50);
});
test("missing numeric values sort last both ways", () => {
  const missing = accountFixture("a-missing");
  const zero = accountFixture("z-zero", {}, { rateLimitStatus: { updatedAt: now, unifiedStatus: null, windows: [window()] } });
  for (const direction of ["asc", "desc"] as const) {
    const m = p().overviewModel(statusFixture([missing, zero]), filters, { key: "fiveHour", direction }, now);
    expect(m.rows.map(r => r.account.name)).toEqual(["z-zero", "a-missing"]);
  }
});
test("filtered rows never change pool-wide totals or usage-warning availability", () => {
  const s = statusFixture([accountFixture("Alpha", { activeSessions: 2, inFlight: 1 }), accountFixture("backup", { provider: "openai" }, { lastUsageCheckError: "refresh failed" })]);
  const m = p().overviewModel(s, { ...filters, search: "ALP", provider: "anthropic" }, sort, now);
  expect(m.rows.map(r => r.account.name)).toEqual(["Alpha"]);
  expect(m.metrics).toEqual({ total: 2, available: 2, activeSessions: 2, inFlight: 1, unavailable: 0 });
  expect(p().overviewModel(s, { ...filters, status: "usage-warning" }, sort, now).rows.map(r => r.account.name)).toEqual(["backup"]);
});
test("routing preserves server order, winner priority and every noncandidate", () => {
  const s = statusFixture([accountFixture("claude", { priority: 1 }), accountFixture("codex", { priority: 100, provider: "openai" }), accountFixture("reserve", { priority: 110 }), accountFixture("busy", { inFlight: 4 })]);
  s.routingCombined = { activeTier: 1, tiers: [], candidates: [candidateFixture("claude", { score: 0.2 }), candidateFixture("codex", { score: 2 })], busy: [{ account: "busy", inFlight: 4, limit: 4 }], nextPick: { account: "codex", reason: { summary: "server reason", factors: [] } } };
  const m = p().routingModel(s);
  expect(m.winnerPriority).toBe(100);
  expect(m.candidates.map(r => r.account.name)).toEqual(["claude", "codex"]);
  expect(m.others.map(r => r.account.name)).toEqual(["reserve", "busy"]);
  expect(m.others[1]!.busy?.limit).toBe(4);
  expect(m.pickLabel).toBe("Hypothetical pick");
  expect(m.snapshot.nextPick?.reason.summary).toBe("server reason");
});
test("account-wide remains explicitly hypothetical with pooling disabled", () => {
  const s = statusFixture();
  expect(p().routingModel(s).contextLabel).toBe("Account-wide comparison");
  s.routingContext!.model = "opus";
  expect(p().routingModel(s).pickLabel).toBe("Next new session for opus");
});
test("removed detail keeps identity instead of substituting another account", () => {
  const m = p().accountDetailModel(statusFixture([]), accountFixture("removed"), now);
  expect(m.removed).toBe(true);
  expect(m.account.name).toBe("removed");
});
test("serialized factory executes independently and orders detail windows without mutating status", () => {
  expect(typeof createDashboardPresentation).toBe("function");
  const factory = new Function(`return (${createDashboardPresentation!.toString()})`)();
  const m = factory(windowDurationMs, sortRateLimitWindows, { priority: 100, weight: 1 });
  const windows = [window({ key: "7d-sonnet", model: "sonnet" }), window({ key: "7d" }), window(), window({ key: "7d-fable", model: "fable" })];
  const a = accountFixture("primary", {}, { rateLimitStatus: { updatedAt: now, unifiedStatus: "allowed", windows } });
  expect(m.accountDetailModel(statusFixture([a]), a, now).windows.map((w: RateLimitWindow) => w.key)).toEqual(["5h", "7d", "7d-fable", "7d-sonnet"]);
  expect(windows.map(w => w.key)).toEqual(["7d-sonnet", "7d", "5h", "7d-fable"]);
  expect(m.overviewModel(statusFixture(), filters, sort, now).metrics.total).toBe(1);
});

test("a billing-blocked account reads as Billing, not a generic sideline", () => {
  const a = accountFixture("a", { available: false, billingBlocked: true,
    unavailableReason: "Subscription or organization access rejected — rechecking in ~60 min" },
    { accessDeniedUntil: now + 3_600_000 });
  const row = p().overviewModel(statusFixture([a]), filters, sort, now).rows[0]!;
  expect(row.statusKey).toBe("billing");
  expect(row.statusLabel).toBe("Billing");
});

test("rows surface priority and weight only when they differ from the defaults", () => {
  const tuned = accountFixture("tuned", { priority: 101, weight: 2.5 });
  const plain = accountFixture("plain");
  const rows = p().overviewModel(statusFixture([plain, tuned]), filters, sort, now).rows;
  expect(rows.find(r => r.account.name === "plain")!.routingTweaks).toEqual([]);
  expect(rows.find(r => r.account.name === "tuned")!.routingTweaks).toEqual(["P101", "\u00d72.5"]);
});

test("a non-default priority alone is surfaced without a weight chip", () => {
  const a = accountFixture("a", { priority: 5 });
  const row = p().overviewModel(statusFixture([a]), filters, sort, now).rows[0]!;
  expect(row.routingTweaks).toEqual(["P5"]);
});

test("the 7d reset sorts on its own window, not the soonest one", () => {
  // Chosen so nextReset and the 7d reset disagree: "a-soon" resets its 5h
  // first but its 7d last, so a shared sort key would collapse the two.
  const win = (key: string, reset: number) => window({ key, utilization: 0.5, reset });
  const soon = accountFixture("a-soon", {}, { rateLimitStatus: { updatedAt: now, unifiedStatus: "allowed",
    windows: [win("5h", now + 1_000), win("7d", now + 900_000_000)] } });
  const late = accountFixture("z-late", {}, { rateLimitStatus: { updatedAt: now, unifiedStatus: "allowed",
    windows: [win("5h", now + 2_000), win("7d", now + 100_000_000)] } });
  const s = statusFixture([soon, late]);
  expect(p().overviewModel(s, filters, { key: "nextReset", direction: "asc" }, now).rows.map(r => r.account.name))
    .toEqual(["a-soon", "z-late"]);
  expect(p().overviewModel(s, filters, { key: "sevenDayReset", direction: "asc" }, now).rows.map(r => r.account.name))
    .toEqual(["z-late", "a-soon"]);
});

test("an unreported 7d reset sorts last rather than ahead of real timestamps", () => {
  const dated = accountFixture("a-dated", {}, { rateLimitStatus: { updatedAt: now, unifiedStatus: "allowed",
    windows: [window({ key: "7d", utilization: 0.5, reset: now + 100_000 })] } });
  const bare = accountFixture("b-bare");
  const m = p().overviewModel(statusFixture([bare, dated]), filters, { key: "sevenDayReset", direction: "asc" }, now);
  expect(m.rows.map(r => r.account.name)).toEqual(["a-dated", "b-bare"]);
  expect(m.rows[1]!.sevenDay.resetAt).toBeNull();
});
