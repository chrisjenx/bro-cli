import { describe, expect, test } from "bun:test";
import { routeForRequest } from "./server.ts";
import { DEFAULT_MODEL_TABLE } from "../models.ts";

describe("routeForRequest", () => {
  test("claude and unknown models route anthropic; gpt models route openai", () => {
    expect(routeForRequest(DEFAULT_MODEL_TABLE, { model: "claude-sonnet-5" }).provider).toBe("anthropic");
    expect(routeForRequest(DEFAULT_MODEL_TABLE, { model: "whatever-new" }).provider).toBe("anthropic");
    expect(routeForRequest(DEFAULT_MODEL_TABLE, {}).provider).toBe("anthropic");
    expect(routeForRequest(DEFAULT_MODEL_TABLE, { model: "gpt-5.2-codex" }).provider).toBe("openai");
  });
});
