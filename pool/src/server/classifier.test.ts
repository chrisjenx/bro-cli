import { describe, expect, test } from "bun:test";
import { loadConfig } from "../config.ts";
import { mappingFor, type ModelConfig } from "../models.ts";
import {
  AUTO_MODE_CLASSIFIER_MARKER,
  CLASSIFIER_MAX_TOKENS,
  bypassMappingForClassifier,
  classifierShapeMatches,
  isAutoModeClassifierRequest,
} from "./classifier.ts";

/**
 * Shape captured on the wire from Claude Code 2.1.263 auto mode: the
 * classifier is a non-streaming, tool-less, tiny-max_tokens Sonnet request
 * whose system prompt (after the billing block) opens with the marker.
 */
function classifierBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "claude-sonnet-5",
    max_tokens: 64,
    system: [
      { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.263.294; cc_entrypoint=sdk-cli;" },
      { type: "text", text: `${AUTO_MODE_CLASSIFIER_MARKER}.\n\n## Context\n\nThe agent you are monitoring...` },
      { type: "text", text: "\n\n## Session Context\n\n- **User identity**: `someone`." },
    ],
    messages: [
      { role: "user", content: "<transcript>...</transcript>" },
      { role: "assistant", content: "{" },
    ],
    ...overrides,
  };
}

describe("isAutoModeClassifierRequest", () => {
  test("recognises the captured classifier shape", () => {
    expect(isAutoModeClassifierRequest(classifierBody())).toBe(true);
  });

  test("accepts a string system prompt that opens with the marker", () => {
    expect(isAutoModeClassifierRequest(classifierBody({ system: `${AUTO_MODE_CLASSIFIER_MARKER}. Rules...` }))).toBe(true);
  });

  test("accepts the marker in the first system block when no billing block precedes it", () => {
    const system = [{ type: "text", text: `${AUTO_MODE_CLASSIFIER_MARKER}.` }];
    expect(isAutoModeClassifierRequest(classifierBody({ system }))).toBe(true);
  });

  test("rejects when no system block carries the marker", () => {
    const system = [{ type: "text", text: "You are a Claude agent, built on Claude Code." }];
    expect(isAutoModeClassifierRequest(classifierBody({ system }))).toBe(false);
  });

  test("rejects when the marker only appears in a user message", () => {
    const system = [{ type: "text", text: "You are a Claude agent." }];
    const messages = [{ role: "user", content: `Please quote: ${AUTO_MODE_CLASSIFIER_MARKER}` }];
    expect(isAutoModeClassifierRequest(classifierBody({ system, messages }))).toBe(false);
  });

  test("rejects streaming requests", () => {
    expect(isAutoModeClassifierRequest(classifierBody({ stream: true }))).toBe(false);
  });

  test("rejects requests that carry tools", () => {
    const tools = [{ name: "Bash", description: "run", input_schema: { type: "object" } }];
    expect(isAutoModeClassifierRequest(classifierBody({ tools }))).toBe(false);
  });

  test("rejects requests with a large max_tokens budget", () => {
    expect(isAutoModeClassifierRequest(classifierBody({ max_tokens: CLASSIFIER_MAX_TOKENS + 1 }))).toBe(false);
    expect(isAutoModeClassifierRequest(classifierBody({ max_tokens: 4096 }))).toBe(false);
  });

  test("rejects non-object bodies", () => {
    expect(isAutoModeClassifierRequest(null)).toBe(false);
    expect(isAutoModeClassifierRequest("nope")).toBe(false);
  });
});

describe("bypassMappingForClassifier", () => {
  const mappingConfig: ModelConfig = {
    mappingEnabled: true,
    mappings: [{ from: "sonnet", to: "gpt-5.6-terra" }],
    models: [{ id: "gpt-5.6-terra", provider: "openai", model: "gpt-5.6-terra" }],
  } as unknown as ModelConfig;

  const normalSonnet = () =>
    classifierBody({
      stream: true,
      max_tokens: 64000,
      tools: [{ name: "Bash", description: "run", input_schema: { type: "object" } }],
      system: [{ type: "text", text: "You are a Claude agent, built on Claude Code." }],
    });

  test("bypasses when configured for anthropic and the body is a classifier request", () => {
    const config = loadConfig({ classifierRoute: "anthropic" });
    expect(bypassMappingForClassifier(config, classifierBody())).toBe(true);
    expect(bypassMappingForClassifier(config, normalSonnet())).toBe(false);
  });

  test("never bypasses when configured for default routing", () => {
    const config = loadConfig({ classifierRoute: "default" });
    expect(bypassMappingForClassifier(config, classifierBody())).toBe(false);
    expect(bypassMappingForClassifier(config, normalSonnet())).toBe(false);
  });

  test("ordinary Sonnet requests still resolve through the mapping to the openai route", () => {
    const mapped = mappingFor(mappingConfig, "claude-sonnet-5");
    expect(mapped?.provider).toBe("openai");
    expect(mapped?.id).toBe("claude-sonnet-5");
  });
});

describe("CLASSIFIER_ROUTE config", () => {
  const original = process.env.CLASSIFIER_ROUTE;
  const restore = () => {
    if (original === undefined) delete process.env.CLASSIFIER_ROUTE;
    else process.env.CLASSIFIER_ROUTE = original;
  };

  test("defaults to anthropic, honours default, ignores junk", () => {
    try {
      delete process.env.CLASSIFIER_ROUTE;
      expect(loadConfig().classifierRoute).toBe("anthropic");
      process.env.CLASSIFIER_ROUTE = "default";
      expect(loadConfig().classifierRoute).toBe("default");
      process.env.CLASSIFIER_ROUTE = "DEFAULT";
      expect(loadConfig().classifierRoute).toBe("default");
      process.env.CLASSIFIER_ROUTE = "banana";
      expect(loadConfig().classifierRoute).toBe("anthropic");
    } finally {
      restore();
    }
  });
});

describe("classifierShapeMatches (marker-drift diagnostic)", () => {
  test("true for the classifier shape even when the marker is absent", () => {
    const system = [{ type: "text", text: "You are a safety reviewer for coding agents." }];
    expect(classifierShapeMatches(classifierBody({ system }))).toBe(true);
    expect(isAutoModeClassifierRequest(classifierBody({ system }))).toBe(false);
  });

  test("false for streaming, tool-carrying, or large-budget requests", () => {
    expect(classifierShapeMatches(classifierBody({ stream: true }))).toBe(false);
    expect(classifierShapeMatches(classifierBody({ tools: [{ name: "Bash" }] }))).toBe(false);
    expect(classifierShapeMatches(classifierBody({ max_tokens: 4096 }))).toBe(false);
  });
});
