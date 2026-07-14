import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig } from "../config.ts";
import { AccountManager } from "../accounts/manager.ts";
import { OPENAI_CREDS_FILENAME } from "../accounts/types.ts";
import { describeCodexError, parseCodexRateLimitSnapshot, proxyCodexMessages, resetAtFromCodexHeaders } from "./openai-codex.ts";

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

  test("exhausted primary window reads as rejected", () => {
    const h = new Headers({ "x-codex-primary-used-percent": "100" });
    const s = parseCodexRateLimitSnapshot(h);
    expect(s.windows.find((w) => w.key === "5h")?.status).toBe("rejected");
    expect(s.unifiedStatus).toBe("rejected");
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
});

describe("proxyCodexMessages", () => {
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
});
