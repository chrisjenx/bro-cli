import { test, expect } from "bun:test";
import { dashboardHtml } from "./dashboard.ts";

/**
 * The dashboard's per-account card is rendered client-side by a `card(a)`
 * function embedded in a <script> block within the HTML string returned by
 * dashboardHtml() — there's no server-side render path to unit test directly.
 * Extract that script and evaluate `card()` in isolation against a synthetic
 * account object to exercise the rendering logic without a browser.
 */
function loadCard(): (account: unknown) => string {
  const html = dashboardHtml();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("dashboard <script> block not found");
  // `card` calls refresh()/setInterval() at the bottom of the script; stub
  // those out so evaluating the module body doesn't touch the DOM or fetch.
  const stubbed = script
    .replace(/^refresh\(\);$/m, "")
    .replace(/^setInterval\(refresh, 4000\);$/m, "");
  const factory = new Function(
    "document",
    "localStorage",
    "matchMedia",
    `${stubbed}\nreturn card;`,
  );
  const noopEl = { addEventListener() {}, setAttribute() {}, getAttribute() { return null; }, textContent: "", style: {} };
  const doc = {
    getElementById: () => noopEl,
    querySelectorAll: () => [],
    documentElement: noopEl,
  };
  return factory(doc, { getItem: () => null, setItem() {} }, () => ({ matches: false }));
}

function baseAccount(overrides: Record<string, unknown> = {}) {
  return {
    name: "acct",
    available: true,
    authenticated: true,
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_5x",
    tokenExpired: false,
    tokenExpiresAt: Date.now() + 3_600_000,
    unavailableReason: null,
    weight: 1,
    activeSessions: 0,
    usage: {
      windowRequests: 3,
      windowInputTokens: 100,
      windowOutputTokens: 50,
      windowCostUsd: 0.01,
      totalRequests: 10,
      lastUsedAt: Date.now(),
      lastError: null,
      rateLimitedUntil: null,
      rateLimitStatus: null,
      ...((overrides.usage as Record<string, unknown>) ?? {}),
    },
    ...overrides,
  };
}

test("card() falls back to est. bars for every window kind when no live snapshot exists", () => {
  const card = loadCard();
  const html = card(baseAccount());
  expect(html).toContain("Requests (est.)");
  expect(html).toContain("Tokens (est.)");
});

test("card() shows only the real 5h bar plus an est. tokens fallback when 7d data is still missing", () => {
  const card = loadCard();
  const html = card(
    baseAccount({
      usage: {
        rateLimitStatus: {
          unifiedStatus: "allowed",
          windows: [{ key: "5h", model: null, status: "allowed", utilization: 0.2, reset: Date.now() + 3600_000 }],
        },
      },
    }),
  );
  expect(html).toContain("5h window");
  expect(html).not.toContain("Requests (est.)");
  // 7d is still unknown, so its local estimate must still be shown.
  expect(html).toContain("Tokens (est.)");
});

test("card() shows both real bars and no estimates once 5h and 7d are both known", () => {
  const card = loadCard();
  const html = card(
    baseAccount({
      usage: {
        rateLimitStatus: {
          unifiedStatus: "allowed",
          windows: [
            { key: "5h", model: null, status: "allowed", utilization: 0.2, reset: Date.now() + 3600_000 },
            { key: "7d", model: null, status: "allowed", utilization: 0.3, reset: Date.now() + 86_400_000 },
          ],
        },
      },
    }),
  );
  expect(html).toContain("5h window");
  expect(html).toContain("7d window");
  expect(html).not.toContain("(est.)");
});

test("card() assumes the reset for a rolled-over window instead of freezing a stale number", () => {
  const card = loadCard();
  const now = Date.now();
  const html = card(
    baseAccount({
      usage: {
        rateLimitStatus: {
          unifiedStatus: "allowed",
          updatedAt: now,
          windows: [{ key: "5h", model: null, status: "allowed", utilization: 0.97, reset: now - 60 * 60_000 }],
        },
      },
    }),
  );
  // Reset was an hour ago on a 5h window: assume rollover — 0% used, next
  // reset projected 4h out — not the stale 97% "awaiting refresh".
  expect(html).not.toContain("awaiting refresh");
  expect(html).not.toContain("97%");
  expect(html).toContain("0% · resets 4h 0m");
});

