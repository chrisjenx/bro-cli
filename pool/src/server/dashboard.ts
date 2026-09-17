/** Self-contained dashboard: no asset routes, build step, or browser runtime dependencies. */
import { TUNING_BOUNDS, DEFAULT_PRIORITY, DEFAULT_WEIGHT, MIN_WEIGHT, MAX_WEIGHT } from "../accounts/manager.ts";
import { MODEL_FAMILIES, DURATION_TOKEN, windowDurationMs, modelFamilyOf, sortRateLimitWindows } from "../accounts/types.ts";
import { SOURCE_EFFORT_TIERS, CODEX_EFFORTS } from "../models.ts";
import type { SharedDescriptors } from "./dashboard-types.ts";
import { createDashboardPresentation } from "./dashboard-presentation.ts";
import { createDashboardForms } from "./dashboard-forms.ts";
import { createDashboardController } from "./dashboard-controller.ts";
import { dashboardShell } from "./dashboard-shell.ts";
import { DASHBOARD_STYLES } from "./dashboard-styles.ts";
import { OVERVIEW_SOURCE } from "./dashboard-overview.ts";
import { DRAWER_SOURCE } from "./dashboard-drawer.ts";
import { ROUTING_SOURCE } from "./dashboard-routing.ts";
import { SETTINGS_SOURCE } from "./dashboard-settings.ts";
import { BROWSER_SOURCE } from "./dashboard-browser.ts";

const TUNING_LABELS: Record<keyof typeof TUNING_BOUNDS, string> = {
  fiveHourExp: "5h weight", headroomTaperStart: "5h taper start", minHeadroom: "Min 5h headroom gate",
};

export function safeJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError("Cannot embed undefined JSON");
  return json.replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function dashboardDurationSource(): string {
  return `(() => { const DURATION_TOKEN = new RegExp(${safeJson(DURATION_TOKEN.source)}, ${safeJson(DURATION_TOKEN.flags)}); return (${windowDurationMs.toString()}); })()`;
}

export function buildDashboardDescriptors(): SharedDescriptors {
  return {
    families: MODEL_FAMILIES, effortTiers: SOURCE_EFFORT_TIERS, codexEfforts: CODEX_EFFORTS,
    defaultPriority: DEFAULT_PRIORITY, defaultWeight: DEFAULT_WEIGHT, minWeight: MIN_WEIGHT, maxWeight: MAX_WEIGHT,
    tuningFields: (Object.keys(TUNING_BOUNDS) as (keyof typeof TUNING_BOUNDS)[]).map(key => ({ key, label: TUNING_LABELS[key], ...TUNING_BOUNDS[key] })),
  };
}

export function dashboardClientScript(): string {
  return [
    '"use strict";\n(() => {',
    `const shared = ${safeJson(buildDashboardDescriptors())};`,
    `const durationMs = ${dashboardDurationSource()};`,
    `const presentation = (${createDashboardPresentation.toString()})(durationMs, (${sortRateLimitWindows.toString()}), { priority: shared.defaultPriority, weight: shared.defaultWeight });`,
    `const MODEL_FAMILIES = shared.families;`,
    `const forms = (${createDashboardForms.toString()})(shared, (${modelFamilyOf.toString()}));`,
    `const createController = (${createDashboardController.toString()});`,
    OVERVIEW_SOURCE, DRAWER_SOURCE, ROUTING_SOURCE, SETTINGS_SOURCE, BROWSER_SOURCE,
    `try { initializeDashboard(shared, presentation, forms, createController); }
     catch (error) { const node = document.getElementById('transport-error'); node.hidden = false; node.textContent = 'Dashboard could not start: ' + String(error); }`,
    '})();',
  ].join("\n");
}

export function dashboardHtml(): string {
  return dashboardShell(DASHBOARD_STYLES, dashboardClientScript());
}
