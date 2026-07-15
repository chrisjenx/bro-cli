import { test, expect } from "bun:test";
import { durationToWindowKey } from "./codex-windows.ts";

const HOUR = 60 * 60 * 1000;

test("session-scale duration keys as 5h", () => {
  expect(durationToWindowKey(5 * HOUR, "primary")).toBe("5h");
  expect(durationToWindowKey(300 * 60_000, "secondary")).toBe("5h");
});

test("weekly-scale duration keys as 7d", () => {
  expect(durationToWindowKey(7 * 24 * HOUR, "primary")).toBe("7d");
  expect(durationToWindowKey(10080 * 60_000, "primary")).toBe("7d");
});

test("null/non-finite duration falls back to the slot default", () => {
  expect(durationToWindowKey(null, "primary")).toBe("5h");
  expect(durationToWindowKey(null, "secondary")).toBe("7d");
  expect(durationToWindowKey(Number.NaN, "primary")).toBe("5h");
});

test("the 24h boundary separates session from weekly", () => {
  expect(durationToWindowKey(23 * HOUR, "primary")).toBe("5h");
  expect(durationToWindowKey(24 * HOUR, "primary")).toBe("7d");
});
