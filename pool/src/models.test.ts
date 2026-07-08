import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadModelTable, resolveModel, DEFAULT_MODEL_TABLE } from "./models.ts";

describe("model table", () => {
  test("unknown model id falls through to anthropic pass-through", () => {
    const r = resolveModel(DEFAULT_MODEL_TABLE, "claude-sonnet-5");
    expect(r.provider).toBe("anthropic");
    expect(r.upstreamModel).toBe("claude-sonnet-5");
    expect(resolveModel(DEFAULT_MODEL_TABLE, "some-future-model").provider).toBe("anthropic");
  });

  test("openai models route to openai with the mapped upstream id", () => {
    const table = [...DEFAULT_MODEL_TABLE, { id: "gpt", provider: "openai" as const, upstreamModel: "gpt-5.2-codex" }];
    const r = resolveModel(table, "gpt");
    expect(r.provider).toBe("openai");
    expect(r.upstreamModel).toBe("gpt-5.2-codex");
  });

  test("loadModelTable merges file entries over defaults and survives a missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-models-"));
    const file = join(dir, "models.json");
    expect(loadModelTable(file)).toEqual(DEFAULT_MODEL_TABLE);
    writeFileSync(file, JSON.stringify({ models: [{ id: "gpt-x", provider: "openai", upstreamModel: "gpt-x" }] }));
    const table = loadModelTable(file);
    expect(table.find((m) => m.id === "gpt-x")?.provider).toBe("openai");
    expect(table.find((m) => m.id === "opus")).toBeDefined(); // defaults kept
  });
});