function loadFns(): {
  card: (a: unknown, isNext?: boolean) => string;
  tierLabel: (p: number) => string;
  summaryTableHtml: (accounts: unknown[], nextAcct: string | null) => string;
} {
  const html = dashboardHtml();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("dashboard <script> block not found");
  const stubbed = script
    .replace(/^refresh\(\);$/m, "")
    .replace(/^setInterval\(refresh, 4000\);$/m, "");
  const factory = new Function(
    "document",
    "localStorage",
    "matchMedia",
    `${stubbed}\nreturn { card, tierLabel, summaryTableHtml };`,
  );
  const noopEl = { addEventListener() {}, setAttribute() {}, getAttribute() { return null; }, textContent: "", style: {} };
  const doc = {
    getElementById: () => noopEl,
    querySelectorAll: () => [],
    documentElement: noopEl,
  };
  return factory(doc, { getItem: () => null, setItem() {} }, () => ({ matches: false })) as any;
}

test("tierLabel names the first two bands and numbers the rest", () => {
  const { tierLabel } = loadFns();
  expect(tierLabel(1)).toBe("Priority 1 — Primary");
  expect(tierLabel(2)).toBe("Priority 2 — Fallback");
  expect(tierLabel(3)).toBe("Priority 3");
});

test("card() marks the next-pick account and shows its priority", () => {
  const { card } = loadFns();
  const html = card({ ...baseAccount(), priority: 1 }, true);
  expect(html).toContain("next");
  expect(html.toLowerCase()).toContain("priority");
});

function loadRoutingPanel(): (routing: unknown) => string {
  const html = dashboardHtml();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("dashboard <script> block not found");
  const stubbed = script
    .replace(/^refresh\(\);$/m, "")
    .replace(/^setInterval\(refresh, 4000\);$/m, "");
  const noopEl = { addEventListener() {}, setAttribute() {}, getAttribute() { return null; }, textContent: "", style: {} };
  const doc = { getElementById: () => noopEl, querySelectorAll: () => [], documentElement: noopEl };
  const factory = new Function("document", "localStorage", "matchMedia", `${stubbed}\nreturn routingPanelHtml;`);
  return factory(doc, { getItem: () => null, setItem() {} }, () => ({ matches: false }));
}

test("routingPanelHtml lists every decision factor and marks the decisive one", () => {
  const routingPanelHtml = loadRoutingPanel();
  const html = routingPanelHtml({
    nextPick: {
      account: "burn-me",
      reason: {
        summary: "tier 100 · 7d resets in ~2.6d · 98% 5h headroom",
        factors: [
          { label: "Priority tier", detail: "100 active (2 accounts) · no lower tiers in reserve", decisive: false },
          { label: "5h gate", detail: "2/2 eligible (≥10% headroom) · chosen 98% headroom", decisive: false },
          { label: "7d expiry", detail: "resets in ~2.6d · soonest eligible (next: keep ~5.3d)", decisive: true },
          { label: "Tie-break", detail: "not needed", decisive: false },
        ],
      },
    },
  });
  expect(html).toContain("burn-me");
  expect(html).toContain("Priority tier");
  expect(html).toContain("7d expiry");
  expect(html).toContain("◀"); // decisive marker
  expect(html).toContain("98% 5h headroom"); // summary present
});

test("routingPanelHtml is empty when there is no next pick", () => {
  const routingPanelHtml = loadRoutingPanel();
  expect(routingPanelHtml({ nextPick: null })).toBe("");
  expect(routingPanelHtml(null)).toBe("");
});

test("routingPanelHtml wraps the pick and factors as flex siblings", () => {
  const routingPanelHtml = loadRoutingPanel();
  const html = routingPanelHtml({
    nextPick: { account: "a", reason: { summary: "s", factors: [{ label: "Tier", detail: "100", decisive: true }] } },
  });
  expect(html).toContain('<div class="pick">');
  expect(html).toContain('<ul class="why">');
});

