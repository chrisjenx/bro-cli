import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadModelTable, resolveModel, DEFAULT_MODEL_TABLE, loadModelConfig, saveModelConfig, DEFAULT_MAPPINGS, type ModelConfig, mappingFor, modelsForListing, type ModelMapping, CODEX_EXTENDED_CONTEXT_MIN, supportedEffortsFor } from "./models.ts";
import { modelFamilyOf } from "./accounts/types.ts";

describe("model table", () => {
  test("unknown model id falls through to anthropic pass-through", () => {
    const r = resolveModel(DEFAULT_MODEL_TABLE, "claude-sonnet-5");
    expect(r.provider).toBe("anthropic");
    expect(r.upstreamModel).toBe("claude-sonnet-5");
    expect(resolveModel(DEFAULT_MODEL_TABLE, "some-future-model").provider).toBe("anthropic");
  });

  test("Fable 5.1 routes to anthropic under its own id", () => {
    // Claude Code strips the `[1m]` suffix, so the pool receives the bare id.
    const r = resolveModel(DEFAULT_MODEL_TABLE, "claude-fable-5-1");
    expect(r.provider).toBe("anthropic");
    expect(r.upstreamModel).toBe("claude-fable-5-1");
    // 5.1 must not be swallowed by the 5 route — distinct upstream ids.
    expect(resolveModel(DEFAULT_MODEL_TABLE, "claude-fable-5").upstreamModel).toBe("claude-fable-5");
    // ...but both still belong to the `fable` family for account/limit purposes.
    expect(modelFamilyOf("claude-fable-5-1")).toBe("fable");
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

  test("custom aliases inherit capabilities from known upstream models", () => {
    const table = [
      { id: "sol-alias", provider: "openai" as const, upstreamModel: "gpt-5.6-sol" },
      { id: "astra-alias", provider: "openai" as const, upstreamModel: "gpt-6-astra" },
    ];
    expect(supportedEffortsFor(resolveModel(table, "sol-alias"))).toContain("max");
    expect(supportedEffortsFor(resolveModel(table, "astra-alias"))).not.toContain("none");
  });

  test("GPT-6 Astra routes directly to the matching Codex model", () => {
    const route = resolveModel(DEFAULT_MODEL_TABLE, "gpt-6-astra");
    expect(route).toMatchObject({
      id: "gpt-6-astra",
      provider: "openai",
      upstreamModel: "gpt-6-astra",
      contextWindow: 272_000,
      maxContextWindow: 872_000,
    });
    expect(supportedEffortsFor(route)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("modelsForListing shows one entry per Claude family (the alias), keeps openai + custom ids", () => {
    const ids = modelsForListing(DEFAULT_MODEL_TABLE).map((m) => m.id);
    // one alias per Claude family, and no bundled full-id duplicates
    for (const alias of ["opus", "sonnet", "haiku", "fable"]) expect(ids).toContain(alias);
    for (const full of ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5", "claude-fable-5-1"]) {
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

  test("duplicate configured model ids keep the first route consistently", () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-models-"));
    const file = join(dir, "models.json");
    writeFileSync(file, JSON.stringify({ models: [
      { id: "duplicate", provider: "openai", upstreamModel: "first", supportedEfforts: ["low"] },
      { id: "duplicate", provider: "openai", upstreamModel: "second", supportedEfforts: ["max"] },
    ] }));
    expect(resolveModel(loadModelTable(file), "duplicate")).toMatchObject({
      upstreamModel: "first",
      supportedEfforts: ["low"],
    });
    rmSync(dir, { recursive: true, force: true });
  });

  test("bundled Codex routes carry their verified default and maximum contexts", () => {
    const expected = new Map([
      ["gpt-6-astra", [272_000, 872_000]],
      ["gpt-5.6-sol", [272_000, 872_000]],
      ["gpt-5.6-terra", [272_000, 872_000]],
      ["gpt-5.6-luna", [272_000, 872_000]],
      ["gpt-5.6", [272_000, 872_000]],
      ["gpt-5.5", [272_000, 272_000]],
      ["gpt-5.4", [272_000, 1_000_000]],
      ["gpt-5.4-mini", [272_000, 272_000]],
    ]);
    expect(CODEX_EXTENDED_CONTEXT_MIN).toBe(872_000);
    for (const [id, [contextWindow, maxContextWindow]] of expected) {
      expect(resolveModel(DEFAULT_MODEL_TABLE, id)).toMatchObject({ contextWindow, maxContextWindow });
    }
  });

  test("legacy bundled rows inherit context metadata without overriding explicit values", () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-model-context-"));
    const file = join(dir, "models.json");
    writeFileSync(file, JSON.stringify({ models: [
      { id: "gpt-5.6-sol", provider: "openai", upstreamModel: "gpt-5.6-sol" },
      { id: "gpt-5.5", provider: "openai", upstreamModel: "gpt-5.5", contextWindow: 250_000, maxContextWindow: 260_000 },
    ] }));
    const table = loadModelTable(file);
    expect(resolveModel(table, "gpt-5.6-sol")).toMatchObject({ contextWindow: 272_000, maxContextWindow: 872_000 });
    expect(resolveModel(table, "gpt-5.5")).toMatchObject({ contextWindow: 250_000, maxContextWindow: 260_000 });
    rmSync(dir, { recursive: true, force: true });
  });

  test("repointed and custom rows do not inherit unrelated bundled context", () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-model-context-"));
    const file = join(dir, "models.json");
    writeFileSync(file, JSON.stringify({ models: [
      { id: "gpt-5.6-sol", provider: "openai", upstreamModel: "custom-sol" },
      { id: "custom", provider: "openai", upstreamModel: "custom", contextWindow: -1, maxContextWindow: "wide" },
      { id: "contradictory", provider: "openai", upstreamModel: "contradictory", contextWindow: 1_000_000, maxContextWindow: 272_000 },
    ] }));
    const table = loadModelTable(file);
    expect(resolveModel(table, "gpt-5.6-sol").contextWindow).toBeUndefined();
    expect(resolveModel(table, "gpt-5.6-sol").maxContextWindow).toBeUndefined();
    expect(resolveModel(table, "custom").contextWindow).toBeUndefined();
    expect(resolveModel(table, "custom").maxContextWindow).toBeUndefined();
    expect(resolveModel(table, "contradictory").contextWindow).toBeUndefined();
    expect(resolveModel(table, "contradictory").maxContextWindow).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  test("loaded direct routes preserve valid effort overrides", () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-model-effort-"));
    const file = join(dir, "models.json");
    writeFileSync(file, JSON.stringify({ models: [{
      id: "gpt-custom",
      provider: "openai",
      upstreamModel: "gpt-custom",
      effortMap: { max: "xhigh", invalid: "high", low: "invalid" },
    }] }));
    expect(resolveModel(loadModelTable(file), "gpt-custom").effortMap).toEqual({ max: "xhigh" });
    rmSync(dir, { recursive: true, force: true });
  });

  test("loaded routes preserve explicit supported efforts and drop invalid values", () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-model-capability-"));
    const file = join(dir, "models.json");
    writeFileSync(file, JSON.stringify({ models: [
      { id: "frontier", provider: "openai", upstreamModel: "frontier", supportedEfforts: ["low", "max", "ultra", "low"] },
      { id: "limited", provider: "openai", upstreamModel: "limited", supportedEfforts: ["none", "low"] },
      { id: "empty", provider: "openai", upstreamModel: "empty", supportedEfforts: [] },
      { id: "all-invalid", provider: "openai", upstreamModel: "all-invalid", supportedEfforts: ["ultra"] },
      { id: "invalid", provider: "openai", upstreamModel: "invalid", supportedEfforts: "all" },
    ] }));
    const table = loadModelTable(file);
    expect(resolveModel(table, "frontier").supportedEfforts).toEqual(["low", "max"]);
    expect(resolveModel(table, "limited").supportedEfforts).toEqual(["none", "low"]);
    expect(resolveModel(table, "empty").supportedEfforts).toEqual([]);
    expect(resolveModel(table, "all-invalid").supportedEfforts).toEqual([]);
    expect(resolveModel(table, "invalid").supportedEfforts).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a trailing 1m selector resolves to the bare route unless configured exactly", () => {
    const routed = resolveModel(DEFAULT_MODEL_TABLE, "gpt-5.6-sol[1m]");
    expect(routed.id).toBe("gpt-5.6-sol[1m]");
    expect(routed.provider).toBe("openai");
    expect(routed.upstreamModel).toBe("gpt-5.6-sol");

    const exact = resolveModel([
      ...DEFAULT_MODEL_TABLE,
      { id: "literal[1m]", provider: "openai" as const, upstreamModel: "literal-upstream" },
    ], "literal[1m]");
    expect(exact.upstreamModel).toBe("literal-upstream");

    const unknown = resolveModel(DEFAULT_MODEL_TABLE, "unknown-anthropic[1m]");
    expect(unknown.upstreamModel).toBe("unknown-anthropic[1m]");
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

  test("persisted mappings stay authoritative while missing families get current defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "models-"));
    const file = join(dir, "models.json");
    writeFileSync(file, JSON.stringify({
      mappingEnabled: true,
      mappings: [
        { from: "fable", to: "gpt-5.6-sol" },
        { from: "sonnet", to: "gpt-5.5" },
      ],
    }));
    const cfg = loadModelConfig(file);
    expect(cfg.mappingEnabled).toBe(true);
    expect(cfg.mappings.find((m) => m.from === "fable")?.to).toBe("gpt-5.6-sol");
    expect(cfg.mappings.find((m) => m.from === "sonnet")?.to).toBe("gpt-5.5");
    expect(cfg.mappings.find((m) => m.from === "opus")?.to).toBe("gpt-5.6-sol");
    expect(cfg.mappings.find((m) => m.from === "haiku")?.to).toBe("gpt-5.6-luna");
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
    expect(cfg.mappings.find((m) => m.from === "opus")!.to).toBe("gpt-5.6-sol");
    expect(cfg.mappings.find((m) => m.from === "haiku")!.effort).toEqual({ low: "medium" });
    rmSync(dir, { recursive: true, force: true });
  });

  test("default mappings target the requested Codex generation by Claude family", () => {
    const cfg = cfgWith(DEFAULT_MAPPINGS);
    const expected = {
      fable: "gpt-6-astra",
      opus: "gpt-5.6-sol",
      sonnet: "gpt-5.6-terra",
      haiku: "gpt-5.6-luna",
    };
    for (const [family, upstreamModel] of Object.entries(expected)) {
      expect(mappingFor(cfg, family)?.upstreamModel).toBe(upstreamModel);
    }
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

  test("target-incompatible effort overrides are dropped while loading", () => {
    const dir = mkdtempSync(join(tmpdir(), "models-"));
    const file = join(dir, "models.json");
    writeFileSync(file, JSON.stringify({ mappings: [{
      from: "fable",
      to: "gpt-6-astra",
      effort: { low: "none", high: "high" },
    }] }));
    expect(loadModelConfig(file).mappings.find((m) => m.from === "fable")?.effort).toEqual({ high: "high" });
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
      expect(route.contextWindow).toBe(272_000);
      expect(route.maxContextWindow).toBe(872_000);
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
