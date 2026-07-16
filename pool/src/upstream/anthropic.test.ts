import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadConfig, type Config } from "../config.ts";
import { AccountManager } from "../accounts/manager.ts";
import { proxyAnthropicMessages } from "./anthropic.ts";

interface FetchCall {
  url: string;
  init: RequestInit;
  body: unknown;
  headers: Headers;
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function tempPool(accountNames: string[]): { poolDir: string; mgr: AccountManager; config: Config } {
  const poolDir = mkdtempSync(join(tmpdir(), "cmp-upstream-"));
  const accountsDir = join(poolDir, "accounts");
  for (const name of accountNames) {
    const dir = join(accountsDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, ".credentials.json"),
      JSON.stringify(
        {
          claudeAiOauth: {
            accessToken: "tok-" + name,
            refreshToken: "refresh-" + name,
            expiresAt: Date.now() + 3_600_000,
            scopes: ["user:inference", "user:sessions:claude_code"],
            subscriptionType: "max",
            rateLimitTier: "default_claude_max_5x",
          },
        },
        null,
        2,
      ),
    );
  }
  const config = loadConfig({
    poolDir,
    accountsDir,
    usageFile: join(poolDir, "usage.json"),
    sessionsFile: join(poolDir, "sessions.json"),
    anthropicApiBaseUrl: "https://api.test",
    oauthTokenUrl: "https://oauth.test/token",
    requestTimeoutMs: 30_000,
    usageRefreshEnabled: false,
  });
  return { poolDir, mgr: new AccountManager(config), config };
}

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.toString() : String(input);
    const requestInit = init ?? {};
    const headers = new Headers(requestInit.headers);
    const body = requestInit.body ? JSON.parse(String(requestInit.body)) : null;
    calls.push({ url, init: requestInit, headers, body });
    return handler(url, requestInit);
  }) as typeof fetch;
  return calls;
}

