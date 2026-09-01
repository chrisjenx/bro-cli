import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { handleContextUpdate, modelsListing, routeForRequest, type MappingState } from "./server.ts";
import { DEFAULT_MODEL_TABLE, DEFAULT_MAPPINGS, CLAUDE_DEFAULT_CONTEXT, loadModelConfig, type ModelConfig } from "../models.ts";

function fixture(): { state: MappingState; file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "pool-ctxup-"));
  return {
    dir,
    file: join(dir, "models.json"),
    state: {
      config: {
        models: [...DEFAULT_MODEL_TABLE],
        mappingEnabled: true,
        mappings: DEFAULT_MAPPINGS,
        autoCompactWindow: null,
      } as ModelConfig,
    },
  };
}

describe("handleContextUpdate", () => {
  test("sets a per-model ceiling and persists it", async () => {
    const { state, file, dir } = fixture();
    const res = handleContextUpdate(
      state,
      file,
      { models: [{ id: "gpt-5.6-sol", maxContextWindow: 872_000 }] },
      500_000,
      null,
    );
    expect(res.status).toBe(200);
    expect(state.config.models.find((m) => m.id === "gpt-5.6-sol")!.maxContextWindow).toBe(872_000);
    expect(loadModelConfig(file).models.find((m) => m.id === "gpt-5.6-sol")!.maxContextWindow).toBe(872_000);
    await res.json();
    rmSync(dir, { recursive: true, force: true });
  });

  test("null clears a ceiling back to the bundled default", () => {
    const { state, file, dir } = fixture();
    handleContextUpdate(state, file, { models: [{ id: "gpt-5.6-terra", maxContextWindow: 300_000 }] }, 500_000, null);
    handleContextUpdate(state, file, { models: [{ id: "gpt-5.6-terra", maxContextWindow: null }] }, 500_000, null);
    expect(loadModelConfig(file).models.find((m) => m.id === "gpt-5.6-terra")!.maxContextWindow).toBe(872_000);
    rmSync(dir, { recursive: true, force: true });
  });

  test("sets and clears the session auto-compact window", () => {
    const { state, file, dir } = fixture();
    handleContextUpdate(state, file, { autoCompactWindow: 400_000 }, 500_000, null);
    expect(loadModelConfig(file).autoCompactWindow).toBe(400_000);
    handleContextUpdate(state, file, { autoCompactWindow: null }, 500_000, null);
    expect(loadModelConfig(file).autoCompactWindow).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("rejects an unknown model id without writing anything", () => {
    const { state, file, dir } = fixture();
    const res = handleContextUpdate(state, file, { models: [{ id: "nope", maxContextWindow: 1000 }] }, 500_000, null);
    expect(res.status).toBe(400);
    expect(state.config.models.some((m) => m.id === "nope")).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("rejects a non-positive or non-integer window", () => {
    const { state, file, dir } = fixture();
    for (const bad of [0, -1, 1.5, "800000"]) {
      const res = handleContextUpdate(
        state, file, { models: [{ id: "gpt-5.6-sol", maxContextWindow: bad }] }, 500_000, null,
      );
      expect(res.status).toBe(400);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("refuses to set the session window while POOL_AUTO_COMPACT_WINDOW is set", () => {
    const { state, file, dir } = fixture();
    const res = handleContextUpdate(state, file, { autoCompactWindow: 400_000 }, 500_000, 300_000);
    expect(res.status).toBe(409);
    expect(state.config.autoCompactWindow).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("an env lock still allows per-model ceiling edits", () => {
    const { state, file, dir } = fixture();
    const res = handleContextUpdate(
      state, file, { models: [{ id: "gpt-5.6-luna", maxContextWindow: 400_000 }] }, 500_000, 300_000,
    );
    expect(res.status).toBe(200);
    expect(state.config.models.find((m) => m.id === "gpt-5.6-luna")!.maxContextWindow).toBe(400_000);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an empty body is a no-op, not a wipe", () => {
    const { state, file, dir } = fixture();
    const res = handleContextUpdate(state, file, {}, 500_000, null);
    expect(res.status).toBe(200);
    expect(state.config.models.find((m) => m.id === "gpt-5.6-sol")!.maxContextWindow).toBe(872_000);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an env-locked request is atomic: a rejected window also rejects the model edits in the same payload", () => {
    const { state, file, dir } = fixture();
    const res = handleContextUpdate(
      state,
      file,
      {
        models: [{ id: "gpt-5.6-sol", maxContextWindow: 111_000 }],
        autoCompactWindow: 400_000,
      },
      500_000,
      300_000, // envOverride set -> autoCompactWindow is locked
    );
    expect(res.status).toBe(409);
    // The model edit in the SAME payload must NOT have applied either — this
    // handler validates the whole payload before committing anything, and a
    // rejected field must not let the rest of the payload commit around it.
    expect(state.config.models.find((m) => m.id === "gpt-5.6-sol")!.maxContextWindow).toBe(872_000);
    expect(state.config.autoCompactWindow).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("rejects a session window below Claude Code's accepted floor (100000)", () => {
    const { state, file, dir } = fixture();
    const res = handleContextUpdate(state, file, { autoCompactWindow: 99_999 }, 500_000, null);
    expect(res.status).toBe(400);
    expect(state.config.autoCompactWindow).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("rejects a session window above Claude Code's accepted ceiling (1000000)", () => {
    const { state, file, dir } = fixture();
    const res = handleContextUpdate(state, file, { autoCompactWindow: 1_000_001 }, 500_000, null);
    expect(res.status).toBe(400);
    expect(state.config.autoCompactWindow).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("accepts a session window at the boundaries and in range", () => {
    const { state, file, dir } = fixture();
    expect(handleContextUpdate(state, file, { autoCompactWindow: 100_000 }, 500_000, null).status).toBe(200);
    expect(state.config.autoCompactWindow).toBe(100_000);
    expect(handleContextUpdate(state, file, { autoCompactWindow: 1_000_000 }, 500_000, null).status).toBe(200);
    expect(state.config.autoCompactWindow).toBe(1_000_000);
    expect(handleContextUpdate(state, file, { autoCompactWindow: 400_000 }, 500_000, null).status).toBe(200);
    expect(state.config.autoCompactWindow).toBe(400_000);
    rmSync(dir, { recursive: true, force: true });
  });

  // handleContextUpdate REPLACES state.config.models rather than mutating it.
  // Anything that binds the array once (startServer used to keep a `modelTable`
  // const) diverges from the state the dashboard and /api/status report: the
  // save looked applied while /v1/models and the request-path guard kept the
  // pre-edit ceiling until the pool restarted.
  test("an edit is immediately visible to the /v1/models listing and the request path", async () => {
    const { state, file, dir } = fixture();
    // What startServer binds once, at startup.
    const snapshotTakenAtStartup = state.config.models;

    const res = handleContextUpdate(
      state, file, { models: [{ id: "gpt-5.6-sol", maxContextWindow: 111_000 }] }, 500_000, null,
    );
    expect(res.status).toBe(200);
    await res.json();

    // The listing endpoint reads the live table.
    const listed = (modelsListing(state, 500_000) as { data: { id: string; context_window: number }[] }).data;
    expect(listed.find((m) => m.id === "gpt-5.6-sol")!.context_window).toBe(111_000);

    // …and so does the route the inference handlers guard against.
    const route = routeForRequest(state.config.models, { model: "gpt-5.6-sol" });
    expect(route.maxContextWindow).toBe(111_000);

    // Proof the divergence is real: the startup snapshot still holds 872K, so
    // reading through it (the old `modelTable` binding) would have been stale.
    expect(snapshotTakenAtStartup.find((m) => m.id === "gpt-5.6-sol")!.maxContextWindow).toBe(872_000);
    expect(state.config.models).not.toBe(snapshotTakenAtStartup);

    rmSync(dir, { recursive: true, force: true });
  });

  // max_context_window is advisory, and normalizeModelRoute rejects non-positive
  // declarations today — but this was the last reader still on the raw `?? ??`
  // chain while context_window had been routed through usableWindow(). A rule
  // with one holdout reader is the inconsistency the rule was written to remove,
  // so pin both fields to the same answer.
  test("a zero declared ceiling reads as absent in the listing, not as a window of 0", () => {
    const { state, dir } = fixture();
    state.config.models = [
      { id: "gpt-5.6-zero", provider: "openai", upstreamModel: "gpt-5.6-zero", maxContextWindow: 0, contextWindow: 0 },
      ...state.config.models.filter((m) => m.id !== "gpt-5.6-zero"),
    ];
    const listed = (
      modelsListing(state, 500_000) as {
        data: { id: string; context_window: number; max_context_window: number }[];
      }
    ).data;
    const row = listed.find((m) => m.id === "gpt-5.6-zero")!;
    expect(row.max_context_window).toBe(CLAUDE_DEFAULT_CONTEXT);
    expect(row.context_window).toBe(CLAUDE_DEFAULT_CONTEXT);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a per-model ceiling is not bound by the session-window range (upstream ceilings legitimately exceed it)", () => {
    const { state, file, dir } = fixture();
    const res = handleContextUpdate(
      state, file, { models: [{ id: "gpt-5.6-sol", maxContextWindow: 872_000 }] }, 500_000, null,
    );
    expect(res.status).toBe(200);
    expect(state.config.models.find((m) => m.id === "gpt-5.6-sol")!.maxContextWindow).toBe(872_000);
    rmSync(dir, { recursive: true, force: true });
  });

  // clampContextWindow always raises the derived session window UP to
  // CLAUDE_MIN_AUTO_COMPACT, so a per-model ceiling below that can never be
  // honoured: Claude Code would compact at CLAUDE_MIN_AUTO_COMPACT while this
  // model's own guard rejects it below that number — every request in the gap
  // fails hard instead of compacting. Refuse it here, atomically with the rest
  // of the payload.
  test("rejects a sub-floor per-model ceiling, leaving state.config completely untouched", () => {
    const { state, file, dir } = fixture();
    const res = handleContextUpdate(
      state,
      file,
      {
        models: [
          { id: "gpt-5.6-sol", maxContextWindow: 60_000 },
          { id: "gpt-5.6-terra", maxContextWindow: 400_000 }, // same payload, otherwise-valid edit
        ],
      },
      500_000,
      null,
    );
    expect(res.status).toBe(400);
    // Neither edit in the payload committed — the atomic contract.
    expect(state.config.models.find((m) => m.id === "gpt-5.6-sol")!.maxContextWindow).toBe(872_000);
    expect(state.config.models.find((m) => m.id === "gpt-5.6-terra")!.maxContextWindow).toBe(872_000);
    rmSync(dir, { recursive: true, force: true });
  });

  test("accepts a per-model ceiling exactly at the floor, and a large ceiling above it", () => {
    const { state, file, dir } = fixture();
    const res1 = handleContextUpdate(
      state, file, { models: [{ id: "gpt-5.6-sol", maxContextWindow: 100_000 }] }, 500_000, null,
    );
    expect(res1.status).toBe(200);
    expect(state.config.models.find((m) => m.id === "gpt-5.6-sol")!.maxContextWindow).toBe(100_000);

    const res2 = handleContextUpdate(
      state, file, { models: [{ id: "gpt-5.6-terra", maxContextWindow: 872_000 }] }, 500_000, null,
    );
    expect(res2.status).toBe(200);
    expect(state.config.models.find((m) => m.id === "gpt-5.6-terra")!.maxContextWindow).toBe(872_000);
    rmSync(dir, { recursive: true, force: true });
  });

  test("null still clears a per-model ceiling back to the bundled default even with the floor rule in place", () => {
    const { state, file, dir } = fixture();
    handleContextUpdate(state, file, { models: [{ id: "gpt-5.6-luna", maxContextWindow: 300_000 }] }, 500_000, null);
    const res = handleContextUpdate(state, file, { models: [{ id: "gpt-5.6-luna", maxContextWindow: null }] }, 500_000, null);
    expect(res.status).toBe(200);
    expect(loadModelConfig(file).models.find((m) => m.id === "gpt-5.6-luna")!.maxContextWindow).toBe(872_000);
    rmSync(dir, { recursive: true, force: true });
  });
});
