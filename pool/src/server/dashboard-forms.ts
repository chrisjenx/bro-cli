import type { ModelMapping, SourceEffortTier } from "../models.ts";
import { modelFamilyOf } from "../accounts/types.ts";
import type { AccountForm, DashboardStatus, FormKey, FormValue, MappingForm, MappingTarget, SharedDescriptors, TuningForm } from "./dashboard-types.ts";

/** Serialized factory: all validation bounds and capabilities arrive explicitly. */
export function createDashboardForms(shared: SharedDescriptors, familyOf = modelFamilyOf) {
  // Explicit OpenAI routes win even when their IDs contain a Claude family name.
  function classifyMappingTarget(id: string, mapping: DashboardStatus["mapping"]) {
    const target = mapping.targets.find(t => t.id === id);
    const pass = !target && (mapping.anthropicTargets?.includes(id) === true || familyOf(id) !== null);
    return { target, pass };
  }
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const numeric = (value: unknown) => typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  const validWeight = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= shared.minWeight && n <= shared.maxWeight;
  const validPriority = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;
  function readServerForm(key: FormKey, status: DashboardStatus): FormValue | null {
    if (key === "mapping") return { enabled: status.mapping.enabled, mappings: shared.families.map(from => clone(status.mapping.mappings.find(m => m.from === from) ?? { from, to: from })) };
    if (key === "tuning") return Object.fromEntries(shared.tuningFields.map(f => [f.key, String(status.tuning[f.key])])) as TuningForm;
    const account = status.accounts.find(a => a.name === key.slice(8));
    return account ? { account: account.name, priority: String(account.priority ?? shared.defaultPriority), weight: String(account.weight ?? shared.defaultWeight) } : null;
  }
  function prepareSave(key: FormKey, value: FormValue, latest: FormValue, status: DashboardStatus): { ok: true; url: string; payload: object } | { ok: false; errors: Record<string, string> } {
    const errors: Record<string, string> = {};
    if (key === "mapping") {
      const form = value as MappingForm;
      const mappings: ModelMapping[] = [];
      if (typeof form.enabled !== "boolean" || !Array.isArray(form.mappings)) return { ok: false, errors: { mapping: "Invalid mapping form" } };
      for (const row of form.mappings.filter(m => shared.families.includes(m.from))) {
        const { pass, target } = classifyMappingTarget(row.to, status.mapping);
        if (!pass && !target) errors[row.from] = `Target ${row.to} is unavailable. Choose a valid target.`;
        const effort: NonNullable<ModelMapping["effort"]> = {};
        if (!pass) for (const [tier, val] of Object.entries(row.effort ?? {})) {
          if (!shared.effortTiers.includes(tier as SourceEffortTier) || !target?.supportedEfforts.includes(val)) errors[row.from] = `Unsupported effort for ${row.from}: ${tier} → ${val}`;
          else effort[tier as SourceEffortTier] = val;
        }
        mappings.push({ from: row.from, to: row.to, ...(Object.keys(effort).length ? { effort } : {}) });
      }
      return Object.keys(errors).length ? { ok: false, errors } : { ok: true, url: "/api/mappings", payload: { enabled: form.enabled, mappings } };
    }
    if (key === "tuning") {
      const form = value as TuningForm, previous = latest as TuningForm;
      const patch: Record<string, number> = {};
      for (const f of shared.tuningFields) {
        const n = numeric(form[f.key]);
        if (!Number.isFinite(n) || n < f.min || n > f.max) errors[f.key] = `${f.label} must be between ${f.min} and ${f.max}.`;
        else if (n !== numeric(previous[f.key])) patch[f.key] = n;
      }
      return Object.keys(errors).length ? { ok: false, errors } : { ok: true, url: "/api/tuning", payload: patch };
    }
    const form = value as AccountForm;
    const name = key.slice(8), priority = numeric(form.priority), weight = numeric(form.weight);
    if (form.account !== name || !status.accounts.some(a => a.name === name)) errors.account = "This account is no longer available to edit.";
    if (!validPriority(priority)) errors.priority = "Priority must be a non-negative integer.";
    if (!validWeight(weight)) errors.weight = `Weight must be between ${shared.minWeight} and ${shared.maxWeight}.`;
    return Object.keys(errors).length ? { ok: false, errors } : { ok: true, url: "/api/routing", payload: { account: name, priority, weight } };
  }
  function applyAck(key: FormKey, raw: unknown, status: DashboardStatus): DashboardStatus {
    const body = raw as Record<string, unknown> | null;
    const incomplete = () => { throw new Error("Save could not be confirmed; the acknowledgement was incomplete."); };
    if (!body || body.ok !== true) return incomplete();
    if (key === "mapping") {
      if (typeof body.mappingEnabled !== "boolean" || !Array.isArray(body.mappings)
        || body.mappings.some(m => !m || typeof m.from !== "string" || typeof m.to !== "string")) return incomplete();
      return { ...status, mapping: { ...status.mapping, enabled: body.mappingEnabled, mappings: clone(body.mappings) } };
    }
    if (key === "tuning") {
      const tuning = body.tuning as DashboardStatus["tuning"] | undefined;
      if (!tuning || shared.tuningFields.some(f => typeof tuning[f.key] !== "number" || !Number.isFinite(tuning[f.key]) || tuning[f.key] < f.min || tuning[f.key] > f.max)) return incomplete();
      return { ...status, tuning: clone(tuning) };
    }
    if (body.account !== key.slice(8) || !validPriority(body.priority) || !validWeight(body.weight)) return incomplete();
    return { ...status, accounts: status.accounts.map(a => a.name === body.account ? { ...a, priority: body.priority as number, weight: body.weight as number } : a) };
  }
  function changeMappingTarget(value: MappingForm, family: string, target: string, targets: MappingTarget[]) {
    const next = clone(value);
    const row = next.mappings.find(m => m.from === family);
    const clearedTiers: SourceEffortTier[] = [];
    if (!row) return { value: next, clearedTiers };
    row.to = target;
    const supported = targets.find(t => t.id === target)?.supportedEfforts ?? [];
    for (const tier of Object.keys(row.effort ?? {}) as SourceEffortTier[]) {
      if (!supported.includes(row.effort![tier]!)) { delete row.effort![tier]; clearedTiers.push(tier); }
    }
    if (row.effort && Object.keys(row.effort).length === 0) delete row.effort;
    return { value: next, clearedTiers };
  }
  function equal(a: FormValue, b: FormValue): boolean {
    const numericKeys = new Set(["priority", "weight", ...shared.tuningFields.map(f => f.key)]);
    function canonical(value: unknown, key = ""): unknown {
      if (Array.isArray(value)) return value.map(item => canonical(item));
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v, k)]));
      if (numericKeys.has(key) && typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
      return value;
    }
    return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
  }
  return { readServerForm, prepareSave, applyAck, changeMappingTarget, classifyMappingTarget, equal };
}
export type DashboardForms = ReturnType<typeof createDashboardForms>;
