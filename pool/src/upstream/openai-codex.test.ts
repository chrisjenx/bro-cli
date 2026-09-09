import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig } from "../config.ts";
import { AccountManager } from "../accounts/manager.ts";
import { OPENAI_CREDS_FILENAME } from "../accounts/types.ts";
import { describeCodexError, parseCodexRateLimitSnapshot, proxyCodexMessages, resetAtFromCodexHeaders } from "./openai-codex.ts";
import { RETRYABLE_TRANSPORT_HEADER } from "./shared.ts";

function tempOpenAIPool(accountNames: string[]): { poolDir: string; mgr: AccountManager } {
  const poolDir = mkdtempSync(join(tmpdir(), "cmp-codex-"));
  const accountsDir = join(poolDir, "accounts");
  for (const name of accountNames) {
    const dir = join(accountsDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, OPENAI_CREDS_FILENAME),
      JSON.stringify({
        accessToken: "tok-" + name,
        refreshToken: "r-" + name,
        accountId: "acct-" + name,
        expiresAt: Date.now() + 3_600_000,
        planType: "pro",
      }),
    );
  }
  const config = loadConfig({
    poolDir,
    accountsDir,
    usageFile: join(poolDir, "usage.json"),
    sessionsFile: join(poolDir, "sessions.json"),
  });
  return { poolDir, mgr: new AccountManager(config) };
}

describe("parseCodexRateLimitSnapshot", () => {
  test("maps primary/secondary windows onto the unified snapshot", () => {
    const inOneHour = Math.floor(Date.now() / 1000) + 3600;
    const inOneDay = Math.floor(Date.now() / 1000) + 86400;
    const h = new Headers({
      "x-codex-primary-used-percent": "42.5",
      "x-codex-primary-reset-at": String(inOneHour),
      "x-codex-secondary-used-percent": "10",
      "x-codex-secondary-reset-at": String(inOneDay),
    });
    const s = parseCodexRateLimitSnapshot(h);
    const five = s.windows.find((w) => w.key === "5h");
    const seven = s.windows.find((w) => w.key === "7d");
    expect(five?.utilization).toBeCloseTo(0.425);
    expect(five?.status).toBe("allowed");
    expect(five?.reset).toBe(inOneHour * 1000);
    expect(five?.model).toBeNull();
    expect(seven?.utilization).toBeCloseTo(0.1);
    expect(seven?.reset).toBe(inOneDay * 1000);
    expect(s.unifiedStatus).toBe("allowed");
  });

  test("exhausted primary window reads as rejected only on a 429", () => {
    const h = new Headers({ "x-codex-primary-used-percent": "100" });
    expect(parseCodexRateLimitSnapshot(h).windows.find((w) => w.key === "5h")?.status).toBe("allowed");
    const rejected = parseCodexRateLimitSnapshot(h, { rejected: true });
    expect(rejected.windows.find((w) => w.key === "5h")?.status).toBe("rejected");
    expect(rejected.unifiedStatus).toBe("rejected");
  });

  test("keys a window by its window-minutes, not its slot", () => {
    const h = new Headers({
      "x-codex-primary-used-percent": "100",
      "x-codex-primary-window-minutes": "10080",
      "x-codex-primary-reset-at": String(Math.floor(Date.now() / 1000) + 600_000),
    });
    const s = parseCodexRateLimitSnapshot(h);
    // Weekly window in the primary slot must read as 7d, not 5h.
    expect(s.windows.find((w) => w.key === "7d")?.utilization).toBeCloseTo(1);
    expect(s.windows.find((w) => w.key === "5h")).toBeUndefined();
    expect(s.windows.find((w) => w.key === "7d")?.status).toBe("allowed");
  });

  test("keys a 300-minute primary window as 5h", () => {
    const h = new Headers({ "x-codex-primary-used-percent": "20", "x-codex-primary-window-minutes": "300" });
    expect(parseCodexRateLimitSnapshot(h).windows.find((w) => w.key === "5h")?.utilization).toBeCloseTo(0.2);
  });

  test("no headers → empty windows, null unified status", () => {
    const s = parseCodexRateLimitSnapshot(new Headers());
    expect(s.windows).toEqual([]);
    expect(s.unifiedStatus).toBeNull();
  });
});

describe("resetAtFromCodexHeaders", () => {
  test("Codex absolute reset-at takes precedence over a generic retry-after", () => {
    const resetAt = Math.floor(Date.now() / 1000) + 3600;
    const h = new Headers({
      "x-codex-primary-reset-at": String(resetAt),
      "retry-after": "30",
    });
    // Must use the authoritative window reset, not now+30s from retry-after.
    expect(resetAtFromCodexHeaders(h)).toBe(resetAt * 1000);
  });

  test("falls back to retry-after when no Codex reset-at header is present", () => {
    const h = new Headers({ "retry-after": "60" });
    const got = resetAtFromCodexHeaders(h)!;
    // ~60s in the future (allow a little slack for clock/exec time).
    expect(got).toBeGreaterThanOrEqual(Date.now() + 55_000);
    expect(got).toBeLessThanOrEqual(Date.now() + 65_000);
  });

  test("undefined when neither header is present", () => {
    expect(resetAtFromCodexHeaders(new Headers())).toBeUndefined();
  });

  test("uses the soonest future reset among primary and secondary windows", () => {
    const soon = Math.floor(Date.now() / 1000) + 600;
    const later = Math.floor(Date.now() / 1000) + 7 * 86400;
    const h = new Headers({
      "x-codex-primary-reset-at": String(later),
      "x-codex-secondary-reset-at": String(soon),
    });
    expect(resetAtFromCodexHeaders(h)).toBe(soon * 1000);
  });

  test("ignores a window reset already in the past", () => {
    const past = Math.floor(Date.now() / 1000) - 100;
    const future = Math.floor(Date.now() / 1000) + 600;
    const h = new Headers({
      "x-codex-primary-reset-at": String(past),
      "x-codex-secondary-reset-at": String(future),
    });
    expect(resetAtFromCodexHeaders(h)).toBe(future * 1000);
  });
});