function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function sseResponse(text: string, status = 200): Response {
  return new Response(text, {
    status,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

async function drain(response: Response): Promise<string> {
  return await response.text();
}

test("forwards Anthropic messages verbatim with the selected account OAuth token", async () => {
  const { poolDir, mgr, config } = tempPool(["a"]);
  try {
    const calls = mockFetch(() =>
      jsonResponse({
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 11, output_tokens: 3 },
      }),
    );

    const body = {
      model: "claude-sonnet-5",
      max_tokens: 32,
      system: "system prompt",
      tools: [{ name: "lookup", input_schema: { type: "object" } }],
      thinking: { type: "enabled", budget_tokens: 1024 },
      messages: [{ role: "user", content: "hello" }],
      metadata: { user_id: "session-1" },
    };

    const response = await proxyAnthropicMessages(
      body,
      new Headers({
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "fine-grained-tool-streaming-2025-05-14,oauth-2025-04-20",
        "content-type": "application/json",
        "user-agent": "claude-code-test-harness",
        "x-app": "cli",
        "x-api-key": "local-proxy-key",
        host: "127.0.0.1:3456",
      }),
      mgr,
      config,
      new AbortController().signal,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Pool-Account")).toBe("a");
    expect(await response.json()).toMatchObject({ id: "msg_1" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.test/v1/messages");
    expect(calls[0]!.body).toEqual(body);
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer tok-a");
    expect(calls[0]!.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(calls[0]!.headers.get("anthropic-beta")).toBe(
      "fine-grained-tool-streaming-2025-05-14,oauth-2025-04-20",
    );
    expect(calls[0]!.headers.get("content-type")).toBe("application/json");
    expect(calls[0]!.headers.get("user-agent")).toBe("claude-code-test-harness");
    expect(calls[0]!.headers.get("x-app")).toBe("cli");
    expect(calls[0]!.headers.has("x-api-key")).toBe(false);
    expect(calls[0]!.headers.has("host")).toBe(false);
    expect(mgr.getAccount("a").usage.totalRequests).toBe(1);
    expect(mgr.getAccount("a").usage.totalInputTokens).toBe(11);
    expect(mgr.getAccount("a").usage.totalOutputTokens).toBe(3);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("refreshes an expired access token and persists rotated credentials", async () => {
  const { poolDir, mgr, config } = tempPool(["a"]);
  try {
    const credsPath = join(poolDir, "accounts", "a", ".credentials.json");
    const creds = JSON.parse(readFileSync(credsPath, "utf8")) as Record<string, any>;
    creds.claudeAiOauth.expiresAt = Date.now() - 1_000;
    writeFileSync(credsPath, JSON.stringify(creds, null, 2));

    const calls = mockFetch((url) => {
      if (url === "https://oauth.test/token") {
        return jsonResponse({
          access_token: "tok-rotated",
          refresh_token: "refresh-rotated",
          expires_in: 7200,
          scope: "user:inference user:sessions:claude_code",
        });
      }
      return jsonResponse({
        type: "message",
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [],
      });
    });

    const response = await proxyAnthropicMessages(
      { model: "claude-sonnet-5", max_tokens: 1, messages: [{ role: "user", content: "hi" }] },
      new Headers(),
      mgr,
      config,
      new AbortController().signal,
    );

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("https://oauth.test/token");
    expect(calls[0]!.body).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "refresh-a",
      client_id: config.oauthClientId,
    });
    expect(calls[1]!.headers.get("authorization")).toBe("Bearer tok-rotated");

    const updated = JSON.parse(readFileSync(credsPath, "utf8")) as Record<string, any>;
    expect(updated.claudeAiOauth.accessToken).toBe("tok-rotated");
    expect(updated.claudeAiOauth.refreshToken).toBe("refresh-rotated");
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("token refresh call times out instead of hanging forever on a stalled OAuth endpoint", async () => {
  const { poolDir, mgr, config } = tempPool(["a"]);
  try {
    const credsPath = join(poolDir, "accounts", "a", ".credentials.json");
    const creds = JSON.parse(readFileSync(credsPath, "utf8")) as Record<string, any>;
    creds.claudeAiOauth.expiresAt = Date.now() - 1_000;
    writeFileSync(credsPath, JSON.stringify(creds, null, 2));

    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://oauth.test/token") {
        // Simulate a stalled token endpoint: never resolves on its own, only
        // rejects when the caller's AbortSignal.timeout() actually fires.
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation timed out.", "TimeoutError"));
          });
        });
      }
      return Promise.resolve(jsonResponse({ type: "message", usage: {}, content: [] }));
    }) as typeof fetch;

    const response = await proxyAnthropicMessages(
      { model: "claude-sonnet-5", max_tokens: 1, messages: [{ role: "user", content: "hi" }] },
      new Headers(),
      mgr,
      { ...config, tokenRefreshTimeoutMs: 30 },
      new AbortController().signal,
    );

    const text = await response.text();
    expect(text).toContain("timed out");
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("fails over to another account on a start-of-request rate limit", async () => {
  const { poolDir, mgr, config } = tempPool(["a", "b"]);
  try {
    const failovers: string[] = [];
    const calls = mockFetch((_, init) => {
      const token = new Headers(init.headers).get("authorization");
      if (token === "Bearer tok-a") {
        return jsonResponse(
          { type: "error", error: { type: "rate_limit_error", message: "usage limit reached" } },
          429,
        );
      }
      return jsonResponse({
        type: "message",
        content: [{ type: "text", text: "served by b" }],
        usage: { input_tokens: 2, output_tokens: 4 },
      });
    });

    const response = await proxyAnthropicMessages(
      { model: "claude-sonnet-5", max_tokens: 8, messages: [{ role: "user", content: "hi" }] },
      new Headers(),
      mgr,
      config,
      new AbortController().signal,
      { onFailover: (from, to) => failovers.push(`${from}->${to}`) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Pool-Account")).toBe("b");
    expect(calls.map((c) => c.headers.get("authorization"))).toEqual(["Bearer tok-a", "Bearer tok-b"]);
    expect(failovers).toEqual(["a->b"]);
    expect(mgr.getAccount("a").available).toBe(false);
    expect(mgr.getAccount("b").usage.totalRequests).toBe(1);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("captures Anthropic's unified rate-limit headers into the account's live snapshot", async () => {
  const { poolDir, mgr, config } = tempPool(["a"]);
  try {
    const resetSec = Math.floor(Date.now() / 1000) + 3600;
    mockFetch(() =>
      jsonResponse(
        {
          type: "message",
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        200,
        {
          "anthropic-ratelimit-unified-status": "allowed",
          "anthropic-ratelimit-unified-5h-status": "allowed",
          "anthropic-ratelimit-unified-5h-utilization": "0.06",
          "anthropic-ratelimit-unified-5h-reset": String(resetSec),
          "anthropic-ratelimit-unified-7d-status": "allowed",
          "anthropic-ratelimit-unified-7d-utilization": "0.17",
          "anthropic-ratelimit-unified-7d-reset": String(resetSec + 1000),
        },
      ),
    );

    await proxyAnthropicMessages(
      { model: "claude-sonnet-5", max_tokens: 8, messages: [{ role: "user", content: "hi" }] },
      new Headers(),
      mgr,
      config,
      new AbortController().signal,
    );

    const rl = mgr.getAccount("a").usage.rateLimitStatus;
    expect(rl).not.toBeNull();
    expect(rl?.unifiedStatus).toBe("allowed");
    const fiveHour = rl?.windows.find((w) => w.key === "5h");
    const sevenDay = rl?.windows.find((w) => w.key === "7d");
    expect(fiveHour?.model).toBeNull();
    expect(fiveHour?.utilization).toBeCloseTo(0.06);
    expect(fiveHour?.reset).toBe(resetSec * 1000);
    expect(sevenDay?.utilization).toBeCloseTo(0.17);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("sidelines an account proactively once a unified window is fully consumed", async () => {
  const { poolDir, mgr, config } = tempPool(["a", "b"]);
  try {
    const resetSec = Math.floor(Date.now() / 1000) + 3600;
    mockFetch((_, init) => {
      const token = new Headers(init.headers).get("authorization");
      if (token === "Bearer tok-a") {
        return jsonResponse(
          { type: "message", content: [], usage: { input_tokens: 1, output_tokens: 1 } },
          200,
          {
            "anthropic-ratelimit-unified-status": "rejected",
            "anthropic-ratelimit-unified-5h-status": "rejected",
            "anthropic-ratelimit-unified-5h-utilization": "1",
            "anthropic-ratelimit-unified-5h-reset": String(resetSec),
          },
        );
      }
      return jsonResponse({ type: "message", content: [], usage: { input_tokens: 1, output_tokens: 1 } });
    });

    await proxyAnthropicMessages(
      { model: "claude-sonnet-5", max_tokens: 8, messages: [{ role: "user", content: "hi" }] },
      new Headers(),
      mgr,
      config,
      new AbortController().signal,
    );

    // "a" just got its snapshot recorded (5h window spent); it should no longer be picked.
    const picked = mgr.pick();
    expect(picked?.name).toBe("b");
    expect(mgr.getAccount("a").available).toBe(false);
    expect(mgr.getAccount("a").unavailableReason).toMatch(/usage limit reached/);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("captures a model-scoped (Fable) unified window and routes Fable traffic off the account", async () => {
  const { poolDir, mgr, config } = tempPool(["a", "b"]);
  try {
    const resetSec = Math.floor(Date.now() / 1000) + 3600;
    mockFetch(() =>
      jsonResponse(
        { type: "message", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } },
        200,
        {
          "anthropic-ratelimit-unified-status": "allowed",
          "anthropic-ratelimit-unified-5h-status": "allowed",
          "anthropic-ratelimit-unified-5h-utilization": "0.10",
          "anthropic-ratelimit-unified-5h-reset": String(resetSec),
          "anthropic-ratelimit-unified-7d-status": "allowed",
          "anthropic-ratelimit-unified-7d-utilization": "0.20",
          "anthropic-ratelimit-unified-7d-reset": String(resetSec + 1000),
          // Fable's own, lower allowance — a hypothetical model-scoped window.
          "anthropic-ratelimit-unified-7d-fable-status": "rejected",
          "anthropic-ratelimit-unified-7d-fable-utilization": "1",
          "anthropic-ratelimit-unified-7d-fable-reset": String(resetSec + 2000),
        },
      ),
    );

    await proxyAnthropicMessages(
      { model: "claude-fable-5", max_tokens: 8, messages: [{ role: "user", content: "hi" }] },
      new Headers(),
      mgr,
      config,
      new AbortController().signal,
    );

    const rl = mgr.getAccount("a").usage.rateLimitStatus;
    const fable = rl?.windows.find((w) => w.key === "7d-fable");
    expect(fable?.model).toBe("fable");
    expect(fable?.utilization).toBe(1);
    expect(fable?.reset).toBe((resetSec + 2000) * 1000);

    // Fable allowance spent on "a": Fable requests route to "b", but "a" stays
    // available for everything else.
    expect(mgr.getAccount("a").available).toBe(true);
    expect(mgr.pick(undefined, new Set(), "anthropic", "fable")?.name).toBe("b");
    expect(mgr.pick(undefined, new Set(["b"]), "anthropic", "fable")).toBeNull();
    expect(mgr.pick(undefined, new Set(["b"]), "anthropic", "sonnet")?.name).toBe("a");
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("streams upstream SSE bytes through unchanged and records final usage", async () => {
  const { poolDir, mgr, config } = tempPool(["a"]);
  try {
    const upstreamSse =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7,"output_tokens":0}}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    mockFetch(() => sseResponse(upstreamSse));

    const response = await proxyAnthropicMessages(
      {
        model: "claude-sonnet-5",
        max_tokens: 8,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      },
      new Headers(),
      mgr,
      config,
      new AbortController().signal,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await drain(response)).toBe(upstreamSse);
    expect(mgr.getAccount("a").usage.totalRequests).toBe(1);
    expect(mgr.getAccount("a").usage.totalInputTokens).toBe(7);
    expect(mgr.getAccount("a").usage.totalOutputTokens).toBe(5);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

// Overload backoff: base/maxDelay zeroed for instant sleeps, small max for crisp call counts.
function backoffConfig(config: Config, overloadRetryMax = 2): Config {
  return { ...config, overloadRetryMax, overloadRetryBaseMs: 0, overloadRetryMaxDelayMs: 0 };
}

test("retries a 529 on the SAME account and returns the eventual success", async () => {
  const { poolDir, mgr, config } = tempPool(["a", "b"]);
  try {
    let n = 0;
    const calls = mockFetch(() => {
      n += 1;
      if (n === 1) {
        return jsonResponse(
          { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
          529,
        );
      }
      return jsonResponse({
        type: "message",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 2, output_tokens: 3 },
      });
    });

    const response = await proxyAnthropicMessages(
      { model: "claude-sonnet-5", max_tokens: 8, messages: [{ role: "user", content: "hi" }] },
      new Headers(),
      mgr,
      backoffConfig(config),
      new AbortController().signal,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Pool-Account")).toBe("a");
    // Two calls, both on account "a" — never failed over to "b".
    expect(calls.map((c) => c.headers.get("authorization"))).toEqual(["Bearer tok-a", "Bearer tok-a"]);
    expect(mgr.getAccount("a").available).toBe(true);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("surfaces a persistent 529 faithfully after the budget, without failing over", async () => {
  const { poolDir, mgr, config } = tempPool(["a", "b"]);
  try {
    // Spy on recordError to prove it runs exactly once (at surface time).
    const errors: string[] = [];
    const orig = mgr.recordError.bind(mgr);
    mgr.recordError = ((name: string, message: string) => {
      errors.push(message);
      return orig(name, message);
    }) as typeof mgr.recordError;

    const calls = mockFetch(() =>
      jsonResponse(
        { type: "error", error: { type: "overloaded_error", message: "Overloaded, retry" } },
        529,
        { "retry-after": "3", "request-id": "req_xyz" },
      ),
    );

    const response = await proxyAnthropicMessages(
      { model: "claude-sonnet-5", max_tokens: 8, messages: [{ role: "user", content: "hi" }] },
      new Headers(),
      mgr,
      backoffConfig(config, 2),
      new AbortController().signal,
    );

    expect(response.status).toBe(529);
    // overloadRetryMax(2) + 1 = 3 upstream calls, all on "a".
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.headers.get("authorization") === "Bearer tok-a")).toBe(true);
    // Faithful surface: original body + retry-after + request-id + X-Pool-Account.
    expect(await response.json()).toMatchObject({
      error: { type: "overloaded_error", message: "Overloaded, retry" },
    });
    expect(response.headers.get("retry-after")).toBe("3");
    expect(response.headers.get("request-id")).toBe("req_xyz");
    expect(response.headers.get("X-Pool-Account")).toBe("a");
    // Not sidelined; recordError called once, not per attempt.
    expect(mgr.getAccount("a").available).toBe(true);
    expect(errors).toHaveLength(1);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("backs off and surfaces transient 500 and 503 like 529", async () => {
  for (const status of [500, 503]) {
    const { poolDir, mgr, config } = tempPool(["a"]);
    try {
      const calls = mockFetch(() =>
        jsonResponse({ type: "error", error: { type: "api_error", message: "boom" } }, status),
      );
      const response = await proxyAnthropicMessages(
        { model: "claude-sonnet-5", max_tokens: 8, messages: [{ role: "user", content: "hi" }] },
        new Headers(),
        mgr,
        backoffConfig(config, 1),
        new AbortController().signal,
      );
      expect(response.status).toBe(status);
      expect(calls).toHaveLength(2); // 1 retry + initial
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  }
});

test("OVERLOAD_RETRY_MAX=0 surfaces the 529 immediately with passthrough fidelity", async () => {
  const { poolDir, mgr, config } = tempPool(["a"]);
  try {
    const calls = mockFetch(() =>
      jsonResponse(
        { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
        529,
      ),
    );
    const response = await proxyAnthropicMessages(
      { model: "claude-sonnet-5", max_tokens: 8, messages: [{ role: "user", content: "hi" }] },
      new Headers(),
      mgr,
      backoffConfig(config, 0),
      new AbortController().signal,
    );
    expect(response.status).toBe(529);
    expect(calls).toHaveLength(1);
    expect(response.headers.get("X-Pool-Account")).toBe("a");
    expect(await response.json()).toMatchObject({ error: { type: "overloaded_error" } });
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

const OVERLOAD_SSE =
  'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n';

test("retries a pre-commit SSE overloaded_error on the same account, then streams success", async () => {
  const { poolDir, mgr, config } = tempPool(["a", "b"]);
  try {
    const successSse =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":4,"output_tokens":0}}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    let n = 0;
    const calls = mockFetch(() => {
      n += 1;
      return n === 1 ? sseResponse(OVERLOAD_SSE) : sseResponse(successSse);
    });

    const response = await proxyAnthropicMessages(
      { model: "claude-sonnet-5", max_tokens: 8, stream: true, messages: [{ role: "user", content: "hi" }] },
      new Headers(),
      mgr,
      backoffConfig(config),
      new AbortController().signal,
    );

    expect(response.status).toBe(200);
    // Client sees only the success stream — never the overload error event.
    expect(await drain(response)).toBe(successSse);
    expect(calls.map((c) => c.headers.get("authorization"))).toEqual(["Bearer tok-a", "Bearer tok-a"]);
    expect(mgr.getAccount("a").available).toBe(true);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("surfaces status 529 (not 502) when a pre-commit SSE overload never clears", async () => {
  const { poolDir, mgr, config } = tempPool(["a"]);
  try {
    const calls = mockFetch(() => sseResponse(OVERLOAD_SSE));
    const response = await proxyAnthropicMessages(
      { model: "claude-sonnet-5", max_tokens: 8, stream: true, messages: [{ role: "user", content: "hi" }] },
      new Headers(),
      mgr,
      backoffConfig(config, 2),
      new AbortController().signal,
    );
    expect(response.status).toBe(529); // eligible for cross-provider last resort
    expect(calls).toHaveLength(3); // overloadRetryMax(2) + 1
    expect(mgr.getAccount("a").available).toBe(true);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("forwards a POST-commit SSE overloaded_error verbatim without retrying", async () => {
  const { poolDir, mgr, config } = tempPool(["a", "b"]);
  try {
    const committedThenError =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n' +
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n';
    const calls = mockFetch(() => sseResponse(committedThenError));

    const response = await proxyAnthropicMessages(
      { model: "claude-sonnet-5", max_tokens: 8, stream: true, messages: [{ role: "user", content: "hi" }] },
      new Headers(),
      mgr,
      config,
      new AbortController().signal,
    );

    expect(response.status).toBe(200);
    // Committed before the error → client receives the whole stream verbatim, error event included.
    expect(await drain(response)).toBe(committedThenError);
    // Exactly one upstream call: a post-commit overload must NOT be retried.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer tok-a");
    // Not sidelined (recording an error is fine; markRateLimited must not fire for overload).
    expect(mgr.getAccount("a").available).toBe(true);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});
