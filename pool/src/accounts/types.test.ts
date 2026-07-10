import { test, expect } from "bun:test";
import { windowDurationMs } from "./types.ts";

const H = 60 * 60_000;
const D = 24 * H;

test("windowDurationMs parses account-wide and model-scoped keys", () => {
  expect(windowDurationMs("5h")).toBe(5 * H);
  expect(windowDurationMs("7d")).toBe(7 * D);
  expect(windowDurationMs("7d-fable")).toBe(7 * D);
  expect(windowDurationMs("7d_oi")).toBe(7 * D);
  expect(windowDurationMs("30min")).toBe(30 * 60_000);
});

test("windowDurationMs returns null when there is no duration token", () => {
  expect(windowDurationMs("overage")).toBeNull();
  expect(windowDurationMs("fable")).toBeNull();
  expect(windowDurationMs("")).toBeNull();
});
