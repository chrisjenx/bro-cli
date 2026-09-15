import { test, expect } from "bun:test";
import { dashboardHtml, dashboardClientScript, buildDashboardDescriptors } from "./dashboard.ts";
import { createDashboardPresentation } from "./dashboard-presentation.ts";
import { createDashboardForms } from "./dashboard-forms.ts";
import type { MappingForm } from "./dashboard-types.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OPENAI_CREDS_FILENAME, windowDurationMs, sortRateLimitWindows } from "../accounts/types.ts";

// Server contract regressions remain real isolated HTTP tests; obsolete card markup is gone.
async function startStatusServer(
  dir: string,
  configOverrides: Record<string, unknown> = {},
): Promise<{ origin: string; stop: () => Promise<void> }> {
  const config = { host: "127.0.0.1", port: 0, usageRefreshEnabled: false, ...configOverrides };
  const proc = Bun.spawn([process.execPath, "-e", `
    import { loadConfig } from "../config.ts";
    import { startServer } from "./server.ts";
    startServer(loadConfig(${JSON.stringify(config)}));
  `], {
    cwd: import.meta.dir,
    env: { ...process.env, CLAUDE_POOL_DIR: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ready = (async () => {
      let output = "";
      for await (const chunk of proc.stdout) {
        output += new TextDecoder().decode(chunk);
        const origin = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
        if (origin) return origin;
      }
      throw new Error("Pool exited before listening: " + await new Response(proc.stderr).text());
    })();
    const origin = await Promise.race([
      ready,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Pool startup timed out")), 5000); }),
    ]);
    return {
      origin,
      stop: async () => {
        proc.kill();
        await proc.exited;
      },
    };
  } catch (error) {
    proc.kill();
    await proc.exited;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

for (const strategy of ["headroom", "expiring"] as const) {
  test(`status and dashboard expose candidate factors for the ${strategy} strategy`, async () => {
    const dir = mkdtempSync(join(process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, "tmp") : tmpdir(), "routing-factors-status-"));
    const accountsDir = join(dir, "accounts");
    mkdirSync(join(accountsDir, "claude"), { recursive: true });
    mkdirSync(join(accountsDir, "codex"), { recursive: true });
    writeFileSync(
      join(accountsDir, "claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "at" } }),
    );
    writeFileSync(
      join(accountsDir, "codex", OPENAI_CREDS_FILENAME),
      JSON.stringify({ accessToken: "at" }),
    );
    const proc = Bun.spawn([process.execPath, "-e", `
      import { loadConfig } from "../config.ts";
      import { startServer } from "./server.ts";
      startServer(loadConfig({
        host: "127.0.0.1",
        port: 0,
        usageRefreshEnabled: false,
        routingStrategy: "${strategy}",
      }));
    `], {
      cwd: import.meta.dir,
      env: { ...process.env, CLAUDE_POOL_DIR: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ready = (async () => {
        let output = "";
        for await (const chunk of proc.stdout) {
          output += new TextDecoder().decode(chunk);
          const origin = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
          if (origin) return origin;
        }
        throw new Error("Pool exited before listening: " + await new Response(proc.stderr).text());
      })();
      const origin = await Promise.race([
        ready,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Pool startup timed out")), 5000); }),
      ]);
      const response = await fetch(origin + "/api/status");
      const status = await response.json() as any;
      expect(response.status).toBe(200);
      expect(status.routingCombined.candidates).toEqual([
        expect.objectContaining({ account: "claude", headroom: 1, activeSessions: 0, inFlight: 0, viable: true, score: 5 }),
        expect.objectContaining({ account: "codex", headroom: 1, activeSessions: 0, inFlight: 0, viable: true, score: 5 }),
      ]);

      const presentation = createDashboardPresentation(windowDurationMs, sortRateLimitWindows);
      const model = presentation.routingModel(status);
      expect(model.candidates.map(row => row.account.name)).toEqual(["claude", "codex"]);
      for (const row of model.candidates) {
        expect(row.candidate).toMatchObject({ headroom: 1, viable: true, score: 5 });
        expect(presentation.accountDetailModel(status, row.account, Date.now()).account.name).toBe(row.account.name);
      }
    } finally {
      clearTimeout(timer);
      proc.kill();
      await proc.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10000);
}

test("CLI backend status does not advertise an unusable Codex account", async () => {
  const dir = mkdtempSync(join(process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, "tmp") : tmpdir(), "cli-routing-status-"));
  const accountsDir = join(dir, "accounts");
  mkdirSync(join(accountsDir, "codex"), { recursive: true });
  writeFileSync(join(accountsDir, "codex", OPENAI_CREDS_FILENAME), JSON.stringify({ accessToken: "at" }));
  const server = await startStatusServer(dir, { backend: "cli" });
  try {
    const accountWideResponse = await fetch(server.origin + "/api/status");
    const accountWide = await accountWideResponse.json() as any;
    expect(accountWideResponse.status).toBe(200);
    expect(accountWide.routingContext.providers).toEqual(["anthropic"]);
    expect(accountWide.routingCombined.nextPick).toBeNull();

    const explicitResponse = await fetch(server.origin + "/api/status?model=gpt-5.6-sol");
    const explicit = await explicitResponse.json() as any;
    expect(explicitResponse.status).toBe(200);
    expect(explicit.routingContext.providers).toEqual([]);
    expect(explicit.routingCombined.nextPick).toBeNull();
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);

  test("live status preserves object targets and capabilities for already-open dashboards", async () => {
    const dir = mkdtempSync(join(process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, "tmp") : tmpdir(), "mapping-status-"));
    writeFileSync(join(dir, "models.json"), JSON.stringify({
      models: [
        { id: "custom-frontier", provider: "openai", upstreamModel: "custom-upstream", supportedEfforts: ["high", "max"] },
        { id: "custom-claude-route", provider: "anthropic", upstreamModel: "claude-sonnet-4-6" },
      ],
      mappingEnabled: true,
      mappings: [
        { from: "fable", to: "gpt-6-astra", effort: { max: "max" } },
        { from: "sonnet", to: "custom-claude-route" },
        { from: "opus", to: "claude-opus-4-8" },
      ],
    }));
    const proc = Bun.spawn([process.execPath, "-e", `
      import { loadConfig } from "../config.ts";
      import { startServer } from "./server.ts";
      startServer(loadConfig({ host: "127.0.0.1", port: 0, usageRefreshEnabled: false }));
    `], {
      cwd: import.meta.dir,
      env: { ...process.env, CLAUDE_POOL_DIR: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ready = (async () => {
        let output = "";
        for await (const chunk of proc.stdout) {
          output += new TextDecoder().decode(chunk);
          const origin = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
          if (origin) return origin;
        }
        throw new Error("Pool exited before listening: " + await new Response(proc.stderr).text());
      })();
      const origin = await Promise.race([
        ready,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Pool startup timed out")), 5000); }),
      ]);
      const response = await fetch(origin + "/api/status");
      expect(response.status).toBe(200);
      const accountWide = await response.json() as any;
      expect(accountWide.routingContext).toEqual({
        provider: "anthropic",
        model: null,
        modelFamily: null,
        providers: ["anthropic", "openai"],
      });
      const previewResponse = await fetch(origin + "/api/status?model=fable");
      const preview = await previewResponse.json() as any;
      expect(previewResponse.status).toBe(200);
      expect(preview.routingContext).toEqual({
        provider: "anthropic",
        model: "fable",
        modelFamily: "fable",
        providers: ["anthropic", "openai"],
      });
      expect(preview.routing).toEqual({ activeTier: null, nextPick: null, tiers: [], candidates: [], busy: [] });
      expect(preview.routingPreview).toEqual({ activeTier: null, nextPick: null, tiers: [], candidates: [], busy: [] });
      expect(preview.routingCombined.providerPicks.map((pick: any) => pick.provider)).toEqual(["anthropic", "openai"]);

      const providerResponse = await fetch(origin + "/api/status?provider=openai&model=fable");
      const providerPreview = await providerResponse.json() as any;
      expect(providerResponse.status).toBe(200);
      expect(providerPreview.routingContext.provider).toBe("openai");
      expect(providerPreview.routingPreview).toEqual({ activeTier: null, nextPick: null, tiers: [], candidates: [], busy: [] });
      const invalidProvider = await fetch(origin + "/api/status?provider=unknown");
      expect(invalidProvider.status).toBe(400);

      const explicitOpenAIResponse = await fetch(origin + "/api/status?model=gpt-5.6-sol");
      const explicitOpenAI = await explicitOpenAIResponse.json() as any;
      expect(explicitOpenAIResponse.status).toBe(200);
      expect(explicitOpenAI.routingContext).toEqual({
        provider: "anthropic",
        model: "gpt-5.6-sol",
        modelFamily: null,
        providers: ["openai"],
      });
      const { mapping } = accountWide as {
        mapping: { targets: { id: string; supportedEfforts: string[] }[]; anthropicTargets: string[] };
      };
      // The shipped dashboard reads target.id before deciding if a saved
      // mapping is active. Strings silently turn those routes into Claude-only.
      expect(mapping.targets.every((target) => typeof target.id === "string")).toBe(true);
      expect(mapping.targets.find((target) => target.id === "gpt-6-astra")).toEqual({
        id: "gpt-6-astra", supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      });
      expect(mapping.targets.find((target) => target.id === "custom-frontier")).toEqual({
        id: "custom-frontier", supportedEfforts: ["high", "max"],
      });
      expect(mapping.targets.some((target) => target.id === "fable")).toBe(false);
      expect(mapping.targets.some((target) => target.id === "custom-claude-route")).toBe(false);
      expect(mapping.anthropicTargets).toContain("custom-claude-route");
      expect(mapping.anthropicTargets).not.toContain("custom-frontier");

      const forms = createDashboardForms(buildDashboardDescriptors());
      const draft = forms.readServerForm("mapping", accountWide) as MappingForm;
      expect(draft.mappings.find(row => row.from === "fable")).toEqual({ from: "fable", to: "gpt-6-astra", effort: { max: "max" } });
      expect(forms.prepareSave("mapping", draft, draft, accountWide).ok).toBe(true);
      const disable = forms.prepareSave("mapping", { ...draft, enabled: false }, draft, accountWide);
      expect(disable.ok).toBe(true);
      if (!disable.ok) throw new Error("Valid Claude-only mappings blocked disable");
      const saved = await fetch(origin + disable.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(disable.payload) });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({ ok: true, mappingEnabled: false, mappings: expect.arrayContaining([
        { from: "sonnet", to: "custom-claude-route" }, { from: "opus", to: "claude-opus-4-8" },
      ]) });
      const invalid = structuredClone(draft);
      invalid.mappings.find(row => row.from === "fable")!.effort = { high: "none" };
      expect(forms.prepareSave("mapping", invalid, draft, accountWide).ok).toBe(false);
    } finally {
      clearTimeout(timer);
      proc.kill();
      await proc.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10000);

test("assembled document contains one executable, self-contained script", () => {
  const html = dashboardHtml();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  expect(scripts).toHaveLength(1);
  expect(() => new Function(scripts[0]![1]!)).not.toThrow();
  expect(html).not.toMatch(/<script[^>]+src=/);
  expect(html).not.toMatch(/<link[^>]+stylesheet/);
});

test("emitted factories execute independent of the TypeScript module scope", () => {
  let runtime: any;
  const script = dashboardClientScript().replace(
    "initializeDashboard(shared, presentation, forms, createController);",
    "capture(shared, presentation, forms, createController);",
  );
  new Function("capture", script)((shared: unknown, presentation: unknown, forms: unknown, createController: unknown) => {
    runtime = { shared, presentation, forms, createController };
  });
  const usage = { lastUsageCheckAt: null, lastUsageCheckError: null };
  const value = runtime.presentation.projectWindow({ key: "7d-fable", model: "fable", utilization: 0.9, reset: 1 }, usage, 2);
  expect(value).toMatchObject({ percent: 0, resetAt: 604800001, provenance: "assumed-reset" });
  const controller = runtime.createController({ now: () => 2, render() {} }, runtime.forms, runtime.shared);
  expect(controller.getState().view).toBe("overview");
  expect(controller.getState().snapshot).toBeNull();
});
