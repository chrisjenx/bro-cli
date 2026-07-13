/**
 * Anthropic's undocumented GET /api/oauth/usage returns ground-truth Claude
 * subscription usage — the same data behind `/usage`. This module fetches it
 * lazily at routing time and maps it into the pool's RateLimitSnapshot shape.
 */

import type { RateLimitSnapshot, RateLimitWindow } from "../accounts/types.ts";
import { modelFamilyOf, sortRateLimitWindows } from "../accounts/types.ts";
import { asObject, objectProp, stringProp, numberProp } from "./shared.ts";

function parseResetMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Convert a parsed /api/oauth/usage body into a RateLimitSnapshot. Prefers the
 * richer `limits[]` array (carries per-model scoped windows); falls back to the
 * top-level `five_hour`/`seven_day`/`seven_day_<model>` objects. `percent`/
 * `utilization` are 0–100 and get divided to the [0,1] fraction the pool uses.
 * Returns null when nothing usable is present.
 */
export function mapUsageResponse(
  json: Record<string, unknown> | null,
  now: number,
): RateLimitSnapshot | null {
  if (!json) return null;
  const windows: RateLimitWindow[] = [];
  const seen = new Set<string>();

  const push = (
    key: string,
    model: string | null,
    percent: number | undefined,
    resetsAt: string | undefined,
    fallbackResetsAt?: string,
  ): void => {
    if (percent == null || seen.has(key)) return;
    seen.add(key);
    const utilization = clamp01(percent / 100);
    windows.push({
      key,
      model,
      status: utilization >= 1 ? "rejected" : "allowed",
      utilization,
      reset: parseResetMs(resetsAt) ?? parseResetMs(fallbackResetsAt),
    });
  };

  const topResets = (topKey: string): string | undefined =>
    stringProp(objectProp(json, topKey), "resets_at");

  const limits = json.limits;
  if (Array.isArray(limits)) {
    for (const raw of limits) {
      const lim = asObject(raw);
      if (!lim) continue;
      const kind = stringProp(lim, "kind");
      const percent = numberProp(lim, "percent");
      const resetsAt = stringProp(lim, "resets_at");
      if (kind === "session") {
        push("5h", null, percent, resetsAt, topResets("five_hour"));
      } else if (kind === "weekly_all") {
        push("7d", null, percent, resetsAt, topResets("seven_day"));
      } else if (kind === "weekly_scoped") {
        const model = objectProp(objectProp(lim, "scope"), "model");
        const family = modelFamilyOf(stringProp(model, "display_name"));
        if (!family) {
          console.warn("[usage] skipping scoped limit with unrecognized model");
          continue;
        }
        push(`7d-${family}`, family, percent, resetsAt, topResets(`seven_day_${family}`));
      }
    }
  }

  // Fallback: derive from top-level objects when limits[] gave us nothing.
  if (windows.length === 0) {
    const top = (topKey: string, key: string, model: string | null): void => {
      const obj = objectProp(json, topKey);
      if (!obj) return;
      push(key, model, numberProp(obj, "utilization"), stringProp(obj, "resets_at"));
    };
    top("five_hour", "5h", null);
    top("seven_day", "7d", null);
    for (const f of ["fable", "mythos", "opus", "sonnet", "haiku"]) {
      top(`seven_day_${f}`, `7d-${f}`, f);
    }
  }

  if (windows.length === 0) return null;
  return {
    unifiedStatus: windows.some((w) => w.status === "rejected") ? "rejected" : "allowed",
    windows: sortRateLimitWindows(windows),
    updatedAt: now,
  };
}
