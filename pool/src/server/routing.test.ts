import { describe, expect, test } from "bun:test";
import { routeForRequest, openAIEndpointModelError, nonOauthOpenAIBackendError } from "./server.ts";
import { DEFAULT_MODEL_TABLE } from "../models.ts";

describe("routeForRequest", () => {
  test("claude and unknown models route anthropic; gpt models route openai", () => {
    expect(routeForRequest(DEFAULT_MODEL_TABLE, { model: "claude-sonnet-5" }).provider).toBe("anthropic");
    expect(routeForRequest(DEFAULT_MODEL_TABLE, { model: "whatever-new" }).provider).toBe("anthropic");
    expect(routeForRequest(DEFAULT_MODEL_TABLE, {}).provider).toBe("anthropic");
    expect(routeForRequest(DEFAULT_MODEL_TABLE, { model: "gpt-5.2-codex" }).provider).toBe("openai");
  });
});

// FIX 1: /v1/chat/completions must reject openai-routed models instead of
// silently misrouting them to the Claude CLI (the OpenAI-compat path flattens
// tool structure and can't drive Codex).
describe("openAIEndpointModelError", () => {
  test("returns null (allow) for anthropic-routed models", () => {
    const route = routeForRequest(DEFAULT_MODEL_TABLE, { model: "sonnet" });
    expect(openAIEndpointModelError(route, "sonnet")).toBeNull();
  });

  test("returns a 400 invalid_request_error naming the model for openai-routed models", async () => {
    const route = routeForRequest(DEFAULT_MODEL_TABLE, { model: "gpt-5.2-codex" });
    const res = openAIEndpointModelError(route, "gpt-5.2-codex");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as { error: { message: string; type: string; code: string } };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("model_not_supported_on_this_endpoint");
    expect(body.error.message).toContain("gpt-5.2-codex");
    expect(body.error.message).toContain("/v1/messages");
  });
});

// FIX 3: on the `cli` backend, /v1/messages must reject openai-routed models
// instead of misrouting them to a Claude account/CLI subprocess. Only the
// `oauth` backend can reach Codex.
describe("nonOauthOpenAIBackendError", () => {
  test("returns null when backend is oauth, regardless of provider", () => {
    const openaiRoute = routeForRequest(DEFAULT_MODEL_TABLE, { model: "gpt-5.2-codex" });
    const claudeRoute = routeForRequest(DEFAULT_MODEL_TABLE, { model: "sonnet" });
    expect(nonOauthOpenAIBackendError(openaiRoute, "oauth")).toBeNull();
    expect(nonOauthOpenAIBackendError(claudeRoute, "oauth")).toBeNull();
  });

  test("returns null for anthropic-routed models on the cli backend", () => {
    const claudeRoute = routeForRequest(DEFAULT_MODEL_TABLE, { model: "sonnet" });
    expect(nonOauthOpenAIBackendError(claudeRoute, "cli")).toBeNull();
  });

  test("returns a 400 anthropic-shaped error naming the model for openai-routed models on the cli backend", async () => {
    const openaiRoute = routeForRequest(DEFAULT_MODEL_TABLE, { model: "gpt-5.2-codex" });
    const res = nonOauthOpenAIBackendError(openaiRoute, "cli");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as { type: string; error: { type: string; message: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("gpt-5.2-codex");
    expect(body.error.message).toContain("oauth");
  });
});