// Each SSE event is terminated by a blank line, per spec — the events must
// NOT be joined by single newlines (that would fold them into one data field).
const sse = [
  'data: {"type":"response.created","response":{"id":"r1"}}',
  "",
  'data: {"type":"response.output_item.added","item":{"type":"message"}}',
  "",
  'data: {"type":"response.output_text.delta","delta":"Hi"}',
  "",
  'data: {"type":"response.output_item.done","item":{"type":"message"}}',
  "",
  'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":1}}}',
  "",
  "",
].join("\n");
/** The fixture up to (not including) its terminal event. */
const ssePrefix = sse.slice(0, sse.indexOf('data: {"type":"response.completed"'));
const enc = new TextEncoder();
const CODEX_ROUTE = { id: "gpt", provider: "openai", upstreamModel: "gpt-5.2-codex" } as const;

/** Sends a minimal /v1/messages body through proxyCodexMessages with a stubbed upstream body. */
function proxyWithUpstream(
  mgr: AccountManager,
  config: ReturnType<typeof loadConfig>,
  stream: boolean,
  upstream: string | ReadableStream<Uint8Array>,
): Promise<Response> {
  return proxyCodexMessages(
    { model: CODEX_ROUTE.id, messages: [{ role: "user", content: "hi" }], stream },
    mgr, config, new AbortController().signal, CODEX_ROUTE, {},
    (async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => new Response(upstream)) as typeof fetch,
  );
}

describe("describeCodexError", () => {
  test("surfaces the backend `detail` with context instead of raw JSON", () => {
    const msg = describeCodexError(400, JSON.stringify({ detail: "Unsupported parameter: max_output_tokens" }), "work");
    expect(msg).toContain("Codex backend rejected the request (HTTP 400)");
    expect(msg).toContain("Unsupported parameter: max_output_tokens");
    expect(msg).toContain('account "work"');
    // The raw JSON envelope must not leak through.
    expect(msg).not.toContain('{"detail"');
  });

  test("falls back to error.message, then raw body, then a bare status", () => {
    expect(describeCodexError(400, JSON.stringify({ error: { message: "bad request" } }), "a")).toContain("bad request");
    expect(describeCodexError(500, "gateway exploded", "a")).toContain("gateway exploded");
    expect(describeCodexError(503, "", "a")).toBe('Codex backend rejected the request (HTTP 503) [account "a"]');
  });

  test("caps a structured backend detail before returning or persisting it", () => {
    const oversizedDetail = "x".repeat(1_000);
    const msg = describeCodexError(400, JSON.stringify({ detail: oversizedDetail }), "a");
    expect(msg).toContain("x".repeat(300));
    expect(msg).not.toContain("x".repeat(301));
  });
});

