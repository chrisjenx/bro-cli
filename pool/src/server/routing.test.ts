import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { routeForRequest, openAIEndpointModelError, nonOauthOpenAIBackendError, handleRoutingUpdate } from "./server.ts";
import { DEFAULT_MODEL_TABLE } from "../models.ts";
import { loadConfig } from "../config.ts";
import { AccountManager } from "../accounts/manager.ts";

describe("routeForRequest", () => {
  test("claude and unknown models route anthropic; gpt models route openai", () => {
    expect(routeForRequest(DEFAULT_MODEL_TABLE, { model: "claude-sonnet-5" }).provider).toBe("anthropic");
    expect(routeForRequest(DEFAULT_MODEL_TABLE, { model: "whatever-new" }).provider).toBe("anthropic");
    expect(routeForRequest(DEFAULT_MODEL_TABLE, {}).provider).toBe("anthropic");
    expect(routeForRequest(DEFAULT_MODEL_TABLE, { model: "gpt-5.5" }).provider).toBe("openai");
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
    const route = routeForRequest(DEFAULT_MODEL_TABLE, { model: "gpt-5.5" });
    const res = openAIEndpointModelError(route, "gpt-5.5");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as { error: { message: string; type: string; code: string } };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("model_not_supported_on_this_endpoint");
    expect(body.error.message).toContain("gpt-5.5");
    expect(body.error.message).toContain("/v1/messages");
  });
});

// FIX 3: on the `cli` backend, /v1/messages must reject openai-routed models
// instead of misrouting them to a Claude account/CLI subprocess. Only the
// `oauth` backend can reach Codex.
describe("nonOauthOpenAIBackendError", () => {
  test("returns null when backend is oauth, regardless of provider", () => {
    const openaiRoute = routeForRequest(DEFAULT_MODEL_TABLE, { model: "gpt-5.5" });
    const claudeRoute = routeForRequest(DEFAULT_MODEL_TABLE, { model: "sonnet" });
    expect(nonOauthOpenAIBackendError(openaiRoute, "oauth")).toBeNull();
    expect(nonOauthOpenAIBackendError(claudeRoute, "oauth")).toBeNull();
  });

  test("returns null for anthropic-routed models on the cli backend", () => {
    const claudeRoute = routeForRequest(DEFAULT_MODEL_TABLE, { model: "sonnet" });
    expect(nonOauthOpenAIBackendError(claudeRoute, "cli")).toBeNull();
  });

  test("returns a 400 anthropic-shaped error naming the model for openai-routed models on the cli backend", async () => {
    const openaiRoute = routeForRequest(DEFAULT_MODEL_TABLE, { model: "gpt-5.5" });
    const res = nonOauthOpenAIBackendError(openaiRoute, "cli");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as { type: string; error: { type: string; message: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("gpt-5.5");
    expect(body.error.message).toContain("oauth");
  });
});

// ---- handleRoutingUpdate tests (weight + priority) ----

function tempMgr(names: string[]): { poolDir: string; mgr: AccountManager } {
  const poolDir = mkdtempSync(join(tmpdir(), "cmp-routing-api-"));
  const accountsDir = join(poolDir, "accounts");
  for (const name of names) {
    mkdirSync(join(accountsDir, name), { recursive: true });
    writeFileSync(
      join(accountsDir, name, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: Date.now() + 3_600_000 } }),
    );
  }
  const config = loadConfig({
    poolDir, accountsDir,
    usageFile: join(poolDir, "usage.json"),
    sessionsFile: join(poolDir, "sessions.json"),
  });
  return { poolDir, mgr: new AccountManager(config) };
}

test("handleRoutingUpdate sets weight and echoes both persisted values", async () => {
  const { poolDir, mgr } = tempMgr(["a"]);
  try {
    const res = handleRoutingUpdate(mgr, { account: "a", weight: 2.5 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, account: "a", priority: 100, weight: 2.5 });
    expect(mgr.weightFor("a")).toBe(2.5);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("handleRoutingUpdate sets priority and weight together", async () => {
  const { poolDir, mgr } = tempMgr(["a"]);
  try {
    const res = handleRoutingUpdate(mgr, { account: "a", priority: 2, weight: 0.5 });
    expect(res.status).toBe(200);
    expect(mgr.priorityFor("a")).toBe(2);
    expect(mgr.weightFor("a")).toBe(0.5);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("handleRoutingUpdate rejects out-of-range weight and missing fields", () => {
  const { poolDir, mgr } = tempMgr(["a"]);
  try {
    expect(handleRoutingUpdate(mgr, { account: "a", weight: 99 }).status).toBe(400);
    expect(handleRoutingUpdate(mgr, { account: "a", weight: "2" }).status).toBe(400);
    expect(handleRoutingUpdate(mgr, { account: "a" }).status).toBe(400);
    expect(handleRoutingUpdate(mgr, { account: "nope", weight: 1 }).status).toBe(400);
    expect(mgr.weightFor("a")).toBe(1); // nothing persisted
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});
