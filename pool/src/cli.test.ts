import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { isValidProvider, parseContextArg, parsePriorityArg, runAccountsCommand, runModelsCommand } from "./cli.ts";
import { loadConfig } from "./config.ts";
import { loadModelConfig, saveModelConfig, DEFAULT_MODEL_TABLE } from "./models.ts";
import { handleContextUpdate, type MappingState } from "./server/server.ts";

// Every config built here points at a port where nothing is listening.
// `models context` now routes through a running pool when one answers, and the
// developer's own pool listens on the default 3456 — an unpinned test would
// mutate the real pool's models.json. Binding port 0 and releasing it yields a
// port the OS has just confirmed free, so the CLI's probe fails and it takes
// the offline file path. Tests that WANT the pool path start their own server
// and pass its port explicitly.
const DEAD_PORT = (() => {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = s.port as number;
  s.stop(true);
  return port;
})();

// FIX 6: `--provider chatgpt` (a typo) must not silently fall through to the
// default anthropic login — only "anthropic" and "openai" are real providers.
describe("isValidProvider", () => {
  test("accepts the two known providers", () => {
    expect(isValidProvider("anthropic")).toBe(true);
    expect(isValidProvider("openai")).toBe(true);
  });

  test("rejects typos and unknown providers", () => {
    expect(isValidProvider("chatgpt")).toBe(false);
    expect(isValidProvider("Anthropic")).toBe(false);
    expect(isValidProvider("")).toBe(false);
    expect(isValidProvider("codex")).toBe(false);
  });
});

test("parsePriorityArg accepts non-negative integers, rejects the rest", () => {
  expect(parsePriorityArg("0")).toBe(0);
  expect(parsePriorityArg("2")).toBe(2);
  expect(parsePriorityArg("-1")).toBeNull();
  expect(parsePriorityArg("1.5")).toBeNull();
  expect(parsePriorityArg("abc")).toBeNull();
  expect(parsePriorityArg(undefined)).toBeNull();
  // Empty/whitespace must not coerce to 0 (Number("") === 0).
  expect(parsePriorityArg("")).toBeNull();
  expect(parsePriorityArg("  ")).toBeNull();
});

