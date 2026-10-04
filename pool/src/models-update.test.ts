import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runModelsCommand } from "./cli.ts";
import { loadConfig } from "./config.ts";
import { OPENAI_CREDS_FILENAME } from "./accounts/types.ts";
import { CODEX_TOKEN_URL } from "./upstream/codex-constants.ts";

const tempRoot = process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, "tmp") : tmpdir();

function withPool(
  run: (config: ReturnType<typeof loadConfig>) => Promise<void>,
  credentials: Record<string, unknown> = {},
): Promise<void> {
  const dir = mkdtempSync(join(tempRoot, "pool-catalog-"));
  const accountsDir = join(dir, "accounts");
  mkdirSync(join(accountsDir, "codex"), { recursive: true });
  writeFileSync(join(accountsDir, "codex", OPENAI_CREDS_FILENAME), JSON.stringify({
    accessToken: "fixture-token", accountId: "fixture-account", expiresAt: Date.now() + 3_600_000,
    ...credentials,
  }));
  const config = loadConfig({ poolDir: dir, accountsDir, modelsFile: join(dir, "models.json") });
  return run(config).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("models update discovers a listed Codex model and persists its verified capabilities", async () => {
  await withPool(async (config) => {
    writeFileSync(config.modelsFile, JSON.stringify({
      models: [{ id: "custom-sol", provider: "openai", upstreamModel: "private-sol" }],
      mappingEnabled: true,
      mappings: [{ from: "sonnet", to: "custom-sol" }],
    }));
    const fetchFn = (async () => Response.json({ models: [{
      slug: "gpt-6.1-sol", visibility: "list", context_window: 272_000,
      max_context_window: 872_000,
      supported_reasoning_levels: [
        { effort: "low", description: "Fast" }, { effort: "medium", description: "Balanced" },
        { effort: "high", description: "Deep" }, { effort: "xhigh", description: "Deeper" },
        { effort: "max", description: "Maximum" }, { effort: "ultra", description: "App-only delegation" },
      ],
      available_in_plans: ["plus", "pro"], priority: 1, description: "Sol 6.1",
    }] })) as unknown as typeof fetch;

    expect(await runModelsCommand(config, ["update"], fetchFn)).toBe(0);
    const saved = JSON.parse(readFileSync(config.modelsFile, "utf8"));
    expect(saved.models.find((m: { id: string }) => m.id === "gpt-6.1-sol")).toEqual({
      id: "gpt-6.1-sol", provider: "openai", upstreamModel: "gpt-6.1-sol",
      contextWindow: 272_000, maxContextWindow: 872_000,
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    });
    expect(saved.models.find((m: { id: string }) => m.id === "custom-sol")).toEqual({
      id: "custom-sol", provider: "openai", upstreamModel: "private-sol",
    });
    expect(saved.mappingEnabled).toBe(true);
    expect(saved.mappings.find((m: { from: string }) => m.from === "sonnet")?.to).toBe("custom-sol");
  });
});

test("models update retries a rejected access token once after refreshing it", async () => {
  await withPool(async (config) => {
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === CODEX_TOKEN_URL) {
        return Response.json({ access_token: "rotated-token", refresh_token: "rotated-refresh", expires_in: 3600 });
      }
      const headers = new Headers(init?.headers);
      if (headers.get("authorization") === "Bearer fixture-token") return new Response("expired", { status: 401 });
      if (headers.get("authorization") !== "Bearer rotated-token" || headers.get("chatgpt-account-id") !== "fixture-account") {
        return new Response("wrong credentials", { status: 403 });
      }
      return Response.json({ models: [{ slug: "gpt-6.1-sol", visibility: "list", supported_reasoning_levels: [{ effort: "high" }] }] });
    }) as typeof fetch;

    expect(await runModelsCommand(config, ["update"], fetchFn)).toBe(0);
    const saved = JSON.parse(readFileSync(config.modelsFile, "utf8"));
    expect(saved.models.some((m: { id: string }) => m.id === "gpt-6.1-sol")).toBe(true);
  }, { refreshToken: "fixture-refresh" });
});

test("models update rejects a malformed visible catalog entry without saving partial results", async () => {
  await withPool(async (config) => {
    const original = JSON.stringify({
      models: [{ id: "custom", provider: "openai", upstreamModel: "custom-upstream" }],
      mappingEnabled: true, mappings: [{ from: "opus", to: "custom" }],
    });
    writeFileSync(config.modelsFile, original);
    const fetchFn = (async () => Response.json({ models: [
      { slug: "gpt-6.1-sol", visibility: "list", supported_reasoning_levels: [{ effort: "high" }] },
      { visibility: "list", context_window: 272_000, supported_reasoning_levels: [{ effort: "high" }] },
    ] })) as unknown as typeof fetch;

    expect(await runModelsCommand(config, ["update"], fetchFn)).toBe(1);
    expect(readFileSync(config.modelsFile, "utf8")).toBe(original);
  });
});

