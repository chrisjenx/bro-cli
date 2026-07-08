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
