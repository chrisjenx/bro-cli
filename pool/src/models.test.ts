import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadModelTable, resolveModel, DEFAULT_MODEL_TABLE, loadModelConfig, saveModelConfig, DEFAULT_MAPPINGS, type ModelConfig, mappingFor, modelsForListing, type ModelMapping } from "./models.ts";
import { modelFamilyOf } from "./accounts/types.ts";

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

  test("gpt-5.6 family routes to openai: sol/terra/luna slugs plus gpt-5.6 alias -> sol", () => {
    for (const id of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      const r = resolveModel(DEFAULT_MODEL_TABLE, id);
      expect(r.provider).toBe("openai");
      expect(r.upstreamModel).toBe(id);
    }
    // Family alias: codex-rs models.json routes bare "gpt-5.6" to Sol.
    const alias = resolveModel(DEFAULT_MODEL_TABLE, "gpt-5.6");
    expect(alias.provider).toBe("openai");
    expect(alias.upstreamModel).toBe("gpt-5.6-sol");
  });

  test("modelsForListing shows one entry per Claude family (the alias), keeps openai + custom ids", () => {
    const ids = modelsForListing(DEFAULT_MODEL_TABLE).map((m) => m.id);
    // one alias per Claude family, and no bundled full-id duplicates
    for (const alias of ["opus", "sonnet", "haiku", "fable"]) expect(ids).toContain(alias);
    for (const full of ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5"]) {
      expect(ids).not.toContain(full);
    }
    // exactly one Sonnet in the listing
    expect(ids.filter((id) => modelFamilyOf(id) === "sonnet")).toEqual(["sonnet"]);
    // openai entries are untouched
    expect(ids).toContain("gpt-5.6-sol");
    expect(ids).toContain("gpt-5.6");
    // user-added anthropic ids stay visible (only the bundled dupes are hidden)
    const withCustom = [
      ...DEFAULT_MODEL_TABLE,
      { id: "claude-sonnet-5-20991231", provider: "anthropic" as const, upstreamModel: "claude-sonnet-5-20991231" },
    ];
    expect(modelsForListing(withCustom).map((m) => m.id)).toContain("claude-sonnet-5-20991231");
    // routing is unaffected — a hidden id still resolves
    expect(resolveModel(DEFAULT_MODEL_TABLE, "claude-sonnet-5").upstreamModel).toBe("claude-sonnet-5");
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

describe("loadModelConfig", () => {
  test("missing file yields defaults with mapping off", () => {
    const dir = mkdtempSync(join(tmpdir(), "models-"));
    const cfg = loadModelConfig(join(dir, "models.json"));
    expect(cfg.mappingEnabled).toBe(false);
    expect(cfg.mappings).toEqual(DEFAULT_MAPPINGS);
    expect(cfg.models.some((m) => m.id === "fable")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("user mappings shadow defaults by family and enabled flag round-trips", () => {
    const dir = mkdtempSync(join(tmpdir(), "models-"));
    const file = join(dir, "models.json");
    writeFileSync(
      file,
      JSON.stringify({
        models: [],
        mappingEnabled: true,
        mappings: [{ from: "fable", to: "fable" }, { from: "haiku", to: "gpt-5.4-mini", effort: { low: "medium" } }],
      }),
    );
    const cfg = loadModelConfig(file);
    expect(cfg.mappingEnabled).toBe(true);
    // Shadowed families take the user row; the rest keep defaults.
    expect(cfg.mappings.find((m) => m.from === "fable")!.to).toBe("fable");
    expect(cfg.mappings.find((m) => m.from === "opus")!.to).toBe("gpt-5.6-terra");
    expect(cfg.mappings.find((m) => m.from === "haiku")!.effort).toEqual({ low: "medium" });
    rmSync(dir, { recursive: true, force: true });
  });

  test("malformed mapping fields fall back to defaults with mapping off", () => {
    const dir = mkdtempSync(join(tmpdir(), "models-"));
    const file = join(dir, "models.json");
    writeFileSync(file, JSON.stringify({ models: [], mappingEnabled: "yes", mappings: "nope" }));
    const cfg = loadModelConfig(file);
    expect(cfg.mappingEnabled).toBe(false);
    expect(cfg.mappings).toEqual(DEFAULT_MAPPINGS);
    rmSync(dir, { recursive: true, force: true });
  });

  test("invalid effort values are dropped from an otherwise valid row", () => {
    const dir = mkdtempSync(join(tmpdir(), "models-"));
    const file = join(dir, "models.json");
    writeFileSync(
      file,
      JSON.stringify({ mappings: [{ from: "opus", to: "gpt-5.6-sol", effort: { low: "ultra", high: "max" } }] }),
    );
    const cfg = loadModelConfig(file);
    const opus = cfg.mappings.find((m) => m.from === "opus")!;
    expect(opus.effort).toEqual({ high: "max" });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("saveModelConfig", () => {
  test("round-trips models + mapping state", () => {
    const dir = mkdtempSync(join(tmpdir(), "models-"));
    const file = join(dir, "models.json");
    const cfg: ModelConfig = loadModelConfig(file);
    cfg.mappingEnabled = true;
    saveModelConfig(file, cfg);
    const reread = loadModelConfig(file);
    expect(reread.mappingEnabled).toBe(true);
    expect(reread.mappings).toEqual(cfg.mappings);
    expect(JSON.parse(readFileSync(file, "utf8")).models.length).toBe(cfg.models.length);
    rmSync(dir, { recursive: true, force: true });
  });
});

function cfgWith(mappings: ModelMapping[], enabled = true): ModelConfig {
  return { models: DEFAULT_MODEL_TABLE, mappingEnabled: enabled, mappings };
}

describe("mappingFor", () => {
  const base = [{ from: "fable", to: "gpt-5.6-sol", effort: { max: "xhigh" as const } }];

  test("maps a family alias and a full model id to the openai route", () => {
    const cfg = cfgWith(base);
    for (const id of ["fable", "claude-fable-5"]) {
      const route = mappingFor(cfg, id)!;
      expect(route.provider).toBe("openai");
      expect(route.upstreamModel).toBe("gpt-5.6-sol");
      expect(route.effortMap).toEqual({ max: "xhigh" });
      expect(route.id).toBe(id);
    }
  });

  test("disabled flag, unknown family, and missing row return null", () => {
    expect(mappingFor(cfgWith(base, false), "fable")).toBeNull();
    expect(mappingFor(cfgWith(base), "gpt-5.5")).toBeNull();
    expect(mappingFor(cfgWith(base), "sonnet")).toBeNull();
  });

  test("inert rows return null: identity target and anthropic target", () => {
    expect(mappingFor(cfgWith([{ from: "fable", to: "fable" }]), "fable")).toBeNull();
    expect(mappingFor(cfgWith([{ from: "opus", to: "claude-opus-4-8" }]), "opus")).toBeNull();
  });

  test("target that is a family alias of gpt (bare gpt-5.6) resolves through the table", () => {
    const route = mappingFor(cfgWith([{ from: "haiku", to: "gpt-5.6" }]), "haiku")!;
    expect(route.upstreamModel).toBe("gpt-5.6-sol"); // table maps gpt-5.6 -> sol
  });
});
