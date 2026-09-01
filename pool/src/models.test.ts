import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadModelTable, resolveModel, DEFAULT_MODEL_TABLE, loadModelConfig, saveModelConfig,
  DEFAULT_MAPPINGS, type ModelConfig, mappingFor, modelsForListing, type ModelMapping,
  effectiveContextWindow, clampContextWindow, CLAUDE_DEFAULT_CONTEXT, CLAUDE_MAX_CONTEXT,
  CLAUDE_MIN_AUTO_COMPACT, sessionContextWindow, mappedContextWindows, buildContextStatus,
  applyContextEdits,
} from "./models.ts";
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
  return { models: DEFAULT_MODEL_TABLE, mappingEnabled: enabled, mappings, autoCompactWindow: null };
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

describe("context windows", () => {
  test("bundled gpt-5.6 tiers all carry the same 272k/872k window", () => {
    for (const id of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      const r = resolveModel(DEFAULT_MODEL_TABLE, id);
      expect(r.contextWindow).toBe(272_000);
      expect(r.maxContextWindow).toBe(872_000);
    }
  });

  test("older codex targets carry their real (smaller) ceilings", () => {
    expect(resolveModel(DEFAULT_MODEL_TABLE, "gpt-5.5").maxContextWindow).toBe(272_000);
    expect(resolveModel(DEFAULT_MODEL_TABLE, "gpt-5.4-mini").maxContextWindow).toBe(272_000);
    expect(resolveModel(DEFAULT_MODEL_TABLE, "gpt-5.4").maxContextWindow).toBe(1_000_000);
  });

  test("claude routes declare the 200k default and the 1M ceiling the [1m] pin unlocks", () => {
    const r = resolveModel(DEFAULT_MODEL_TABLE, "sonnet");
    expect(r.contextWindow).toBe(CLAUDE_DEFAULT_CONTEXT);
    expect(r.maxContextWindow).toBe(CLAUDE_MAX_CONTEXT);
  });

  test("effectiveContextWindow takes the ceiling under the cap, the cap over it", () => {
    const sol = resolveModel(DEFAULT_MODEL_TABLE, "gpt-5.6-sol");
    expect(effectiveContextWindow(sol, 500_000)).toBe(500_000);
    expect(effectiveContextWindow(sol, 1_000_000)).toBe(872_000);
    const mini = resolveModel(DEFAULT_MODEL_TABLE, "gpt-5.4-mini");
    expect(effectiveContextWindow(mini, 500_000)).toBe(272_000);
  });

  test("a route with no declared window falls back to the claude default", () => {
    const unknown = resolveModel(DEFAULT_MODEL_TABLE, "some-future-model");
    expect(effectiveContextWindow(unknown, 500_000)).toBe(CLAUDE_DEFAULT_CONTEXT);
  });

  // A 0 window would survive `??` all the way to Math.min(0, cap) === 0, and a
  // 0-window route makes checkContextWindow reject EVERY request to that model
  // — the one place in the 0/null family where a leak is catastrophic rather
  // than merely wrong. Upstream producers all guard today; this makes the guard
  // stop depending on that.
  test("a non-positive or non-finite window is treated as absent, not as a zero ceiling", () => {
    const base = { id: "x", provider: "openai" as const, upstreamModel: "x" };
    expect(effectiveContextWindow({ ...base, maxContextWindow: 0 }, 500_000)).toBe(CLAUDE_DEFAULT_CONTEXT);
    expect(effectiveContextWindow({ ...base, maxContextWindow: -1 }, 500_000)).toBe(CLAUDE_DEFAULT_CONTEXT);
    expect(effectiveContextWindow({ ...base, maxContextWindow: NaN }, 500_000)).toBe(CLAUDE_DEFAULT_CONTEXT);
    // A zeroed ceiling still falls back to a usable contextWindow when there is one.
    expect(
      effectiveContextWindow({ ...base, maxContextWindow: 0, contextWindow: 272_000 }, 500_000),
    ).toBe(272_000);
  });

  test("clampContextWindow holds the value inside Claude Code's accepted range", () => {
    expect(clampContextWindow(50_000)).toBe(CLAUDE_MIN_AUTO_COMPACT);
    expect(clampContextWindow(2_000_000)).toBe(CLAUDE_MAX_CONTEXT);
    expect(clampContextWindow(272_000)).toBe(272_000);
  });

  test("models.json can override a bundled window, and junk values are dropped", () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-ctx-"));
    const file = join(dir, "models.json");
    writeFileSync(
      file,
      JSON.stringify({
        models: [
          { id: "gpt-5.6-sol", provider: "openai", upstreamModel: "gpt-5.6-sol", maxContextWindow: 400_000 },
          { id: "junk", provider: "openai", upstreamModel: "junk", contextWindow: -5, maxContextWindow: "big" },
        ],
      }),
    );
    const table = loadModelTable(file);
    expect(resolveModel(table, "gpt-5.6-sol").maxContextWindow).toBe(400_000);
    const junk = resolveModel(table, "junk");
    expect(junk.contextWindow).toBeUndefined();
    expect(junk.maxContextWindow).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  // Every save persists the FULL materialized table, so an upgrade from a bro
  // that predates windows finds a models.json shadowing every bundled route
  // with a window-less entry. Without a backfill each one silently collapses to
  // CLAUDE_DEFAULT_CONTEXT and the Codex guard rejects anything over 200K.
  test("a pre-windows models.json still gets the bundled windows back", () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-ctx-mig-"));
    const file = join(dir, "models.json");
    writeFileSync(
      file,
      JSON.stringify({
        models: DEFAULT_MODEL_TABLE.map((m) => ({
          id: m.id,
          provider: m.provider,
          upstreamModel: m.upstreamModel,
        })),
      }),
    );
    const table = loadModelTable(file);
    const sol = resolveModel(table, "gpt-5.6-sol");
    expect(sol.contextWindow).toBe(272_000);
    expect(sol.maxContextWindow).toBe(872_000);
    expect(effectiveContextWindow(sol, 500_000)).toBe(500_000);
    expect(effectiveContextWindow(resolveModel(table, "gpt-5.4-mini"), 500_000)).toBe(272_000);
    expect(resolveModel(table, "sonnet").maxContextWindow).toBe(CLAUDE_MAX_CONTEXT);
    rmSync(dir, { recursive: true, force: true });
  });

  // Backfilling by id alone would hand a re-pointed row the wrong windows.
  test("a re-provisioned id does not inherit the bundled provider's windows", () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-ctx-prov-"));
    const file = join(dir, "models.json");
    writeFileSync(
      file,
      JSON.stringify({ models: [{ id: "sonnet", provider: "openai", upstreamModel: "gpt-5.6-sol" }] }),
    );
    const sonnet = resolveModel(loadModelTable(file), "sonnet");
    expect(sonnet.contextWindow).toBeUndefined();
    expect(sonnet.maxContextWindow).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  // A hand-edited sub-floor maxContextWindow can't be honoured: clampContextWindow
  // still raises the derived session window to CLAUDE_MIN_AUTO_COMPACT, so a
  // lower on-disk ceiling would create the unreachable band this whole change
  // exists to close (see ceiling-floor-spec.md). Loading has no request to 400,
  // so it must fall back to the bundled ceiling instead of trusting the file.
  test("a sub-floor maxContextWindow in the file is ignored; the bundled ceiling wins", () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-ctx-floor-"));
    const file = join(dir, "models.json");
    writeFileSync(
      file,
      JSON.stringify({
        models: [{ id: "gpt-5.4-mini", provider: "openai", upstreamModel: "gpt-5.4-mini", maxContextWindow: 60_000 }],
      }),
    );
    const mini = resolveModel(loadModelTable(file), "gpt-5.4-mini");
    expect(mini.maxContextWindow).toBe(272_000);
    rmSync(dir, { recursive: true, force: true });
  });

  // Same rule for contextWindow: it feeds the same ceiling fallback chain in
  // effectiveContextWindow when maxContextWindow is absent, so a sub-floor
  // contextWindow creates the identical unreachable band.
  test("a sub-floor contextWindow in the file is ignored; the bundled default wins", () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-ctx-floor2-"));
    const file = join(dir, "models.json");
    writeFileSync(
      file,
      JSON.stringify({
        models: [{ id: "gpt-5.5", provider: "openai", upstreamModel: "gpt-5.5", contextWindow: 50_000 }],
      }),
    );
    const m = resolveModel(loadModelTable(file), "gpt-5.5");
    expect(m.contextWindow).toBe(272_000);
    rmSync(dir, { recursive: true, force: true });
  });

  // A value present and >= the floor still wins over the bundled row — 05a0331's
  // "file wins" contract must survive this change untouched.
  test("a valid in-range file value still overrides the bundled ceiling", () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-ctx-floor3-"));
    const file = join(dir, "models.json");
    writeFileSync(
      file,
      JSON.stringify({
        models: [{ id: "gpt-5.4-mini", provider: "openai", upstreamModel: "gpt-5.4-mini", maxContextWindow: CLAUDE_MIN_AUTO_COMPACT }],
      }),
    );
    const mini = resolveModel(loadModelTable(file), "gpt-5.4-mini");
    expect(mini.maxContextWindow).toBe(CLAUDE_MIN_AUTO_COMPACT);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("session context window", () => {
  const cfg = (over: Partial<ModelConfig> = {}): ModelConfig => ({
    models: DEFAULT_MODEL_TABLE,
    mappingEnabled: true,
    mappings: DEFAULT_MAPPINGS,
    autoCompactWindow: null,
    ...over,
  });

  test("null when mapping is off — Claude Code keeps its own auto tuning", () => {
    expect(sessionContextWindow(cfg({ mappingEnabled: false }), 500_000)).toBeNull();
  });

  test("null when every row is inert (Claude-only)", () => {
    const rows = DEFAULT_MAPPINGS.map((m) => ({ from: m.from, to: m.from }));
    expect(sessionContextWindow(cfg({ mappings: rows }), 500_000)).toBeNull();
  });

  test("takes the minimum across mapped families, so it is safe for every reachable model", () => {
    // defaults map haiku -> gpt-5.4-mini, whose ceiling is 272K.
    expect(sessionContextWindow(cfg(), 500_000)).toBe(272_000);
  });

  test("without the 272K outlier the cap binds instead", () => {
    const rows: ModelMapping[] = [
      { from: "fable", to: "gpt-5.6-sol" },
      { from: "opus", to: "gpt-5.6-terra" },
      { from: "sonnet", to: "gpt-5.6-luna" },
      { from: "haiku", to: "haiku" },
    ];
    expect(sessionContextWindow(cfg({ mappings: rows }), 500_000)).toBe(500_000);
    expect(sessionContextWindow(cfg({ mappings: rows }), 1_000_000)).toBe(872_000);
  });

  test("mappedContextWindows reports each mapped family's target and window", () => {
    const rows: ModelMapping[] = [
      { from: "opus", to: "gpt-5.6-terra" },
      { from: "sonnet", to: "sonnet" },
      { from: "haiku", to: "gpt-5.4-mini" },
    ];
    const got = mappedContextWindows(cfg({ mappings: rows }), 500_000);
    expect(got).toEqual([
      { family: "opus", target: "gpt-5.6-terra", window: 500_000 },
      { family: "haiku", target: "gpt-5.4-mini", window: 272_000 },
    ]);
  });

  test("a tiny custom window still clamps up to Claude Code's 100K floor", () => {
    const models = [
      ...DEFAULT_MODEL_TABLE,
      { id: "tiny", provider: "openai" as const, upstreamModel: "tiny", maxContextWindow: 30_000 },
    ];
    const rows: ModelMapping[] = [{ from: "opus", to: "tiny" }];
    expect(sessionContextWindow(cfg({ models, mappings: rows }), 500_000)).toBe(100_000);
  });

  test("a persisted autoCompactWindow beats the derived minimum", () => {
    expect(sessionContextWindow(cfg({ autoCompactWindow: 400_000 }), 500_000)).toBe(400_000);
  });

  test("the env override beats the persisted one", () => {
    expect(sessionContextWindow(cfg({ autoCompactWindow: 400_000 }), 500_000, 300_000)).toBe(300_000);
  });

  test("an override applies even with mapping off — it is an explicit choice", () => {
    expect(sessionContextWindow(cfg({ mappingEnabled: false }), 500_000, 300_000)).toBe(300_000);
  });

  test("overrides clamp into Claude Code's accepted range", () => {
    expect(sessionContextWindow(cfg(), 500_000, 20_000)).toBe(100_000);
  });

  // Both are unreachable today (loadModelConfig and optionalWindowEnv reject
  // non-positive values), but sessionContextWindow and buildContextStatus used
  // to test "is it set?" three different ways, so the invariant depended on
  // every producer continuing to guard. One predicate now decides it.
  test("a zeroed override or persisted window means derive, in every reader", () => {
    expect(sessionContextWindow(cfg(), 500_000, 0)).toBe(272_000);
    expect(sessionContextWindow(cfg({ autoCompactWindow: 0 }), 500_000)).toBe(272_000);

    const zeroLock = buildContextStatus(cfg(), 500_000, 0);
    expect(zeroLock.source).toBe("derived");
    // envLocked used to say `true` here while source said "derived" — the
    // dashboard would have greyed out a field nothing was actually locking.
    expect(zeroLock.envLocked).toBe(false);

    const realLock = buildContextStatus(cfg(), 500_000, 300_000);
    expect(realLock.source).toBe("env");
    expect(realLock.envLocked).toBe(true);
  });
});

describe("models.json auto-compact override round-trip", () => {
  test("saves and reloads autoCompactWindow, dropping junk values", () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-acw-"));
    const file = join(dir, "models.json");
    saveModelConfig(file, {
      models: DEFAULT_MODEL_TABLE,
      mappingEnabled: true,
      mappings: DEFAULT_MAPPINGS,
      autoCompactWindow: 400_000,
    });
    expect(loadModelConfig(file).autoCompactWindow).toBe(400_000);

    writeFileSync(file, JSON.stringify({ models: [], mappingEnabled: true, autoCompactWindow: "wide" }));
    expect(loadModelConfig(file).autoCompactWindow).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});


// One validated core behind BOTH context-mutation surfaces (POST /api/context
// and `models context`). Before this existed the two restated the rules
// separately and disagreed: the CLI could not clear a ceiling at all, and it
// wrote the file behind a running pool's back so the next dashboard Save
// reverted it.
describe("applyContextEdits", () => {
  const base = (): ModelConfig => ({
    models: DEFAULT_MODEL_TABLE.map((m) => ({ ...m })),
    mappingEnabled: true,
    mappings: [...DEFAULT_MAPPINGS],
    autoCompactWindow: null,
  });

  test("sets a per-model ceiling and returns a new config", () => {
    const r = applyContextEdits(base(), { models: [{ id: "gpt-5.6", maxContextWindow: 500_000 }] }, null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.models.find((m) => m.id === "gpt-5.6")?.maxContextWindow).toBe(500_000);
  });

  test("does not mutate the config it was given", () => {
    const cfg = base();
    const before = cfg.models.find((m) => m.id === "gpt-5.6")?.maxContextWindow;
    applyContextEdits(cfg, { models: [{ id: "gpt-5.6", maxContextWindow: 500_000 }] }, null);
    expect(cfg.models.find((m) => m.id === "gpt-5.6")?.maxContextWindow).toBe(before);
  });

  test("null clears a ceiling back to the bundled default", () => {
    const edited = applyContextEdits(base(), { models: [{ id: "gpt-5.6", maxContextWindow: 500_000 }] }, null);
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    const cleared = applyContextEdits(edited.config, { models: [{ id: "gpt-5.6", maxContextWindow: null }] }, null);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    const bundled = DEFAULT_MODEL_TABLE.find((m) => m.id === "gpt-5.6")?.maxContextWindow;
    expect(cleared.config.models.find((m) => m.id === "gpt-5.6")?.maxContextWindow).toBe(bundled);
  });

  test("rejects an unknown model id with a 400", () => {
    const r = applyContextEdits(base(), { models: [{ id: "nope", maxContextWindow: 500_000 }] }, null);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(400);
    expect(r.message).toContain("nope");
  });

  test("rejects a sub-floor ceiling with a 400 and commits nothing", () => {
    const r = applyContextEdits(
      base(),
      { models: [{ id: "gpt-5.4", maxContextWindow: 800_000 }, { id: "gpt-5.6", maxContextWindow: 60_000 }] },
      null,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(400);
    expect(r.message).toContain("60,000");
  });

  test("rejects an autoCompactWindow edit while the env override is set, with a 409", () => {
    const r = applyContextEdits(base(), { autoCompactWindow: 300_000 }, 400_000);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(409);
  });

  test("accepts the floor boundary and a large ceiling", () => {
    for (const n of [CLAUDE_MIN_AUTO_COMPACT, 872_000, 1_000_000]) {
      const r = applyContextEdits(base(), { models: [{ id: "gpt-5.6", maxContextWindow: n }] }, null);
      expect(r.ok).toBe(true);
    }
  });
});


// The sub-floor warning used to promise a fallback that does not exist for a
// user-added id: BUNDLED_BY_ID has no row, so the field is dropped and the
// model silently lands on CLAUDE_DEFAULT_CONTEXT instead. Saying "falling back
// to the bundled value" there sends the reader looking for a bundled number
// that was never involved.
test("sub-floor warning says what actually happens when there is no bundled row", () => {
  const dir = mkdtempSync(join(tmpdir(), "pool-nofallback-"));
  const modelsFile = join(dir, "models.json");
  writeFileSync(
    modelsFile,
    JSON.stringify({
      models: [{ id: "my-small", provider: "openai", upstreamModel: "my-small", maxContextWindow: 64_000 }],
    }),
  );
  const seen: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void seen.push(args.map(String).join(" "));
  try {
    const cfg = loadModelConfig(modelsFile);
    expect(cfg.models.find((m) => m.id === "my-small")?.maxContextWindow).toBeUndefined();
    const text = seen.join("\n");
    expect(text).toContain("my-small");
    expect(text).not.toContain("bundled value");
    expect(text).toContain(String(CLAUDE_DEFAULT_CONTEXT.toLocaleString("en-US")));
  } finally {
    console.warn = original;
    rmSync(dir, { recursive: true, force: true });
  }
});


// An EXPLICIT session window bypasses the min-across-mapped derivation on
// purpose ("I know what I'm mapping"). But setting it above the smallest mapped
// model re-opens the unreachable band that ceilingBelowFloor exists to close,
// from the other side: Claude Code will not compact until the larger number
// while the guard hard-rejects that model at its own smaller window. Deliberate
// enough not to refuse, dangerous enough to say out loud.
describe("session window vs the smallest mapped model", () => {
  const withWindow = (autoCompactWindow: number | null): ModelConfig => ({
    models: DEFAULT_MODEL_TABLE,
    mappingEnabled: true,
    mappings: [{ from: "haiku", to: "gpt-5.4-mini" }],
    autoCompactWindow,
  });

  test("warns when an explicit window outruns the smallest mapped model", () => {
    const st = buildContextStatus(withWindow(500_000), 500_000, null);
    expect(st.warning).not.toBeNull();
    expect(st.warning).toContain("272,000");
    expect(st.warning).toContain("gpt-5.4-mini");
  });

  test("warns the same way for the env override", () => {
    const st = buildContextStatus(withWindow(null), 500_000, 500_000);
    expect(st.warning).toContain("272,000");
    expect(st.warning).toContain("gpt-5.4-mini");
  });

  test("stays silent when the explicit window fits, and when it is derived", () => {
    expect(buildContextStatus(withWindow(200_000), 500_000, null).warning).toBeNull();
    expect(buildContextStatus(withWindow(272_000), 500_000, null).warning).toBeNull();
    expect(buildContextStatus(withWindow(null), 500_000, null).warning).toBeNull();
  });
});
