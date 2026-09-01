import { describe, expect, test } from "bun:test";
import { estimateInputTokens, contextOverflowMessage, checkContextWindow } from "./context-guard.ts";
import {
  resolveModel,
  mappingFor,
  effectiveContextWindow,
  DEFAULT_MODEL_TABLE,
  DEFAULT_MAPPINGS,
  type ModelConfig,
} from "../models.ts";

const sol = resolveModel(DEFAULT_MODEL_TABLE, "gpt-5.6-sol");

const mappedConfig: ModelConfig = {
  models: DEFAULT_MODEL_TABLE,
  mappingEnabled: true,
  mappings: DEFAULT_MAPPINGS,
  autoCompactWindow: null,
};

describe("estimateInputTokens", () => {
  test("counts system, string content and block content", () => {
    const body = {
      system: "abcd",
      messages: [
        { role: "user", content: "efgh" },
        { role: "assistant", content: [{ type: "text", text: "ijkl" }] },
      ],
    };
    // 12 chars / 4 chars-per-token = 3
    expect(estimateInputTokens(body)).toBe(3);
  });

  test("a malformed body estimates zero rather than throwing", () => {
    expect(estimateInputTokens(null)).toBe(0);
    expect(estimateInputTokens({ messages: "nope" })).toBe(0);
  });

  test("counts a tool_result block with string content", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "abcdefgh" }],
        },
      ],
    };
    // 8 chars / 4 = 2
    expect(estimateInputTokens(body)).toBe(2);
  });

  test("counts a tool_result block with array-of-text-blocks content", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [{ type: "text", text: "abcd" }, { type: "text", text: "efgh" }],
            },
          ],
        },
      ],
    };
    // 8 chars / 4 = 2
    expect(estimateInputTokens(body)).toBe(2);
  });

  test("a tool_result block with malformed content contributes zero and does not throw", () => {
    const numberContent = {
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: 42 }] }],
    };
    const nullContent = {
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: null }] }],
    };
    const objectContent = {
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: { odd: "shape" } }] },
      ],
    };
    expect(estimateInputTokens(numberContent)).toBe(0);
    expect(estimateInputTokens(nullContent)).toBe(0);
    expect(estimateInputTokens(objectContent)).toBe(0);
  });
});

describe("checkContextWindow", () => {
  test("passes a request that fits", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    expect(checkContextWindow(body, sol, 500_000)).toBeNull();
  });

  test("rejects a request past the effective window, naming model and window", () => {
    const body = { messages: [{ role: "user", content: "x".repeat(2_400_000) }] };
    const msg = checkContextWindow(body, sol, 500_000);
    expect(msg).toContain("gpt-5.6-sol");
    expect(msg).toContain("500,000");
    expect(msg).toContain("600,000");
  });

  test("the cap, not just the upstream ceiling, is what binds", () => {
    // 600K estimate fits sol's 872K ceiling but not a 500K house cap.
    const body = { messages: [{ role: "user", content: "x".repeat(2_400_000) }] };
    expect(checkContextWindow(body, sol, 1_000_000)).toBeNull();
  });
});

// The guard's real production input is a MAPPED route (handleAnthropic hands
// mappingFor's result to proxyCodexMessages), not a resolveModel one. Testing
// only resolveModel routes above is exactly how a mappingFor that dropped
// contextWindow/maxContextWindow reached main: every mapped request was silently
// guarded at Claude Code's 200K default instead of the target's real ceiling.
describe("checkContextWindow on a mapped route", () => {
  test("a mapped route carries its target's window, not the 200K fallback", () => {
    const mapped = mappingFor(mappedConfig, "claude-sonnet-5");
    expect(mapped).not.toBeNull();
    expect(mapped!.upstreamModel).toBe("gpt-5.6-luna");
    expect(mapped!.contextWindow).toBe(272_000);
    expect(mapped!.maxContextWindow).toBe(872_000);
    expect(effectiveContextWindow(mapped!, 500_000)).toBe(500_000);
  });

  test("a ~250K-token request on a mapped route is not rejected", () => {
    // 1,000,000 chars / 4 = 250,000 tokens: over Claude Code's 200K default,
    // well inside gpt-5.6-luna's 872K ceiling held at the 500K house cap.
    const body = { messages: [{ role: "user", content: "x".repeat(1_000_000) }] };
    const mapped = mappingFor(mappedConfig, "claude-sonnet-5")!;
    expect(estimateInputTokens(body)).toBe(250_000);
    expect(checkContextWindow(body, mapped, 500_000)).toBeNull();
  });

  test("a mapped route still rejects past its own ceiling, naming the upstream model", () => {
    const body = { messages: [{ role: "user", content: "x".repeat(2_400_000) }] };
    const mapped = mappingFor(mappedConfig, "claude-sonnet-5")!;
    const msg = checkContextWindow(body, mapped, 500_000);
    expect(msg).toContain("gpt-5.6-luna");
    expect(msg).toContain("500,000");
  });

  test("a mapped route to a narrower target keeps that target's smaller ceiling", () => {
    // haiku → gpt-5.4-mini, whose 272K ceiling binds below the 500K cap.
    const mapped = mappingFor(mappedConfig, "claude-haiku-4-5")!;
    expect(mapped.upstreamModel).toBe("gpt-5.4-mini");
    expect(effectiveContextWindow(mapped, 500_000)).toBe(272_000);
  });
});

describe("contextOverflowMessage", () => {
  test("names the knob that changes the limit", () => {
    expect(contextOverflowMessage("gpt-5.6-luna", 600_000, 272_000)).toContain("POOL_MAX_CONTEXT");
  });
});
