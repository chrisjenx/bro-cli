import { expect, test } from "bun:test";
import * as dashboard from "./dashboard.ts";

test("embedded JSON round-trips without terminating a script", () => {
  const safeJson = (dashboard as Record<string, unknown>).safeJson;
  expect(typeof safeJson).toBe("function");
  const value = { name: "</script><script>alert(1)</script>  " };
  const encoded = (safeJson as (v: unknown) => string)(value);
  expect(encoded).not.toContain("</script>");
  expect(encoded).not.toContain(" ");
  expect(JSON.parse(encoded)).toEqual(value);
});

test("emitted duration helper executes with its runtime dependency", () => {
  const source = (dashboard as Record<string, unknown>).dashboardDurationSource;
  expect(typeof source).toBe("function");
  const duration = new Function(`return ${(source as () => string)()}`)();
  expect(duration("5h")).toBe(18_000_000);
  expect(duration("7d-fable")).toBe(604_800_000);
  expect(duration("overage")).toBeNull();
});