test("outer #grid container is not itself a CSS grid (tier sections span full width)", () => {
  const html = dashboardHtml();
  // The tiling bug: `.grid` as display:grid squeezes each <section class="tier">
  // into one ~330px column. The outer container must be a plain block.
  const gridRule = html.match(/\.grid \{[^}]*\}/)?.[0] ?? "";
  expect(gridRule).not.toContain("display: grid");
  // Card tiling is owned by .tier-grid.
  expect(html).toMatch(/\.tier-grid \{ display: grid; grid-template-columns: repeat\(auto-fill, minmax\(3\d0px, 1fr\)\)/);
});

test("card() gives the next pick an accent class and every card a scroll-target id", () => {
  const { card } = loadFns();
  const next = card({ ...baseAccount(), name: "pick-me" }, true);
  expect(next).toContain('id="card-pick-me"');
  expect(next).toMatch(/class="card[^"]*\bnext\b/);
  const other = card(baseAccount(), false);
  expect(other).not.toMatch(/class="card[^"]*\bnext\b/);
});

test("card() merges request count and recency into one row", () => {
  const { card } = loadFns();
  const html = card(baseAccount(), false);
  expect(html).toContain("Requests</span>");
  expect(html).toContain("10 · ");           // totalRequests · ago(lastUsedAt)
  expect(html).not.toContain("Total requests");
  expect(html).not.toContain("Last used");
});

test("summaryTableHtml renders one row per account with dot, next tag, windows, priority", () => {
  const { summaryTableHtml } = loadFns();
  const a = baseAccount({
    name: "alpha",
    priority: 100,
    usage: {
      rateLimitStatus: {
        unifiedStatus: "allowed",
        windows: [
          { key: "5h", model: null, status: "allowed", utilization: 0.12, reset: Date.now() + 3600_000 },
          { key: "7d", model: null, status: "allowed", utilization: 0.07, reset: Date.now() + 86_400_000 },
          { key: "7d-fable", model: "fable", status: "allowed", utilization: 0.5, reset: Date.now() + 86_400_000 },
        ],
      },
    },
  });
  const b = baseAccount({ name: "beta", priority: 50, usage: { lastUsedAt: null } });
  const html = summaryTableHtml([a, b], "alpha");
  expect(html).toContain("alpha");
  expect(html).toContain("beta");
  expect((html.match(/<tr class="acct"/g) || []).length).toBe(2);
  expect(html).toContain("12%");           // alpha 5h
  expect(html).toContain("7%");            // alpha 7d (account-wide only)
  expect(html).not.toContain("50%");       // model-scoped fable window excluded
  expect(html).toMatch(/data-scroll="alpha"/);
  // Only the routed account carries the next tag.
  const alphaRow = html.slice(html.indexOf("alpha"), html.indexOf("beta"));
  expect(alphaRow).toContain("next");
  // beta has no live windows -> en-dash placeholders, and "never" for last used.
  expect(html).toContain("never");
});

test("summaryTableHtml rows are keyboard-focusable buttons (a11y)", () => {
  const { summaryTableHtml } = loadFns();
  const html = summaryTableHtml([baseAccount({ name: "alpha" })], null);
  expect(html).toContain('role="button"');
  expect(html).toContain('tabindex="0"');
});

test("summaryTableHtml is empty for an empty pool", () => {
  const { summaryTableHtml } = loadFns();
  expect(summaryTableHtml([], null)).toBe("");
});

test("card() shows active sessions and the manual weight", () => {
  const { card } = loadFns();
  const html = card({ ...baseAccount(), priority: 100, weight: 2.5, activeSessions: 3 }, false);
  expect(html).toContain("Sessions</span>");
  expect(html).toContain("3 active");
  expect(html).toContain('data-set-weight="acct"');
  expect(html).toContain('value="2.5"');
});

test("card() weight editor defaults to 1 when weight is missing (older /api/status)", () => {
  const { card } = loadFns();
  const html = card({ ...baseAccount(), priority: 100 }, false);
  expect(html).toContain('data-set-weight="acct"');
  expect(html).toContain('value="1"');
});
