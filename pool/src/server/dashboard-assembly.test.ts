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

test("the weight input steps by 0.1 rather than whole units", () => {
  const html = dashboard.dashboardHtml();
  const input = html.match(/<input[^>]*name="weight"[^>]*>/)![0];
  expect(input).toContain('step="0.1"');
  // min/max are assigned at init from shared.minWeight/maxWeight, so the markup
  // deliberately does not carry a second copy of the bounds.
  expect(input).not.toContain("min=");
  expect(input).not.toContain("max=");
});

test("account rows carry a slot for non-default routing knobs", () => {
  expect(dashboard.dashboardClientScript()).toContain("data-row-tweaks");
});

test("the account drawer offers a recheck control posting to /api/recheck", () => {
  expect(dashboard.dashboardHtml()).toContain("data-recheck");
  expect(dashboard.dashboardClientScript()).toContain("/api/recheck");
});

test("the status filter can isolate billing-blocked accounts", () => {
  expect(dashboard.dashboardHtml()).toContain('<option value="billing">');
});
