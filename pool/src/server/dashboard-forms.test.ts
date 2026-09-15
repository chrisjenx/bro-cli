import { expect, test } from "bun:test";
import { buildDashboardDescriptors } from "./dashboard.ts";
import { MODEL_FAMILIES, modelFamilyOf } from "../accounts/types.ts";
import { statusFixture } from "./dashboard-test-helpers.ts";
import type { AccountForm, MappingForm, TuningForm } from "./dashboard-types.ts";
const { createDashboardForms } = await import("./dashboard-forms.ts").catch(() => ({ createDashboardForms: undefined }));
const f = () => { expect(typeof createDashboardForms).toBe("function"); return createDashboardForms!(buildDashboardDescriptors()); };
const account: AccountForm = { account: "primary", priority: "2", weight: "1.5" };

test("one account payload contains both validated settings", () => {
  expect(f().prepareSave("account:primary", account, account, statusFixture())).toEqual({ ok: true, url: "/api/routing", payload: { account: "primary", priority: 2, weight: 1.5 } });
});
test("blank, fractional and partially numeric priority are rejected", () => {
  for (const priority of ["", "1x", "1.5", "-1", "Infinity"]) {
    expect(f().prepareSave("account:primary", { ...account, priority }, account, statusFixture()).ok).toBe(false);
  }
});
test("weight uses shared finite bounds and removed account cannot save", () => {
  for (const weight of ["", "0.05", "10.1", "2x", "NaN"]) {
    expect(f().prepareSave("account:primary", { ...account, weight }, account, statusFixture()).ok).toBe(false);
  }
  expect(f().prepareSave("account:primary", account, account, statusFixture([])).ok).toBe(false);
});
test("tuning sends only differences and accepts positive custom taper", () => {
  const latest: TuningForm = { fiveHourExp: "1", headroomTaperStart: "0.2", minHeadroom: "0.1" };
  const value = { ...latest, headroomTaperStart: "0.013" };
  expect(f().prepareSave("tuning", value, latest, statusFixture())).toEqual({ ok: true, url: "/api/tuning", payload: { headroomTaperStart: 0.013 } });
  expect(f().prepareSave("tuning", { ...value, headroomTaperStart: "0" }, latest, statusFixture()).ok).toBe(false);
});
test("target change clears only unsupported efforts, not unrelated family edits", () => {
  const value: MappingForm = { enabled: true, mappings: [{ from: "opus", to: "old", effort: { low: "high", high: "xhigh" } }, { from: "sonnet", to: "other", effort: { high: "high" } }] };
  const next = f().changeMappingTarget(value, "opus", "new", [{ id: "new", supportedEfforts: ["high"] }]);
  expect(next.clearedTiers).toEqual(["high"]);
  expect(next.value.mappings[0]!.effort).toEqual({ low: "high" });
  expect(next.value.mappings[1]).toEqual(value.mappings[1]);
  expect(value.mappings[0]!.to).toBe("old");
});
test("a disappeared mapping target is invalid, not converted to pass-through", () => {
  const value: MappingForm = { enabled: true, mappings: [{ from: "opus", to: "gone" }] };
  expect(f().prepareSave("mapping", value, value, statusFixture()).ok).toBe(false);
});
test("mapping save preserves full Claude model IDs and clears hidden effort overrides", () => {
  for (const to of ["claude-sonnet-4-6", "Claude-Opus-4-6[1m]"]) {
    const value: MappingForm = { enabled: true, mappings: [{ from: "opus", to, effort: { high: "high" } }] };
    expect(f().prepareSave("mapping", value, value, statusFixture())).toEqual({ ok: true, url: "/api/mappings", payload: { enabled: true, mappings: [{ from: "opus", to }] } });
  }
});
test("mapping save preserves configured Anthropic aliases without accepting missing targets", () => {
  const s = statusFixture();
  s.mapping.anthropicTargets = ["custom-claude-route"];
  const value: MappingForm = { enabled: true, mappings: [{ from: "opus", to: "custom-claude-route" }] };
  expect(f().prepareSave("mapping", value, value, s)).toEqual({ ok: true, url: "/api/mappings", payload: value });
  s.mapping.anthropicTargets = [];
  expect(f().prepareSave("mapping", value, value, s).ok).toBe(false);
});
test("explicit OpenAI targets take precedence over family-looking identifiers", () => {
  for (const to of ["opus", "custom-sonnet"]) {
    const s = statusFixture(); s.mapping.targets = [{ id: to, supportedEfforts: ["high"] }];
    const value: MappingForm = { enabled: true, mappings: [{ from: "opus", to, effort: { high: "high" } }] };
    expect(f().prepareSave("mapping", value, value, s)).toEqual({ ok: true, url: "/api/mappings", payload: value });
    expect(f().changeMappingTarget(value, "opus", to, s.mapping.targets).value).toEqual(value);
    value.mappings[0]!.effort = { high: "xhigh" };
    expect(f().prepareSave("mapping", value, value, s).ok).toBe(false);
  }
});
test("mapping payload excludes unrendered families and hidden pass-through efforts", () => {
  const value: MappingForm = { enabled: true, mappings: [{ from: "opus", to: "opus", effort: { high: "high" } }, { from: "future", to: "custom" }] };
  const result = f().prepareSave("mapping", value, value, statusFixture());
  expect(result).toEqual({ ok: true, url: "/api/mappings", payload: { enabled: true, mappings: [{ from: "opus", to: "opus" }] } });
});
test("mapping ack adapts mappingEnabled while preserving target metadata", () => {
  const s = statusFixture(); s.mapping.targets = [{ id: "target", supportedEfforts: ["high"] }];
  s.mapping.anthropicTargets = ["custom-claude-route"];
  const next = f().applyAck("mapping", { ok: true, mappingEnabled: true, mappings: [] }, s);
  expect(next.mapping.enabled).toBe(true);
  expect(next.mapping.targets).toEqual(s.mapping.targets);
  expect(next.mapping.anthropicTargets).toEqual(["custom-claude-route"]);
  expect(s.mapping.enabled).toBe(false);
});
test("malformed acknowledgements cannot claim a confirmed save", () => {
  const forms = f();
  for (const key of ["mapping", "tuning", "account:primary"] as const) {
    expect(() => forms.applyAck(key, { ok: true }, statusFixture())).toThrow();
  }
  expect(() => forms.applyAck("account:primary", { ok: true, account: "other", priority: 2, weight: 1 }, statusFixture())).toThrow();
});
test("server form fills new canonical families but retains unavailable targets", () => {
  const s = statusFixture(); s.mapping.mappings = [{ from: "opus", to: "gone" }];
  const m = f().readServerForm("mapping", s) as MappingForm;
  expect(m.mappings.find(x => x.from === "opus")!.to).toBe("gone");
  expect(m.mappings.find(x => x.from === "sonnet")!.to).toBe("sonnet");
});
test("serialized form factory performs validation without imported closures", () => {
  expect(typeof createDashboardForms).toBe("function");
  const familyOf = new Function("MODEL_FAMILIES", `return (${modelFamilyOf.toString()})`)(MODEL_FAMILIES);
  const forms = new Function(`return (${createDashboardForms!.toString()})`)()(buildDashboardDescriptors(), familyOf);
  expect(forms.prepareSave("account:primary", account, account, statusFixture()).payload.weight).toBe(1.5);
  const mapping: MappingForm = { enabled: true, mappings: [{ from: "opus", to: "Claude-Sonnet-4-6" }] };
  expect(forms.prepareSave("mapping", mapping, mapping, statusFixture()).ok).toBe(true);
});

test("numeric-looking model identifiers are not normalized as numbers", () => {
  const forms = f();
  expect(forms.equal({ enabled: true, mappings: [{ from: "opus", to: "001" }] }, { enabled: true, mappings: [{ from: "opus", to: "1" }] })).toBe(false);
  expect(forms.equal({ account: "primary", priority: "2.0", weight: "1.50" }, { account: "primary", priority: "2", weight: "1.5" })).toBe(true);
});