test("models update rejects a catalog with non-model entries", async () => {
  await withPool(async (config) => {
    const fetchFn = (async () => Response.json({ models: ["unexpected"] })) as unknown as typeof fetch;
    expect(await runModelsCommand(config, ["update"], fetchFn)).toBe(1);
    expect(existsSync(config.modelsFile)).toBe(false);
  });
});

test("models update rejects catalog entries missing visibility rather than silently skipping them", async () => {
  await withPool(async (config) => {
    const fetchFn = (async () => Response.json({ models: [{
      slug: "gpt-6.1-sol", supported_reasoning_levels: [{ effort: "high" }],
    }] })) as unknown as typeof fetch;
    expect(await runModelsCommand(config, ["update"], fetchFn)).toBe(1);
    expect(existsSync(config.modelsFile)).toBe(false);
  });
});

test("models update refuses models with no supported API reasoning effort", async () => {
  for (const levels of [undefined, [], [{ effort: "ultra" }]]) {
    await withPool(async (config) => {
      const fetchFn = (async () => Response.json({ models: [{
        slug: "gpt-6.1-sol", visibility: "list", supported_reasoning_levels: levels,
      }] })) as unknown as typeof fetch;
      expect(await runModelsCommand(config, ["update"], fetchFn)).toBe(1);
      expect(existsSync(config.modelsFile)).toBe(false);
    });
  }
});

test("models update tries another authenticated account when the first cannot list models", async () => {
  await withPool(async (config) => {
    mkdirSync(join(config.accountsDir, "codex2"), { recursive: true });
    writeFileSync(join(config.accountsDir, "codex2", OPENAI_CREDS_FILENAME), JSON.stringify({
      accessToken: "second-token", accountId: "second-account", expiresAt: Date.now() + 3_600_000,
    }));
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
      const token = new Headers(init?.headers).get("authorization");
      return token === "Bearer second-token"
        ? Response.json({ models: [{ slug: "gpt-6.1-sol", visibility: "list", supported_reasoning_levels: [{ effort: "high" }] }] })
        : new Response("not eligible", { status: 403 });
    }) as typeof fetch;

    expect(await runModelsCommand(config, ["update"], fetchFn)).toBe(0);
    const saved = JSON.parse(readFileSync(config.modelsFile, "utf8"));
    expect(saved.models.some((m: { id: string }) => m.id === "gpt-6.1-sol")).toBe(true);
  });
});

test("models update combines successful catalogs from different accounts", async () => {
  await withPool(async (config) => {
    mkdirSync(join(config.accountsDir, "codex2"), { recursive: true });
    writeFileSync(join(config.accountsDir, "codex2", OPENAI_CREDS_FILENAME), JSON.stringify({
      accessToken: "second-token", accountId: "second-account", expiresAt: Date.now() + 3_600_000,
    }));
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
      const token = new Headers(init?.headers).get("authorization");
      return Response.json({ models: token === "Bearer second-token"
        ? [{ slug: "gpt-6.1-sol", visibility: "list", supported_reasoning_levels: [{ effort: "high" }] }]
        : [{ slug: "gpt-6-sol", visibility: "list", supported_reasoning_levels: [{ effort: "high" }] }],
      });
    }) as typeof fetch;

    expect(await runModelsCommand(config, ["update"], fetchFn)).toBe(0);
    expect(existsSync(config.modelsFile)).toBe(true);
    const saved = JSON.parse(readFileSync(config.modelsFile, "utf8"));
    expect(saved.models.find((m: { id: string }) => m.id === "gpt-6.1-sol")?.upstreamModel).toBe("gpt-6.1-sol");
  });
});

test("models update reports token-refresh failures without printing provider response bodies", async () => {
  await withPool(async (config) => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const fetchFn = (async (url: string | URL | Request) => String(url) === CODEX_TOKEN_URL
        ? new Response("private-upstream-secret", { status: 401 })
        : new Response("expired", { status: 401 })) as typeof fetch;
      expect(await runModelsCommand(config, ["update"], fetchFn)).toBe(1);
      const output = error.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(output).toContain("HTTP 401");
      expect(output).not.toContain("private-upstream-secret");
    } finally {
      error.mockRestore();
    }
  }, { refreshToken: "fixture-refresh" });
});
