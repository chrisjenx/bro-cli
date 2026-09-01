import { describe, expect, test } from "bun:test";
import { DEFAULT_MODEL_TABLE, DEFAULT_MAPPINGS, buildContextStatus, type ModelConfig } from "../models.ts";

const cfg: ModelConfig = {
  models: DEFAULT_MODEL_TABLE,
  mappingEnabled: true,
  mappings: DEFAULT_MAPPINGS,
  autoCompactWindow: null,
};

describe("context status payload", () => {
  test("reports the cap, the session window and every mapped family", () => {
    const got = buildContextStatus(cfg, 500_000);
    expect(got.cap).toBe(500_000);
    expect(got.sessionWindow).toBe(272_000);
    expect(got.source).toBe("derived");
    expect(got.envLocked).toBe(false);
    expect(got.families).toContainEqual({ family: "sonnet", target: "gpt-5.6-luna", window: 500_000 });
    expect(got.families).toContainEqual({ family: "haiku", target: "gpt-5.4-mini", window: 272_000 });
  });

  test("mapping off reports no session window and no families", () => {
    const got = buildContextStatus({ ...cfg, mappingEnabled: false }, 500_000);
    expect(got.sessionWindow).toBeNull();
    expect(got.families).toEqual([]);
    expect(got.cap).toBe(500_000);
  });

  test("a persisted override is reported as settings-sourced and still editable", () => {
    const got = buildContextStatus({ ...cfg, autoCompactWindow: 400_000 }, 500_000);
    expect(got.sessionWindow).toBe(400_000);
    expect(got.source).toBe("settings");
    expect(got.envLocked).toBe(false);
  });

  test("an env override is reported as env-locked so the dashboard can disable the field", () => {
    const got = buildContextStatus(cfg, 500_000, 300_000);
    expect(got.sessionWindow).toBe(300_000);
    expect(got.source).toBe("env");
    expect(got.envLocked).toBe(true);
  });

  test("every openai model is listed with its editable ceiling", () => {
    const got = buildContextStatus(cfg, 500_000);
    expect(got.models).toContainEqual({
      id: "gpt-5.6-sol",
      ceiling: 872_000,
      window: 500_000,
      capped: true,
    });
    expect(got.models).toContainEqual({
      id: "gpt-5.4-mini",
      ceiling: 272_000,
      window: 272_000,
      capped: false,
    });
    expect(got.models.some((m) => m.id === "sonnet")).toBe(false);
  });
});