describe("proxyCodexMessages", () => {
  /**
   * Serves one request over real HTTP against an upstream that sends
   * `ssePrefix`, then `terminalChunk` once the request is in flight, and
   * never closes on its own. Fails if the proxy waits for transport EOF.
   */
  async function serveHeldOpenUpstream(
    stream: boolean,
    terminalChunk: string,
    check: (mgr: AccountManager, response: { status: number; text: string }) => void,
  ): Promise<void> {
    const { poolDir, mgr } = tempOpenAIPool(["gpt1"]);
    const config = loadConfig({ poolDir, accountsDir: join(poolDir, "accounts"), usageFile: join(poolDir, "usage.json"), streamKeepAliveMs: 20 });
    let upstreamController!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        upstreamController = controller;
        controller.enqueue(enc.encode(ssePrefix));
      },
      cancel() { cancelled = true; },
    });
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: () => proxyWithUpstream(mgr, config, stream, upstream),
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = fetch(`http://127.0.0.1:${server.port}`).then(async (res) => ({ status: res.status, text: await res.text() }));
      upstreamController.enqueue(enc.encode(terminalChunk));
      const response = await Promise.race([
        result,
        new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("waited for transport EOF")), 1000); }),
      ]);
      expect(cancelled).toBe(true);
      check(mgr, response);
    } finally {
      clearTimeout(deadline);
      if (!cancelled) upstreamController.close();
      server.stop(true);
      rmSync(poolDir, { recursive: true, force: true });
    }
  }

  for (const stream of [true, false]) {
    const mode = stream ? "streaming" : "non-stream";

    // A streaming response commits message_start before EOF is known, so its
    // failure surfaces as an SSE error frame inside a 200; non-stream and
    // empty bodies fail before commit and get a 502.
    for (const { label, body, status } of [
      { label: "empty", body: "", status: 502 },
      { label: "partial", body: ssePrefix, status: stream ? 200 : 502 },
      { label: "unterminated terminal event", body: sse.trimEnd(), status: stream ? 200 : 502 },
    ]) {
      test(`${mode}: ${label} EOF is not recorded as success`, async () => {
        const { poolDir, mgr } = tempOpenAIPool(["gpt1"]);
        try {
          const config = loadConfig({ poolDir, accountsDir: join(poolDir, "accounts"), usageFile: join(poolDir, "usage.json") });
          const res = await proxyWithUpstream(mgr, config, stream, body);
          const text = await res.text();
          expect(res.status).toBe(status);
          expect(text).toContain("before a terminal event");
          expect(text).not.toContain("message_stop");
          expect(mgr.getAccount("gpt1").usage.totalRequests).toBe(0);
          expect(mgr.getAccount("gpt1").usage.lastError).toContain("before a terminal event");
        } finally {
          rmSync(poolDir, { recursive: true, force: true });
        }
      });
    }

    for (const { event, stop } of [
      { event: { type: "response.completed", response: { status: "completed" } }, stop: "end_turn" },
      { event: { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }, stop: "max_tokens" },
      { event: { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "content_filter" } } }, stop: "refusal" },
    ]) {
      test(`${mode}: ${event.type}/${stop} finishes without transport EOF over HTTP`, async () => {
        await serveHeldOpenUpstream(stream, `data: ${JSON.stringify(event)}\n\n`, (mgr, response) => {
          expect(response.status).toBe(200);
          if (stream) {
            expect((response.text.match(/event: message_stop/g) ?? [])).toHaveLength(1);
            expect(response.text).toContain(`"stop_reason":"${stop}"`);
          } else {
            expect(JSON.parse(response.text)).toMatchObject({ content: [{ type: "text", text: "Hi" }], stop_reason: stop });
          }
          expect(mgr.getAccount("gpt1").usage.totalRequests).toBe(1);
        });
      });
    }

    test(`${mode}: response.failed ends the response without transport EOF over HTTP`, async () => {
      const failed = { type: "response.failed", response: { error: { code: "server_error", message: "upstream failed" } } };
      await serveHeldOpenUpstream(stream, `data: ${JSON.stringify(failed)}\n\n`, (mgr, response) => {
        expect(response.text).toContain("upstream failed");
        expect(response.text).not.toContain("message_stop");
        expect(mgr.getAccount("gpt1").usage.totalRequests).toBe(0);
      });
    });
  }

  test("non-stream: truncated upstream fails over to the next account like the streaming path", async () => {
    const { poolDir, mgr } = tempOpenAIPool(["gpt1", "gpt2"]);
    try {
      const config = loadConfig({ poolDir, accountsDir: join(poolDir, "accounts"), usageFile: join(poolDir, "usage.json") });
      const bodies = [ssePrefix, sse];
      const fakeFetch = (async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
        new Response(bodies.shift() ?? "")) as typeof fetch;
      const res = await proxyCodexMessages(
        { model: CODEX_ROUTE.id, messages: [{ role: "user", content: "hi" }] },
        mgr, config, new AbortController().signal, CODEX_ROUTE, {}, fakeFetch,
      );
      expect(res.status).toBe(200);
      expect(bodies).toHaveLength(0);
      const first = mgr.getAccount("gpt1").usage;
      const second = mgr.getAccount("gpt2").usage;
      const [truncated, served] = first.totalRequests === 0 ? [first, second] : [second, first];
      expect(truncated.lastError).toContain("before a terminal event");
      expect(served.totalRequests).toBe(1);
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("streaming: a post-commit rate-limit error sidelines the account", async () => {
    const { poolDir, mgr } = tempOpenAIPool(["gpt1"]);
    try {
      const config = loadConfig({ poolDir, accountsDir: join(poolDir, "accounts"), usageFile: join(poolDir, "usage.json") });
      const limited = { type: "error", error: { code: "rate_limit_exceeded", message: "You have hit your usage limit" } };
      const res = await proxyWithUpstream(mgr, config, true, `${ssePrefix}data: ${JSON.stringify(limited)}\n\n`);
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(text).toContain("usage limit");
      expect(text).not.toContain("message_stop");
      expect(mgr.getAccount("gpt1").usage.rateLimitedUntil ?? 0).toBeGreaterThan(Date.now());
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("passes the route's max-effort capability into the Codex request", async () => {
    const { poolDir, mgr } = tempOpenAIPool(["gpt1"]);
    try {
      const config = loadConfig({ poolDir, accountsDir: join(poolDir, "accounts"), usageFile: join(poolDir, "usage.json") });
      let sent: Record<string, unknown> | undefined;
      const fakeFetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ detail: "probe complete" }), { status: 400 });
      }) as typeof fetch;
      await proxyCodexMessages(
        {
          model: "gpt-6-astra",
          messages: [{ role: "user", content: "hi" }],
          output_config: { effort: "max" },
        },
        mgr,
        config,
        new AbortController().signal,
        {
          id: "gpt-6-astra",
          provider: "openai",
          upstreamModel: "gpt-6-astra",
          supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
        },
        {},
        fakeFetch,
      );
      expect(sent).toMatchObject({ model: "gpt-6-astra", reasoning: { effort: "max" } });
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("a backend 400 is terminal with a legible message, not a raw-JSON passthrough", async () => {
    const { poolDir, mgr } = tempOpenAIPool(["gpt1", "gpt2"]);
    try {
      const config = loadConfig({ poolDir, accountsDir: join(poolDir, "accounts"), usageFile: join(poolDir, "usage.json") });
      let calls = 0;
      const fakeFetch = (async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
        calls += 1;
        return new Response(JSON.stringify({ detail: "Unsupported parameter: max_output_tokens" }), { status: 400 });
      }) as typeof fetch;
      const res = await proxyCodexMessages(
        { model: "gpt", messages: [{ role: "user", content: "hi" }] },
        mgr,
        config,
        new AbortController().signal,
        { id: "gpt", provider: "openai", upstreamModel: "gpt-5.2-codex" },
        {},
        fakeFetch,
      );
      expect(res.status).toBe(400);
      // Request-shape 400 is deterministic: it must NOT burn the second account.
      expect(calls).toBe(1);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain("Codex backend rejected the request (HTTP 400)");
      expect(body.error.message).toContain("Unsupported parameter: max_output_tokens");
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("non-stream request returns a folded Anthropic message and records usage", async () => {
    const { poolDir, mgr } = tempOpenAIPool(["gpt1"]);
    try {
      const config = loadConfig({ poolDir, accountsDir: join(poolDir, "accounts"), usageFile: join(poolDir, "usage.json") });
      const fakeFetch = (async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
        new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream", "x-codex-primary-used-percent": "5" },
        })) as typeof fetch;
      const res = await proxyCodexMessages(
        { model: "gpt", messages: [{ role: "user", content: "hi" }] },
        mgr,
        config,
        new AbortController().signal,
        { id: "gpt", provider: "openai", upstreamModel: "gpt-5.2-codex" },
        {},
        fakeFetch,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("X-Pool-Account")).toBe("gpt1");
      const msg = (await res.json()) as { content: unknown };
      expect(msg.content).toEqual([{ type: "text", text: "Hi" }]);
      expect(mgr.getAccount("gpt1").usage.windowRequests).toBe(1);
      expect(
        mgr.getAccount("gpt1").usage.rateLimitStatus?.windows.find((w) => w.key === "5h")?.utilization,
      ).toBeCloseTo(0.05);
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("streaming carries and replaces terminal context for the same session and route", async () => {
    const { poolDir, mgr } = tempOpenAIPool(["gpt1"]);
    try {
      const config = loadConfig({
        poolDir,
        accountsDir: join(poolDir, "accounts"),
        usageFile: join(poolDir, "usage.json"),
      });
      let call = 0;
      const fakeFetch = (async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
        call += 1;
        const body = call === 2
          ? sse.replace('"input_tokens":3,"output_tokens":1', '"input_tokens":7,"output_tokens":2')
          : sse;
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }) as typeof fetch;
      const route = { id: "gpt", provider: "openai" as const, upstreamModel: "gpt-5.2-codex" };
      const request = {
        model: "gpt",
        messages: [{ role: "user", content: "hi" }],
        metadata: { user_id: "session-a" },
        stream: true,
      };

      const first = await proxyCodexMessages(
        request, mgr, config, new AbortController().signal, route, {}, fakeFetch,
      );
      await first.text();

      const second = await proxyCodexMessages(
        request, mgr, config, new AbortController().signal, route, {}, fakeFetch,
      );
      const secondText = await second.text();
      const secondStart = secondText.split("\n\n").find((block) => block.includes("message_start"))!;
      expect(JSON.parse(secondStart.split("data: ")[1]!).message.usage)
        .toEqual({ input_tokens: 4, output_tokens: 0 });

      const third = await proxyCodexMessages(
        request, mgr, config, new AbortController().signal, route, {}, fakeFetch,
      );
      const thirdStart = (await third.text()).split("\n\n").find((block) => block.includes("message_start"))!;
      expect(JSON.parse(thirdStart.split("data: ")[1]!).message.usage)
        .toEqual({ input_tokens: 9, output_tokens: 0 });
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("non-stream terminal usage seeds the next streaming opening", async () => {
    const { poolDir, mgr } = tempOpenAIPool(["gpt1"]);
    try {
      const config = loadConfig({
        poolDir,
        accountsDir: join(poolDir, "accounts"),
        usageFile: join(poolDir, "usage.json"),
      });
      const fakeFetch = (async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
        new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })) as typeof fetch;
      const route = {
        id: "gpt",
        provider: "openai" as const,
        upstreamModel: "gpt-5.2-codex",
      };
      const baseRequest = {
        model: "gpt",
        messages: [{ role: "user", content: "hi" }],
        metadata: { user_id: "session-a" },
      };

      const first = await proxyCodexMessages(
        baseRequest,
        mgr,
        config,
        new AbortController().signal,
        route,
        {},
        fakeFetch,
      );
      await first.text();

      const second = await proxyCodexMessages(
        { ...baseRequest, stream: true },
        mgr,
        config,
        new AbortController().signal,
        route,
        {},
        fakeFetch,
      );
      const start = (await second.text())
        .split("\n\n")
        .find((block) => block.includes("message_start"))!;
      expect(JSON.parse(start.split("data: ")[1]!).message.usage)
        .toEqual({ input_tokens: 4, output_tokens: 0 });
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("carried context is isolated by session and route", async () => {
    const { poolDir, mgr } = tempOpenAIPool(["gpt1"]);
    try {
      const config = loadConfig({
        poolDir,
        accountsDir: join(poolDir, "accounts"),
        usageFile: join(poolDir, "usage.json"),
      });
      const fakeFetch = (async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
        new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
      const requestFor = (session: string) => ({
        model: "gpt",
        messages: [{ role: "user", content: "hi" }],
        metadata: { user_id: session },
        stream: true,
      });
      const routeFor = (id: string) => ({
        id,
        provider: "openai" as const,
        upstreamModel: "gpt-5.2-codex",
      });
      const openingInput = async (session: string, routeId: string) => {
        const res = await proxyCodexMessages(
          requestFor(session), mgr, config, new AbortController().signal,
          routeFor(routeId), {}, fakeFetch,
        );
        const start = (await res.text()).split("\n\n").find((block) => block.includes("message_start"))!;
        return JSON.parse(start.split("data: ")[1]!).message.usage.input_tokens;
      };

      expect(await openingInput("session-a", "gpt")).toBe(0);
      expect(await openingInput("session-b", "gpt")).toBe(0);
      expect(await openingInput("session-a", "gpt-other")).toBe(0);
      expect(await openingInput("session-a", "gpt")).toBe(4);
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("a failed stream does not replace carried context", async () => {
    const { poolDir, mgr } = tempOpenAIPool(["gpt1"]);
    try {
      const config = loadConfig({
        poolDir,
        accountsDir: join(poolDir, "accounts"),
        usageFile: join(poolDir, "usage.json"),
      });
      const failedSse = [
        'data: {"type":"response.created","response":{"id":"failed"}}',
        "",
        'data: {"type":"response.failed","response":{"error":{"code":"boom","message":"backend broke"}}}',
        "",
        "",
      ].join("\n");
      let call = 0;
      const fakeFetch = (async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
        call += 1;
        const body = call === 2 ? failedSse : sse;
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }) as typeof fetch;
      const route = {
        id: "gpt",
        provider: "openai" as const,
        upstreamModel: "gpt-5.2-codex",
      };
      const request = {
        model: "gpt",
        messages: [{ role: "user", content: "hi" }],
        metadata: { user_id: "session-a" },
        stream: true,
      };
      const send = () => proxyCodexMessages(
        request,
        mgr,
        config,
        new AbortController().signal,
        route,
        {},
        fakeFetch,
      );

      await (await send()).text();
      await (await send()).text();
      const afterFailure = await (await send()).text();
      const start = afterFailure
        .split("\n\n")
        .find((block) => block.includes("message_start"))!;
      expect(JSON.parse(start.split("data: ")[1]!).message.usage.input_tokens).toBe(4);
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("a cancelled stream does not replace carried context", async () => {
    const { poolDir, mgr } = tempOpenAIPool(["gpt1"]);
    try {
      const config = loadConfig({
        poolDir,
        accountsDir: join(poolDir, "accounts"),
        usageFile: join(poolDir, "usage.json"),
      });
      let call = 0;
      const fakeFetch = (async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
        call += 1;
        if (call !== 2) {
          return new Response(sse, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        const cancelledUpstream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode([
              'data: {"type":"response.created","response":{"id":"cancelled"}}',
              "",
              "",
            ].join("\n")));
          },
        });
        return new Response(cancelledUpstream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }) as typeof fetch;
      const route = {
        id: "gpt",
        provider: "openai" as const,
        upstreamModel: "gpt-5.2-codex",
      };
      const request = {
        model: "gpt",
        messages: [{ role: "user", content: "hi" }],
        metadata: { user_id: "session-a" },
        stream: true,
      };
      const send = () => proxyCodexMessages(
        request,
        mgr,
        config,
        new AbortController().signal,
        route,
        {},
        fakeFetch,
      );

      await (await send()).text();
      const cancelled = await send();
      const reader = cancelled.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain("message_start");
      await reader.cancel();

      const afterCancellation = await (await send()).text();
      const start = afterCancellation
        .split("\n\n")
        .find((block) => block.includes("message_start"))!;
      expect(JSON.parse(start.split("data: ")[1]!).message.usage.input_tokens).toBe(4);
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("a successful response with no rate-limit headers preserves prior windows", async () => {
    const { poolDir, mgr } = tempOpenAIPool(["gpt1"]);
    try {
      const config = loadConfig({ poolDir, accountsDir: join(poolDir, "accounts"), usageFile: join(poolDir, "usage.json") });
      // Seed a known weekly window from an earlier header-bearing response.
      mgr.recordRateLimitSnapshot(
        "gpt1",
        {
          unifiedStatus: "allowed",
          windows: [{ key: "7d", model: null, status: "allowed", utilization: 0.8, reset: Date.now() + 7 * 24 * 60 * 60_000 }],
          updatedAt: Date.now(),
        },
        true,
      );
      // A headerless 200 (e.g. a codex-exec-style turn) must NOT wipe that window.
      const fakeFetch = (async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
        new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
      const res = await proxyCodexMessages(
        { model: "gpt", messages: [{ role: "user", content: "hi" }] },
        mgr,
        config,
        new AbortController().signal,
        { id: "gpt", provider: "openai", upstreamModel: "gpt-5.2-codex" },
        {},
        fakeFetch,
      );
      expect(res.status).toBe(200);
      expect(
        mgr.getAccount("gpt1").usage.rateLimitStatus?.windows.find((w) => w.key === "7d")?.utilization,
      ).toBeCloseTo(0.8);
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("429 sidelines the account and fails over to the next one", async () => {
    const { poolDir, mgr } = tempOpenAIPool(["gpt1", "gpt2"]);
    try {
      const config = loadConfig({ poolDir, accountsDir: join(poolDir, "accounts"), usageFile: join(poolDir, "usage.json") });
      let call = 0;
      const fakeFetch = (async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
        call += 1;
        return call === 1
          ? new Response(JSON.stringify({ detail: "rate limited" }), { status: 429 })
          : new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
      }) as typeof fetch;
      const res = await proxyCodexMessages(
        { model: "gpt", messages: [{ role: "user", content: "hi" }] },
        mgr,
        config,
        new AbortController().signal,
        { id: "gpt", provider: "openai", upstreamModel: "gpt-5.2-codex" },
        {},
        fakeFetch,
      );
      expect(res.status).toBe(200);
      expect(call).toBe(2);
      const sidelined = mgr.listAccounts().find((a) => !a.available);
      expect(sidelined).toBeDefined();
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("streaming: a first event larger than the commit cap still yields message_start before it completes", async () => {
    // Codex's `response.created` echoes the request `instructions` (the full
    // Claude Code system prompt + tool schemas), so its single SSE `data:` line
    // is >64 KiB. The prefix-drain loop caps at 64 KiB and can't complete that
    // first line, so `handleEvent` never fires and `message_start` is never
    // emitted — the client sees a 200 with no opening frame and hangs. The pool
    // must synthesize a `message_start` when it commits at the cap so the client
    // always gets a prompt stream start, even if the oversized first event has
    // not finished arriving yet.
    const huge = "x".repeat(80 * 1024);
    const firstEventPrefix =
      `event: response.created\ndata: {"type":"response.created","response":{"id":"r1","instructions":"${huge}`;

    // Upstream body: emit the (incomplete) oversized first event, then stall —
    // mirroring a client that never sees the event terminate promptly.
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(firstEventPrefix));
        // Intentionally do not close or complete the event.
      },
    });

    const { poolDir, mgr } = tempOpenAIPool(["gpt1"]);
    try {
      const config = loadConfig({ poolDir, accountsDir: join(poolDir, "accounts"), usageFile: join(poolDir, "usage.json") });
      const fakeFetch = (async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
        new Response(upstream, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;

      const res = await proxyCodexMessages(
        { model: "gpt", messages: [{ role: "user", content: "hi" }], stream: true },
        mgr,
        config,
        new AbortController().signal,
        { id: "gpt", provider: "openai", upstreamModel: "gpt-5.2-codex" },
        {},
        fakeFetch,
      );
      expect(res.status).toBe(200);
      expect(res.body).not.toBeNull();

      // The very first frame the client reads must be a message_start, WITHOUT
      // waiting for the oversized first event to finish (it never does here).
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const firstFrame = await Promise.race([
        reader.read().then(({ value }) => decoder.decode(value)),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error("client received no message_start before the first event completed")), 3_000),
        ),
      ]);
      await reader.cancel().catch(() => {});
      expect(firstFrame).toContain("message_start");
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("streaming: an SSE line that never terminates and exceeds the parser's hard cap fails the attempt cleanly", async () => {
    // A first event so large it blows past the SseParser's own hard buffer cap
    // (not just the 64 KiB commit-cap that triggers forceMessageStart) must
    // fail the attempt with a clean error instead of buffering forever or
    // throwing an uncaught exception out of the request handler.
    const huge = "x".repeat(9 * 1024 * 1024);
    const firstEventPrefix =
      `event: response.created\ndata: {"type":"response.created","response":{"id":"r1","instructions":"${huge}`;

    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(firstEventPrefix));
      },
    });

    const { poolDir, mgr } = tempOpenAIPool(["gpt1"]);
    try {
      const config = loadConfig({ poolDir, accountsDir: join(poolDir, "accounts"), usageFile: join(poolDir, "usage.json") });
      const fakeFetch = (async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
        new Response(upstream, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;

      const res = await proxyCodexMessages(
        { model: "gpt", messages: [{ role: "user", content: "hi" }], stream: true },
        mgr,
        config,
        new AbortController().signal,
        { id: "gpt", provider: "openai", upstreamModel: "gpt-5.2-codex" },
        {},
        fakeFetch,
      );

      expect(res.status).toBe(502);
      const text = await res.text();
      expect(text).toContain("exceeded");
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("streaming: a no-content reasoning phase emits ping keep-alives so the client stream stays alive", async () => {
    // gpt-5.5 is a reasoning model: after message_start it can stream a long
    // run of reasoning-summary events that translate to zero Anthropic frames.
    // Anthropic keeps such gaps alive with `ping` events (see anthropic.ts's
    // passthrough); without them Claude Code sees silence and aborts on its
    // inactivity timeout. The proxy must emit a ping whenever a read yields no
    // translated content, so the client always sees the stream is alive.
    const reasoningEvents: string[] = [];
    for (let i = 0; i < 5; i++) {
      reasoningEvents.push(`data: {"type":"response.reasoning_summary_text.delta","delta":"thinking ${i}"}`, "");
    }
    const reasoningSse = [
      'data: {"type":"response.created","response":{"id":"r1"}}',
      "",
      ...reasoningEvents,
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":1}}}',
      "",
      "",
    ].join("\n");

    const { poolDir, mgr } = tempOpenAIPool(["gpt1"]);
    try {
      const config = loadConfig({ poolDir, accountsDir: join(poolDir, "accounts"), usageFile: join(poolDir, "usage.json") });
      const fakeFetch = (async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
        new Response(reasoningSse, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;

      const res = await proxyCodexMessages(
        { model: "gpt", messages: [{ role: "user", content: "hi" }], stream: true },
        mgr,
        config,
        new AbortController().signal,
        { id: "gpt", provider: "openai", upstreamModel: "gpt-5.2-codex" },
        {},
        fakeFetch,
      );
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let full = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        full += decoder.decode(value);
      }
      // The stream must open, stay alive through the reasoning gap, and close.
      expect(full).toContain("message_start");
      expect(full).toContain("event: ping");
      expect(full).toContain("message_stop");
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("streaming: a silent upstream gap emits timer-based ping keep-alives", async () => {
    // A reasoning model can go fully silent (no bytes at all) while it thinks,
    // after response.created but before any content. Event-driven pings can't
    // fire during true silence, so the proxy must emit ping keep-alives on a
    // timer (config.streamKeepAliveMs) or the client's inactivity timeout fires.
    const enc = new TextEncoder();
    const upstream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(enc.encode('event: response.created\ndata: {"type":"response.created","response":{"id":"r1"}}\n\n'));
        // Silent gap — no bytes for ~300ms while the model "thinks".
        await new Promise((r) => setTimeout(r, 300));
        controller.enqueue(enc.encode('data: {"type":"response.output_item.added","item":{"type":"message"}}\n\n'));
        controller.enqueue(enc.encode('data: {"type":"response.output_text.delta","delta":"hi"}\n\n'));
        controller.enqueue(enc.encode('data: {"type":"response.output_item.done","item":{"type":"message"}}\n\n'));
        controller.enqueue(enc.encode('data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n'));
        controller.close();
      },
    });

    const { poolDir, mgr } = tempOpenAIPool(["gpt1"]);
    try {
      // 50ms keep-alive → the ~300ms silent gap should produce several pings.
      const config = loadConfig({ poolDir, accountsDir: join(poolDir, "accounts"), usageFile: join(poolDir, "usage.json"), streamKeepAliveMs: 50 });
      const fakeFetch = (async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
        new Response(upstream, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;

      const res = await proxyCodexMessages(
        { model: "gpt", messages: [{ role: "user", content: "hi" }], stream: true },
        mgr,
        config,
        new AbortController().signal,
        { id: "gpt", provider: "openai", upstreamModel: "gpt-5.2-codex" },
        {},
        fakeFetch,
      );
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let full = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        full += decoder.decode(value);
      }
      const pingCount = (full.match(/event: ping/g) ?? []).length;
      // The 300ms silent gap at a 50ms interval must yield multiple keep-alives.
      expect(pingCount).toBeGreaterThanOrEqual(2);
      expect(full).toContain("hi");
      expect(full).toContain("message_stop");
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("streaming: large non-content preamble before the first content frame doesn't buffer unbounded", async () => {
    // A misbehaving/slow upstream can trickle droppable events (e.g. dropped
    // reasoning items) for a long time before ever emitting content. The
    // early-buffer loop in streamCodexResponse must cap at 64 KiB (mirroring
    // anthropic.ts's prepareStreamingResponse) rather than buffer forever.
    // Build >64KB of `response.output_item.added` events whose item type is
    // "reasoning" -- these translate to zero frames (see codex-translate.ts
    // "reasoning etc." case) and so never "commit" the response.
    const padding = "x".repeat(2048);
    const preambleEvents: string[] = [];
    let preambleBytes = 0;
    while (preambleBytes < 70 * 1024) {
      const line = `data: {"type":"response.output_item.added","item":{"type":"reasoning","pad":"${padding}"}}`;
      preambleEvents.push(line, "");
      preambleBytes += line.length + 1;
    }
    const fullSse = [
      'data: {"type":"response.created","response":{"id":"r1"}}',
      "",
      ...preambleEvents,
      'data: {"type":"response.output_item.added","item":{"type":"message"}}',
      "",
      'data: {"type":"response.output_text.delta","delta":"Hi"}',
      "",
      'data: {"type":"response.output_item.done","item":{"type":"message"}}',
      "",
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":1}}}',
      "",
      "",
    ].join("\n");

    const { poolDir, mgr } = tempOpenAIPool(["gpt1"]);
    try {
      const config = loadConfig({ poolDir, accountsDir: join(poolDir, "accounts"), usageFile: join(poolDir, "usage.json") });
      const fakeFetch = (async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
        new Response(fullSse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })) as typeof fetch;

      const res = await Promise.race([
        proxyCodexMessages(
          { model: "gpt", messages: [{ role: "user", content: "hi" }], stream: true },
          mgr,
          config,
          new AbortController().signal,
          { id: "gpt", provider: "openai", upstreamModel: "gpt-5.2-codex" },
          {},
          fakeFetch,
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("proxyCodexMessages did not commit/return in time")), 5_000),
        ),
      ]);

      expect(res.status).toBe(200);
      expect(res.body).not.toBeNull();
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let full = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        full += decoder.decode(value);
      }
      expect(full).toContain('"text_delta"');
      expect(full).toContain("Hi");
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });


  for (const stream of [true, false]) {
    test(`${stream ? "streaming" : "non-stream"}: cached terminal input remains split for clients but records the full Codex input`, async () => {
      const { poolDir, mgr } = tempOpenAIPool(["gpt1"]);
      try {
        const config = loadConfig({ poolDir, accountsDir: join(poolDir, "accounts"), usageFile: join(poolDir, "usage.json") });
        const cachedUsageSse = [
          'data: {"type":"response.created","response":{"id":"cached"}}',
          "",
          'data: {"type":"response.completed","response":{"usage":{"input_tokens":100,"output_tokens":5,"input_tokens_details":{"cached_tokens":80}}}}',
          "",
          "",
        ].join("\n");
        const fakeFetch = (async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
          new Response(cachedUsageSse, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
        const res = await proxyCodexMessages(
          { model: "gpt", messages: [{ role: "user", content: "hi" }], stream },
          mgr,
          config,
          new AbortController().signal,
          { id: "gpt", provider: "openai", upstreamModel: "gpt-5.2-codex" },
          {},
          fakeFetch,
        );
        expect(res.status).toBe(200);

        const usage = stream
          ? JSON.parse((await res.text()).split("\n\n").find((block) => block.includes("message_delta"))!.split("data: ")[1]!).usage
          : (await res.json() as { usage: unknown }).usage;
        expect(usage).toMatchObject({ input_tokens: 20, cache_read_input_tokens: 80, output_tokens: 5 });

        const accountUsage = mgr.getAccount("gpt1").usage;
        expect(accountUsage.windowInputTokens).toBe(100);
        expect(accountUsage.totalInputTokens).toBe(100);
        expect(accountUsage.windowOutputTokens).toBe(5);
        expect(accountUsage.totalOutputTokens).toBe(5);
      } finally {
        rmSync(poolDir, { recursive: true, force: true });
      }
    });
  }

  for (const stream of [true, false]) {
    test(`${stream ? "streaming" : "non-stream"}: missing terminal input keeps prior context without recounting its carried baseline`, async () => {
      const { poolDir, mgr } = tempOpenAIPool(["gpt1"]);
      try {
        const config = loadConfig({ poolDir, accountsDir: join(poolDir, "accounts"), usageFile: join(poolDir, "usage.json") });
        const missingInputSse = [
          'data: {"type":"response.created","response":{"id":"missing-input"}}',
          "",
          'data: {"type":"response.completed","response":{"usage":{"output_tokens":5}}}',
          "",
          "",
        ].join("\n");
        let call = 0;
        const fakeFetch = (async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
          call += 1;
          return new Response(call === 2 ? missingInputSse : sse, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }) as typeof fetch;
        const route = { id: "gpt", provider: "openai" as const, upstreamModel: "gpt-5.2-codex" };
        const request = {
          model: "gpt",
          messages: [{ role: "user", content: "hi" }],
          metadata: { user_id: "session-a" },
          stream,
        };

        await (await proxyCodexMessages(request, mgr, config, new AbortController().signal, route, {}, fakeFetch)).text();
        await (await proxyCodexMessages(request, mgr, config, new AbortController().signal, route, {}, fakeFetch)).text();

        const accountUsage = mgr.getAccount("gpt1").usage;
        expect(accountUsage.windowInputTokens).toBe(3);
        expect(accountUsage.totalInputTokens).toBe(3);
        expect(accountUsage.windowOutputTokens).toBe(6);
        expect(accountUsage.totalOutputTokens).toBe(6);

        const next = await proxyCodexMessages(
          { ...request, stream: true }, mgr, config, new AbortController().signal, route, {}, fakeFetch,
        );
        const start = (await next.text()).split("\n\n").find((block) => block.includes("message_start"))!;
        expect(JSON.parse(start.split("data: ")[1]!).message.usage)
          .toEqual({ input_tokens: 4, output_tokens: 0 });
      } finally {
        rmSync(poolDir, { recursive: true, force: true });
      }
    });
  }

});

describe("proxyCodexMessages review fixes", () => {
  const codexConfig = (poolDir: string) =>
    loadConfig({ poolDir, accountsDir: join(poolDir, "accounts"), usageFile: join(poolDir, "usage.json"), sessionsFile: join(poolDir, "sessions.json") });
  const fetchBodies = (bodies: Array<string | ReadableStream<Uint8Array>>, onHit?: (init?: RequestInit) => void) => {
    let hits = 0;
    const fn = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      hits += 1;
      onHit?.(init);
      return new Response(bodies.shift() ?? "");
    }) as typeof fetch;
    return { fn, hits: () => hits };
  };
  const messages = [{ role: "user", content: "hi" }];

  test("streaming: an oversized response.created followed by a rate-limit error still reaches the client as an error frame", async () => {
    const { poolDir, mgr } = tempOpenAIPool(["gpt1"]);
    try {
      // The oversized line arrives in two reads: the proxy hits its prefix cap
      // mid-line (synthesizing message_start), then the line completes and the
      // rate-limit error follows in the same chunk.
      const head = `data: {"type":"response.created","response":{"id":"r1","instructions":"${"x".repeat(70 * 1024)}`;
      const tail = '"}}\n\ndata: {"type":"error","error":{"code":"rate_limit_exceeded","message":"You have hit your usage limit"}}\n\n';
      const upstream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode(head));
          setTimeout(() => {
            controller.enqueue(enc.encode(tail));
            controller.close();
          }, 20);
        },
      });
      const { fn } = fetchBodies([upstream]);
      const res = await proxyCodexMessages({ model: CODEX_ROUTE.id, messages, stream: true }, mgr, codexConfig(poolDir), new AbortController().signal, CODEX_ROUTE, {}, fn);
      const text = await res.text();
      expect(text).toContain("event: message_start");
      expect(text).toContain("event: error");
      expect(text).toContain("usage limit");
      expect(mgr.getAccount("gpt1").usage.rateLimitedUntil).toBeGreaterThan(Date.now());
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("streaming: a pre-commit rate-limit code fails over even when the message is generic", async () => {
    const { poolDir, mgr } = tempOpenAIPool(["gpt1", "gpt2"]);
    try {
      const limited = 'data: {"type":"response.failed","response":{"error":{"code":"rate_limit_exceeded","message":"Please try again later."}}}\n\n';
      const { fn, hits } = fetchBodies([limited, sse]);
      const res = await proxyCodexMessages({ model: CODEX_ROUTE.id, messages, stream: true }, mgr, codexConfig(poolDir), new AbortController().signal, CODEX_ROUTE, {}, fn);
      expect(res.status).toBe(200);
      expect(hits()).toBe(2);
      expect(mgr.getAccount("gpt1").usage.rateLimitedUntil).toBeGreaterThan(Date.now());
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("streaming: a pre-commit response.failed is a 502 like the non-stream path, not a 200 with a lone error frame", async () => {
    const { poolDir, mgr } = tempOpenAIPool(["gpt1"]);
    try {
      const failed = 'data: {"type":"response.failed","response":{"error":{"code":"server_error","message":"upstream failed"}}}\n\n';
      const { fn } = fetchBodies([failed]);
      const res = await proxyCodexMessages({ model: CODEX_ROUTE.id, messages, stream: true }, mgr, codexConfig(poolDir), new AbortController().signal, CODEX_ROUTE, {}, fn);
      expect(res.status).toBe(502);
      expect(res.headers.get(RETRYABLE_TRANSPORT_HEADER)).toBeNull();
      expect(await res.text()).toContain("upstream failed");
      expect(mgr.getAccount("gpt1").usage.lastError).toContain("upstream failed");
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("exhausted fetch transport failures are marked for cross-provider fallback", async () => {
    const { poolDir, mgr } = tempOpenAIPool(["gpt1", "gpt2"]);
    try {
      const fn = (async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
        throw new Error("network unavailable");
      }) as unknown as typeof fetch;
      const res = await proxyCodexMessages(
        { model: CODEX_ROUTE.id, messages }, mgr, codexConfig(poolDir),
        new AbortController().signal, CODEX_ROUTE, {}, fn,
      );
      expect(res.status).toBe(502);
      expect(res.headers.get(RETRYABLE_TRANSPORT_HEADER)).toBe("1");
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("a client abort before commit is not recorded against the account and is not retried elsewhere", async () => {
    const { poolDir, mgr } = tempOpenAIPool(["gpt1", "gpt2"]);
    try {
      const ac = new AbortController();
      let hitCount = 0;
      // Like real fetch: the body read rejects once the request signal aborts.
      const fn = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        hitCount += 1;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(enc.encode(": preamble\n\n"));
            init?.signal?.addEventListener("abort", () => controller.error(new DOMException("The operation was aborted.", "AbortError")));
          },
        });
        return new Response(body);
      }) as typeof fetch;
      const hits = () => hitCount;
      const pending = proxyCodexMessages({ model: CODEX_ROUTE.id, messages, stream: true }, mgr, codexConfig(poolDir), ac.signal, CODEX_ROUTE, {}, fn);
      setTimeout(() => ac.abort(), 30);
      const res = await pending;
      expect(res.status).not.toBe(200);
      expect(hits()).toBe(1);
      for (const name of ["gpt1", "gpt2"]) expect(mgr.getAccount(name).usage.lastError).toBeNull();
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("non-stream: a terminal event without response.created fails over like the streaming path", async () => {
    const { poolDir, mgr } = tempOpenAIPool(["gpt1", "gpt2"]);
    try {
      const noStart = 'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n';
      const { fn, hits } = fetchBodies([noStart, sse]);
      const res = await proxyCodexMessages({ model: CODEX_ROUTE.id, messages }, mgr, codexConfig(poolDir), new AbortController().signal, CODEX_ROUTE, {}, fn);
      expect(res.status).toBe(200);
      expect(hits()).toBe(2);
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });

  test("sessionAffinity: false serves without creating a session pin", async () => {
    const { poolDir, mgr } = tempOpenAIPool(["gpt1"]);
    try {
      const config = codexConfig(poolDir);
      const { fn } = fetchBodies([sse]);
      const body = { model: CODEX_ROUTE.id, messages, metadata: { user_id: "sess-no-pin" } };
      const res = await proxyCodexMessages(body, mgr, config, new AbortController().signal, CODEX_ROUTE, { sessionAffinity: false }, fn);
      expect(res.status).toBe(200);
      let pinned: Record<string, unknown> = {};
      try {
        pinned = JSON.parse(readFileSync(config.sessionsFile, "utf8")).sessions ?? {};
      } catch {
        // no ledger written
      }
      expect(Object.keys(pinned)).toHaveLength(0);
    } finally {
      rmSync(poolDir, { recursive: true, force: true });
    }
  });
});
