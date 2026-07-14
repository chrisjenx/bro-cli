import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { handleMappingsUpdate, type MappingState } from "./server.ts";
import { loadModelConfig } from "../models.ts";

function freshState(): { state: MappingState; file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "mappings-"));
  const file = join(dir, "models.json");
  return { state: { config: loadModelConfig(file) }, file, dir };
}

describe("handleMappingsUpdate", () => {
  test("toggles enabled and persists", async () => {
    const { state, file, dir } = freshState();
    const res = handleMappingsUpdate(state, file, { enabled: true });
    expect(res.status).toBe(200);
    expect(state.config.mappingEnabled).toBe(true);
    expect(loadModelConfig(file).mappingEnabled).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("replaces mappings after validation; unknown target rejected", async () => {
    const { state, file, dir } = freshState();
    const bad = handleMappingsUpdate(state, file, { mappings: [{ from: "fable", to: "gpt-nonexistent" }] });
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as { error: { message: string } };
    expect(body.error.message).toContain("gpt-nonexistent");

    const good = handleMappingsUpdate(state, file, {
      mappings: [{ from: "fable", to: "gpt-5.6-terra", effort: { max: "xhigh" } }],
    });
    expect(good.status).toBe(200);
    expect(state.config.mappings.find((m) => m.from === "fable")!.to).toBe("gpt-5.6-terra");
    // Unlisted families fall back to defaults on the next load.
    expect(loadModelConfig(file).mappings.find((m) => m.from === "opus")!.to).toBe("gpt-5.6-terra");
    rmSync(dir, { recursive: true, force: true });
  });

  test("anthropic target is accepted (per-family Claude-only opt-out)", () => {
    const { state, file, dir } = freshState();
    const res = handleMappingsUpdate(state, file, { mappings: [{ from: "fable", to: "fable" }] });
    expect(res.status).toBe(200);
    rmSync(dir, { recursive: true, force: true });
  });

  test("invalid shapes rejected: unknown family, bad effort key/value, no fields", async () => {
    const { state, file, dir } = freshState();
    expect(handleMappingsUpdate(state, file, {}).status).toBe(400);
    expect(handleMappingsUpdate(state, file, { mappings: [{ from: "gpt", to: "gpt-5.5" }] }).status).toBe(400);
    expect(
      handleMappingsUpdate(state, file, { mappings: [{ from: "opus", to: "gpt-5.5", effort: { low: "ultra" } }] }).status,
    ).toBe(400);
    rmSync(dir, { recursive: true, force: true });
  });
});
