import { test, expect } from "bun:test";
import { mapCodexUsageResponse } from "./codex-usage.ts";

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
