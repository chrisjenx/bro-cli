import { describe, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { mkdir } from "node:fs/promises";
import { dashboardHtml } from "./dashboard.ts";
import { accountFixture, candidateFixture, statusFixture } from "./dashboard-test-helpers.ts";
import type { DashboardStatus } from "./dashboard-types.ts";

declare const document: { querySelector(selector: string): { textContent: string | null } | null; activeElement: unknown; documentElement: { scrollWidth: number } };
declare const innerWidth: number;

const suite = process.env.POOL_DASHBOARD_BROWSER === "1" ? describe : describe.skip;
function browserFixture(): DashboardStatus {
  const now = Date.now();
  const accounts = Array.from({ length: 11 }, (_, i) => accountFixture(i === 0 ? 'alpha <long> "account" & team' : `sample-account-${i}`, {
    provider: i % 2 ? "openai" : "anthropic", available: i < 7, authenticated: i < 9,
    priority: i === 1 ? 100 : i === 0 ? 1 : 110,
    tokenExpiresAt: now + 12_000_000,
  }, { rateLimitedUntil: i === 7 || i === 8 ? now + 600_000 : null,
    lastUsageCheckAt: now - 60_000,
    rateLimitStatus: { updatedAt: now - 60_000, unifiedStatus: "allowed", windows: [
      { key: "5h", model: null, status: "allowed", utilization: i === 1 ? null : i / 10, reset: now + 12_000_000 },
      { key: "7d", model: null, status: "allowed", utilization: i === 0 ? 0.93 : i / 20, reset: now + 200_000_000 },
      { key: "7d-fable", model: "fable", status: "allowed", utilization: 0.12, reset: now + 200_000_000 },
    ] },
  }));
  const s = statusFixture(accounts, { now });
  s.mapping.targets = [{ id: "target-full", supportedEfforts: ["high", "xhigh"] }, { id: "target-small", supportedEfforts: ["high"] }];
  s.mapping.mappings = [{ from: "opus", to: "target-full", effort: { high: "xhigh" } }];
  s.routingCombined = { activeTier: 1, tiers: [], nextPick: { account: "sample-account-1", reason: { summary: "Provider selected by server", factors: [{ label: "Score", detail: "Server score 2.00", decisive: true }] } },
    candidates: [candidateFixture(accounts[0]!.name), candidateFixture("sample-account-1", { score: 2 })],
    busy: [{ account: "sample-account-2", inFlight: 4, limit: 4 }] };
  return s;
}
async function withPage(run: (h: { page: Page; snapshot: DashboardStatus; posts: Array<{ path: string; body: any }>; failSave: (value: boolean) => void; failStatus: (value: boolean) => void }) => Promise<void>, options: { width?: number; theme?: "light" | "dark" } = {}) {
  const { chromium } = await import("playwright");
  const snapshot = browserFixture(); const posts: Array<{ path: string; body: any }> = [];
  let failSave = false, failStatus = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") return new Response(dashboardHtml(), { headers: { "content-type": "text/html" } });
    if (url.pathname === "/api/status") {
      if (failStatus) return new Response("offline", { status: 503 });
      return Response.json({ ...snapshot, routingContext: { ...snapshot.routingContext, model: url.searchParams.get("model") || null } });
    }
    if (req.method === "POST") {
      const body = await req.json() as any; posts.push({ path: url.pathname, body });
      if (failSave) return Response.json({ error: { message: "Fixture persistence failed" } }, { status: 500 });
      if (url.pathname === "/api/routing") {
        const a = snapshot.accounts.find(a => a.name === body.account)!; a.priority = body.priority; a.weight = body.weight;
        return Response.json({ ok: true, ...body });
      }
      if (url.pathname === "/api/mappings") { snapshot.mapping.enabled = body.enabled; snapshot.mapping.mappings = body.mappings; return Response.json({ ok: true, mappingEnabled: body.enabled, mappings: body.mappings }); }
      if (url.pathname === "/api/tuning") { Object.assign(snapshot.tuning, body); return Response.json({ ok: true, tuning: snapshot.tuning }); }
    }
    return new Response("Not found", { status: 404 });
  } });
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: options.width ?? 1440, height: 1000 }, colorScheme: options.theme ?? "dark" });
    page.setDefaultTimeout(8000);
    const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    await page.goto(`http://127.0.0.1:${server.port}/`);
    expect(await page.getByRole("navigation", { name: "Dashboard views" }).count()).toBe(1);
    await page.locator('[data-overview-rows] [data-open-account]').first().waitFor();
    await run({ page, snapshot, posts, failSave: v => { failSave = v; }, failStatus: v => { failStatus = v; } });
    expect(errors).toEqual([]);
  } finally { try { await browser?.close(); } finally { await server.stop(true); } }
}