test("accounts tier <name> <priority> writes routing.json", async () => {
  const poolDir = mkdtempSync(join(tmpdir(), "cmp-cli-"));
  const accountsDir = join(poolDir, "accounts");
  mkdirSync(join(accountsDir, "work"), { recursive: true });
  writeFileSync(
    join(accountsDir, "work", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "t" } }),
  );
  const config = loadConfig({
    port: DEAD_PORT,
    poolDir,
    accountsDir,
    usageFile: join(poolDir, "usage.json"),
    sessionsFile: join(poolDir, "sessions.json"),
  });
  try {
    const code = await runAccountsCommand(config, ["tier", "work", "1"]);
    expect(code).toBe(0);
    const onDisk = JSON.parse(readFileSync(join(accountsDir, "work", "routing.json"), "utf8"));
    expect(onDisk.priority).toBe(1);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("accounts tier rejects a bad priority with a non-zero exit code", async () => {
  const poolDir = mkdtempSync(join(tmpdir(), "cmp-cli-"));
  const accountsDir = join(poolDir, "accounts");
  mkdirSync(join(accountsDir, "work"), { recursive: true });
  writeFileSync(
    join(accountsDir, "work", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "t" } }),
  );
  const config = loadConfig({
    port: DEAD_PORT,
    poolDir,
    accountsDir,
    usageFile: join(poolDir, "usage.json"),
    sessionsFile: join(poolDir, "sessions.json"),
  });
  try {
    expect(await runAccountsCommand(config, ["tier", "work", "-1"])).toBe(1);
    expect(await runAccountsCommand(config, ["tier", "ghost", "1"])).toBe(1);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

describe("parseContextArg", () => {
  test("accepts a bare positive integer", () => {
    expect(parseContextArg("272000")).toBe(272_000);
  });

  test("rejects junk, negatives, decimals, zero and empty input", () => {
    // "0" gets its own explicit case: zero-handling has been the repeated
    // defect shape on this branch (parsePriorityArg allows 0; this must not).
    for (const raw of ["", " ", "abc", "-1", "1.5", "0", undefined]) {
      expect(parseContextArg(raw)).toBeNull();
    }
  });
});

test("models context <id> <tokens> writes maxContextWindow to models.json", async () => {
  const poolDir = mkdtempSync(join(tmpdir(), "cmp-cli-"));
  const config = loadConfig({
    port: DEAD_PORT,
    poolDir,
    accountsDir: join(poolDir, "accounts"),
    usageFile: join(poolDir, "usage.json"),
    sessionsFile: join(poolDir, "sessions.json"),
    modelsFile: join(poolDir, "models.json"),
  });
  try {
    // 111_000 deliberately does NOT match gpt-5.6's bundled maxContextWindow
    // (872_000, see DEFAULT_MODEL_TABLE in models.ts). If the override were
    // silently ignored and the merged/bundled table just re-persisted as-is,
    // this assertion would fail — unlike asserting 872_000, which a no-op
    // implementation would also satisfy by coincidence.
    const code = await runModelsCommand(config, ["context", "gpt-5.6", "111000"]);
    expect(code).toBe(0);
    const onDisk = JSON.parse(readFileSync(config.modelsFile, "utf8"));
    const row = onDisk.models.find((m: { id: string }) => m.id === "gpt-5.6");
    expect(row.maxContextWindow).toBe(111_000);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("models context leaves autoCompactWindow and mappings untouched", async () => {
  const poolDir = mkdtempSync(join(tmpdir(), "cmp-cli-"));
  const modelsFile = join(poolDir, "models.json");
  const config = loadConfig({
    port: DEAD_PORT,
    poolDir,
    accountsDir: join(poolDir, "accounts"),
    usageFile: join(poolDir, "usage.json"),
    sessionsFile: join(poolDir, "sessions.json"),
    modelsFile,
  });
  try {
    // Seed models.json with non-default values for every ModelConfig field
    // besides `models`, so an implementation that rebuilt the saved object
    // instead of spreading `cfg` would be caught losing them.
    const seed = loadModelConfig(modelsFile);
    saveModelConfig(modelsFile, {
      ...seed,
      mappingEnabled: true,
      mappings: [{ from: "opus", to: "gpt-5.6-luna" }],
      autoCompactWindow: 400_000,
    });

    const code = await runModelsCommand(config, ["context", "gpt-5.6", "111000"]);
    expect(code).toBe(0);

    const after = loadModelConfig(modelsFile);
    expect(after.autoCompactWindow).toBe(400_000);
    expect(after.mappingEnabled).toBe(true);
    expect(after.mappings.find((m) => m.from === "opus")?.to).toBe("gpt-5.6-luna");
    expect(after.models.find((m) => m.id === "gpt-5.6")?.maxContextWindow).toBe(111_000);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("models context rejects an unknown model id or bad token count", async () => {
  const poolDir = mkdtempSync(join(tmpdir(), "cmp-cli-"));
  const config = loadConfig({
    port: DEAD_PORT,
    poolDir,
    accountsDir: join(poolDir, "accounts"),
    usageFile: join(poolDir, "usage.json"),
    sessionsFile: join(poolDir, "sessions.json"),
    modelsFile: join(poolDir, "models.json"),
  });
  try {
    expect(await runModelsCommand(config, ["context", "not-a-real-model", "1000"])).toBe(1);
    expect(await runModelsCommand(config, ["context", "gpt-5.6", "-5"])).toBe(1);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

// A per-model ceiling below CLAUDE_MIN_AUTO_COMPACT can never be honoured (see
// context-update.test.ts for the full reasoning): clampContextWindow always
// raises the derived session window up to that floor, so a lower ceiling would
// make the pool reject requests Claude Code never compacts. The CLI must
// refuse it exactly like the dashboard/API does, and must not write anything.
test("models context rejects a sub-floor ceiling with a non-zero exit and no write", async () => {
  const poolDir = mkdtempSync(join(tmpdir(), "cmp-cli-"));
  const modelsFile = join(poolDir, "models.json");
  const config = loadConfig({
    port: DEAD_PORT,
    poolDir,
    accountsDir: join(poolDir, "accounts"),
    usageFile: join(poolDir, "usage.json"),
    sessionsFile: join(poolDir, "sessions.json"),
    modelsFile,
  });
  try {
    const code = await runModelsCommand(config, ["context", "gpt-5.6", "60000"]);
    expect(code).toBe(1);
    const after = loadModelConfig(modelsFile);
    expect(after.models.find((m) => m.id === "gpt-5.6")?.maxContextWindow).toBe(872_000);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("models context accepts the floor boundary and a large ceiling", async () => {
  const poolDir = mkdtempSync(join(tmpdir(), "cmp-cli-"));
  const modelsFile = join(poolDir, "models.json");
  const config = loadConfig({
    port: DEAD_PORT,
    poolDir,
    accountsDir: join(poolDir, "accounts"),
    usageFile: join(poolDir, "usage.json"),
    sessionsFile: join(poolDir, "sessions.json"),
    modelsFile,
  });
  try {
    expect(await runModelsCommand(config, ["context", "gpt-5.6", "100000"])).toBe(0);
    expect(loadModelConfig(modelsFile).models.find((m) => m.id === "gpt-5.6")?.maxContextWindow).toBe(100_000);

    expect(await runModelsCommand(config, ["context", "gpt-5.4", "1000000"])).toBe(0);
    expect(loadModelConfig(modelsFile).models.find((m) => m.id === "gpt-5.4")?.maxContextWindow).toBe(1_000_000);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});


// `models context` and the dashboard's POST /api/context are one seam now.
// They used to diverge in two user-visible ways: the CLI could not clear a
// ceiling at all, and it wrote models.json behind a running pool's back — so
// the pool kept serving its boot-time table and the next dashboard Save wrote
// that stale table straight over the CLI's edit.
describe("models context is the same seam as POST /api/context", () => {
  function fixture() {
    const poolDir = mkdtempSync(join(tmpdir(), "cmp-seam-"));
    const modelsFile = join(poolDir, "models.json");
    return { poolDir, modelsFile };
  }

  function cliConfig(modelsFile: string, poolDir: string, port: number) {
    return loadConfig({
      port,
      poolDir,
      accountsDir: join(poolDir, "accounts"),
      usageFile: join(poolDir, "usage.json"),
      sessionsFile: join(poolDir, "sessions.json"),
      modelsFile,
    });
  }

  /** A real pool speaking the real /api/context route. */
  function startPool(modelsFile: string) {
    const state: MappingState = { config: loadModelConfig(modelsFile) };
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/api/context" && req.method === "POST") {
          return handleContextUpdate(state, modelsFile, await req.json(), 500_000, null);
        }
        return new Response("not found", { status: 404 });
      },
    });
    return { state, server, port: server.port as number };
  }

  test("clears a ceiling back to the bundled default, like the dashboard's null", async () => {
    const { poolDir, modelsFile } = fixture();
    try {
      const config = cliConfig(modelsFile, poolDir, DEAD_PORT);
      expect(await runModelsCommand(config, ["context", "gpt-5.6", "300000"])).toBe(0);
      expect(loadModelConfig(modelsFile).models.find((m) => m.id === "gpt-5.6")?.maxContextWindow).toBe(300_000);

      expect(await runModelsCommand(config, ["context", "gpt-5.6", "default"])).toBe(0);
      const bundled = DEFAULT_MODEL_TABLE.find((m) => m.id === "gpt-5.6")?.maxContextWindow;
      expect(loadModelConfig(modelsFile).models.find((m) => m.id === "gpt-5.6")?.maxContextWindow).toBe(bundled);
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("hot-applies through a running pool instead of writing behind its back", async () => {
    const { poolDir, modelsFile } = fixture();
    const { state, server, port } = startPool(modelsFile);
    try {
      const config = cliConfig(modelsFile, poolDir, port);
      const code = await runModelsCommand(config, ["context", "gpt-5.6", "300000"]);
      expect(code).toBe(0);
      // The running pool itself knows — this is what the file-only CLI could
      // not do, and why a later dashboard Save used to revert the edit.
      expect(state.config.models.find((m) => m.id === "gpt-5.6")?.maxContextWindow).toBe(300_000);
      expect(loadModelConfig(modelsFile).models.find((m) => m.id === "gpt-5.6")?.maxContextWindow).toBe(300_000);
    } finally {
      server.stop(true);
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  // A pool started from an older build has no /api/context route. Its 404 means
  // "this pool is too old to hot-apply", not "your edit is invalid", so the CLI
  // must fall back to the file rather than report a failure the user can't act
  // on. Anyone upgrading meets exactly this: a long-running pool from before
  // the route existed.
  test("falls back to the file when the running pool has no context route", async () => {
    const { poolDir, modelsFile } = fixture();
    const server = Bun.serve({ port: 0, fetch: () => new Response("not found", { status: 404 }) });
    try {
      const config = cliConfig(modelsFile, poolDir, server.port as number);
      const code = await runModelsCommand(config, ["context", "gpt-5.6", "300000"]);
      expect(code).toBe(0);
      expect(loadModelConfig(modelsFile).models.find((m) => m.id === "gpt-5.6")?.maxContextWindow).toBe(300_000);
    } finally {
      server.stop(true);
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("a running pool's rejection is the CLI's rejection, and nothing is written", async () => {
    const { poolDir, modelsFile } = fixture();
    const { state, server, port } = startPool(modelsFile);
    try {
      const config = cliConfig(modelsFile, poolDir, port);
      const code = await runModelsCommand(config, ["context", "gpt-5.6", "60000"]);
      expect(code).toBe(1);
      expect(state.config.models.find((m) => m.id === "gpt-5.6")?.maxContextWindow).toBe(872_000);
      expect(loadModelConfig(modelsFile).models.find((m) => m.id === "gpt-5.6")?.maxContextWindow).toBe(872_000);
    } finally {
      server.stop(true);
      rmSync(poolDir, { recursive: true, force: true });
    }
  });
});