suite("redesigned dashboard in Chromium", () => {
  test("health-first overview filters without changing pool totals", async () => withPage(async ({ page }) => {
    expect(await page.locator('[data-metric="available"]').innerText()).toBe("7 / 11");
    expect(await page.locator('[data-overview-rows] tr').count()).toBe(11);
    expect(await page.locator('[data-overview-head] th').count()).toBe(7);
    await page.getByLabel("Search accounts").fill("ALPHA");
    expect(await page.locator('[data-overview-rows] tr').count()).toBe(1);
    expect(await page.locator('[data-metric="available"]').innerText()).toBe("7 / 11");
    expect(await page.locator('[data-overview-rows] tr').innerText()).toContain('alpha <long> "account" & team');
    await page.getByLabel("Search accounts").fill("does-not-exist");
    await page.getByRole("button", { name: "Clear filters" }).click();
    expect(await page.locator('[data-overview-rows] tr').count()).toBe(11);
    expect(await page.locator('#overview-view input[type=number]').count()).toBe(0);
  }), 20000);

  test("drawer preserves dirty inputs through live polls and guards keyboard dismissal", async () => withPage(async ({ page, snapshot }) => {
    await page.locator('[data-open-account]').first().click();
    const input = page.getByLabel("Priority", { exact: true });
    await input.fill("25");
    await input.evaluate(el => { (globalThis as any).__originalInput = el; });
    snapshot.accounts[0]!.inFlight = 2;
    await page.waitForFunction(() => document.querySelector('[data-detail-inflight]')?.textContent === "2");
    snapshot.accounts[0]!.inFlight = 3;
    await page.waitForFunction(() => document.querySelector('[data-detail-inflight]')?.textContent === "3");
    expect(await input.inputValue()).toBe("25");
    expect(await input.evaluate(el => el === (globalThis as any).__originalInput && el === document.activeElement)).toBe(true);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Keep editing" }).click();
    expect(await input.inputValue()).toBe("25");
    await page.getByRole("button", { name: "Close account details" }).click();
    await page.getByRole("button", { name: "Discard changes" }).click();
    expect(await page.locator('#account-drawer').evaluate((el: any) => el.open)).toBe(false);
    expect(await page.locator('[data-overview-rows] [data-open-account]').first().evaluate(el => el === document.activeElement)).toBe(true);
  }), 25000);

  test("focused clean drawer fields adopt remote values before another field is edited", async () => withPage(async ({ page, snapshot, posts }) => {
    await page.locator('[data-overview-rows] [data-open-account]').first().click();
    const priority = page.getByLabel("Priority", { exact: true });
    await priority.focus();
    snapshot.accounts[0]!.priority = 37;
    snapshot.accounts[0]!.inFlight = 9;
    await page.waitForFunction(() => document.querySelector('[data-detail-inflight]')?.textContent === "9");
    expect(await priority.evaluate(el => el === document.activeElement)).toBe(true);
    await page.getByLabel("Weight", { exact: true }).fill("1.5");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await page.locator('[data-account-feedback]').getByText("Saved", { exact: true }).waitFor();
    expect(posts.at(-1)?.body).toEqual({ account: 'alpha <long> "account" & team', priority: 37, weight: 1.5 });
  }), 20000);

  test("logged-out OpenAI account recovery command selects the OpenAI provider", async () => withPage(async ({ page }) => {
    await page.locator('[data-overview-rows]').getByRole("button", { name: "sample-account-9", exact: true }).click();
    await page.locator('[data-auth-details] summary').click();
    expect(await page.locator('[data-auth-help]').isVisible()).toBe(true);
    expect(await page.locator('[data-login-command]').innerText()).toBe("bun run src/index.ts accounts login 'sample-account-9' --provider openai");
  }), 20000);

  test("hidden routing table stays unchanged until activation renders the latest snapshot", async () => withPage(async ({ page, snapshot }) => {
    await page.getByRole("button", { name: "Routing", exact: true }).click();
    const priority = page.locator('[data-routing-candidates] tr').filter({ has: page.getByRole("button", { name: 'alpha <long> "account" & team', exact: true, includeHidden: true }) }).locator('[data-factor="priority"]');
    expect(await priority.textContent()).toBe("1");
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    snapshot.accounts[0]!.priority = 37;
    snapshot.accounts[0]!.inFlight = 9;
    await page.waitForFunction(() => document.querySelector('[data-overview-rows] .overview-inflight')?.textContent === "9");
    await page.getByLabel("Search accounts").fill("alpha");
    expect(await priority.textContent()).toBe("1");
    await page.getByRole("button", { name: "Routing", exact: true }).click();
    expect(await priority.textContent()).toBe("37");
  }), 20000);

  test("account save uses one payload and rejected saves retain the draft", async () => withPage(async ({ page, posts, failSave }) => {
    await page.locator('[data-open-account]').first().click();
    await page.getByLabel("Priority", { exact: true }).fill("25");
    await page.getByLabel("Weight", { exact: true }).fill("1.5");
    failSave(true); await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await page.locator('[data-account-feedback]').getByText(/could not be confirmed/).waitFor();
    expect(await page.getByLabel("Priority", { exact: true }).inputValue()).toBe("25");
    failSave(false); await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await page.locator('[data-account-feedback]').getByText("Saved", { exact: true }).waitFor();
    expect(posts.at(-1)?.body).toEqual({ account: 'alpha <long> "account" & team', priority: 25, weight: 1.5 });
  }), 20000);

  test("routing shows hypothetical winner priority and healthy noncandidates", async () => withPage(async ({ page }) => {
    await page.getByRole("button", { name: "Routing", exact: true }).click();
    expect(await page.locator('[data-routing-pick]').innerText()).toContain("Hypothetical pick");
    expect(await page.locator('[data-winner-priority]').innerText()).toContain("100");
    expect(await page.locator('[data-routing-candidates] tr').count()).toBe(2);
    expect(await page.locator('[data-routing-others] tr').count()).toBe(9);
    await page.getByLabel("Routing model family").selectOption("opus");
    await page.locator('[data-routing-pick]').getByText("Next new session for opus", { exact: true }).waitFor();
  }), 20000);

  test("settings clear unsupported efforts and save independent mapping and tuning forms", async () => withPage(async ({ page, posts }) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByLabel("Target for opus").selectOption("target-small");
    expect(await page.getByLabel("opus high effort").inputValue()).toBe("");
    await page.getByRole("button", { name: "Save mappings", exact: true }).click();
    await page.locator('[data-mapping-feedback]').getByText("Saved", { exact: true }).waitFor();
    await page.getByLabel("5h taper start", { exact: true }).fill("0.013");
    await page.getByRole("button", { name: "Apply tuning", exact: true }).click();
    await page.locator('[data-tuning-feedback]').getByText("Saved", { exact: true }).waitFor();
    expect(posts.at(-1)).toEqual({ path: "/api/tuning", body: { headroomTaperStart: 0.013 } });
  }), 20000);

  for (const target of ['claude-opus-4-6', 'custom-claude-alias']) {
    test(`settings recognizes Claude-only mapping target ${target}`, async () => withPage(async ({ page, snapshot, posts }) => {
      snapshot.mapping.mappings = [{ from: 'opus', to: target }];
      snapshot.mapping.anthropicTargets = ['custom-claude-alias'];
      snapshot.accounts[0]!.inFlight = 9;
      await page.getByRole("button", { name: "Refresh status" }).click();
      await page.waitForFunction(() => document.querySelector('[data-overview-rows] .overview-inflight')?.textContent === "9");
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const selected = page.getByLabel("Target for opus").locator('option:checked');
      expect(await selected.getAttribute('value')).toBe(target);
      expect(await selected.innerText()).toContain('Claude only');
      expect(await selected.isDisabled()).toBe(false);
      expect(await page.getByLabel("opus high effort").isVisible()).toBe(false);
      expect(await page.locator('[data-mapping-warning]').isVisible()).toBe(false);
      await page.getByRole("button", { name: "Save mappings", exact: true }).click();
      await page.locator('[data-mapping-feedback]').getByText("Saved", { exact: true }).waitFor();
      expect(posts.at(-1)?.body.mappings.find((mapping: { from: string }) => mapping.from === 'opus')).toEqual({ from: 'opus', to: target });
    }), 20000);
  }

  test("settings preserves effort overrides for an OpenAI target named opus", async () => withPage(async ({ page, snapshot, posts }) => {
    snapshot.mapping.targets.push({ id: 'opus', supportedEfforts: ['high', 'xhigh'] });
    snapshot.mapping.mappings = [{ from: 'opus', to: 'opus', effort: { high: 'xhigh' } }];
    snapshot.accounts[0]!.inFlight = 9;
    await page.getByRole("button", { name: "Refresh status" }).click();
    await page.waitForFunction(() => document.querySelector('[data-overview-rows] .overview-inflight')?.textContent === "9");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    expect(await page.getByLabel("Target for opus").locator('option:checked').innerText()).toBe('opus');
    expect(await page.getByLabel("opus high effort").isVisible()).toBe(true);
    expect(await page.getByLabel("opus high effort").inputValue()).toBe('xhigh');
    await page.getByRole("button", { name: "Save mappings", exact: true }).click();
    await page.locator('[data-mapping-feedback]').getByText("Saved", { exact: true }).waitFor();
    expect(posts.at(-1)?.body.mappings.find((mapping: { from: string }) => mapping.from === 'opus')).toEqual({ from: 'opus', to: 'opus', effort: { high: 'xhigh' } });
  }), 20000);

  test("offline recovery and removed-account state remain explicit", async () => withPage(async ({ page, snapshot, failStatus }) => {
    failStatus(true); await page.getByRole("button", { name: "Refresh status" }).click();
    await page.locator('#connection-feedback').getByText(/offline|stale/i).waitFor();
    expect(await page.locator('[data-overview-rows] tr').count()).toBe(11);
    failStatus(false); await page.getByRole("button", { name: "Refresh status" }).click();
    await page.locator('#connection-feedback').getByText(/connected/i).waitFor();
    await page.locator('[data-open-account]').first().click();
    await page.getByLabel("Priority", { exact: true }).fill("25"); snapshot.accounts.shift();
    await page.locator('[data-account-removed]').waitFor({ state: "visible" });
    expect(await page.getByRole("button", { name: "Save changes", exact: true }).isDisabled()).toBe(true);
  }), 20000);

  for (const width of [1440, 390]) for (const theme of ["light", "dark"] as const) {
    test(`layout and screenshots ${width}px ${theme}`, async () => withPage(async ({ page }) => {
      const dir = process.env.CLAUDE_JOB_DIR ? `${process.env.CLAUDE_JOB_DIR}/tmp/dashboard-screenshots` : `${process.cwd()}/../.superpowers/dashboard-screenshots`;
      await mkdir(dir, { recursive: true });
      for (const view of ["Overview", "Routing", "Settings"]) {
        await page.getByRole("button", { name: view, exact: true }).click();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: `${dir}/${view.toLowerCase()}-${width}-${theme}.png`, fullPage: true });
      }
      await page.getByRole("button", { name: "Overview", exact: true }).click();
      await page.locator('[data-open-account]').first().click();
      await page.screenshot({ path: `${dir}/drawer-${width}-${theme}.png`, fullPage: false });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
      expect(await page.getByRole("button", { name: "Close account details" }).isVisible()).toBe(true);
    }, { width, theme }), 25000);
  }
  test("assumed reset is visible in the overview without hover", async () => withPage(async ({ page, snapshot }) => {
    snapshot.accounts[0]!.usage.rateLimitStatus!.windows[0]!.reset = Date.now() - 1000;
    snapshot.accounts[0]!.usage.rateLimitStatus!.windows[0]!.utilization = 0.9;
    snapshot.accounts[0]!.inFlight = 22;
    await page.getByRole("button", { name: "Refresh status" }).click();
    await page.waitForFunction(() => document.querySelector('[data-overview-rows] .overview-inflight')?.textContent === "22");
    expect(await page.locator('[data-overview-rows] tr').first().innerText()).toContain("Reset assumed");
  }), 20000);

  test("keyboard focus stays in the drawer and native background is inert", async () => withPage(async ({ page }) => {
    const opener = page.locator('[data-overview-rows] [data-open-account]').first();
    await opener.focus(); await page.keyboard.press("Enter");
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press("Tab");
      const contained = await page.locator('#account-drawer').evaluate(el => el.contains(document.activeElement as any));
      expect(contained).toBe(true);
    }
    await page.keyboard.press("Escape");
    expect(await opener.evaluate(el => el === document.activeElement)).toBe(true);
  }), 20000);

  test("usage-sort movement preserves the focused account's viewport position", async () => withPage(async ({ page, snapshot }) => {
    await page.locator('[data-sort="fiveHour"]').click();
    const button = page.locator('[data-overview-rows]').getByRole('button', { name: 'sample-account-6', exact: true });
    await button.scrollIntoViewIfNeeded(); await button.focus();
    const before = await button.boundingBox();
    snapshot.accounts[6]!.usage.rateLimitStatus!.windows[0]!.utilization = 0.85;
    await page.waitForFunction(() => Array.from((document as any).querySelectorAll('[data-overview-rows] tr')).some((row: any) => row.textContent.includes('sample-account-6') && row.textContent.includes('85%')));
    const after = await button.boundingBox();
    expect(Math.abs(after!.y - before!.y)).toBeLessThan(2);
    expect(await button.evaluate(el => el === document.activeElement)).toBe(true);
  }), 20000);

  test("theme preference survives reload and empty pool shows onboarding", async () => withPage(async ({ page, snapshot }) => {
    await page.getByRole("button", { name: "Toggle color theme" }).click();
    expect(await page.locator('html').getAttribute('data-theme')).toBe('light');
    await page.reload();
    await page.locator('[data-overview-rows] tr').first().waitFor();
    expect(await page.locator('html').getAttribute('data-theme')).toBe('light');
    snapshot.accounts.length = 0;
    await page.getByRole("button", { name: "Refresh status" }).click();
    await page.getByRole('heading', { name: 'Set up your first account' }).waitFor();
    expect(await page.locator('[data-filter-empty]').isVisible()).toBe(false);
    expect(await page.locator('[data-metric="available"]').innerText()).toBe('0 / 0');
  }), 20000);

  test("live capability changes keep a dirty unavailable target identifiable", async () => withPage(async ({ page, snapshot }) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByLabel("Target for opus").selectOption('target-small');
    snapshot.mapping.targets = snapshot.mapping.targets.filter(t => t.id !== 'target-small');
    await page.getByRole("button", { name: "Refresh status" }).click();
    await page.locator('[data-mapping-warning]').getByText(/target-small is unavailable/).waitFor();
    expect(await page.getByLabel("Target for opus").inputValue()).toBe('target-small');
    expect(await page.getByLabel("Target for opus").locator('option:checked').innerText()).toContain('Unavailable');
  }), 20000);

  test("sort indicator follows the selected column and direction", async () => withPage(async ({ page }) => {
    await page.locator('[data-sort="name"]').click();
    expect(await page.locator('[data-sort="name"]').innerText()).toContain('↓');
    await page.locator('[data-sort="fiveHour"]').click();
    expect(await page.locator('[data-sort="name"]').innerText()).not.toContain('↑');
    expect(await page.locator('[data-sort="fiveHour"]').innerText()).toContain('↑');
  }), 20000);

});
