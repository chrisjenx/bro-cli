import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig } from "../config.ts";
import { AccountManager } from "../accounts/manager.ts";
import { OPENAI_CREDS_FILENAME } from "../accounts/types.ts";
import { parseCodexRateLimitSnapshot, proxyCodexMessages, resetAtFromCodexHeaders } from "./openai-codex.ts";

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
  const config = loadConfig({ poolDir, accountsDir, usageFile: join(poolDir, "usage.json") });
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
    expect(s.fiveHourUtilization).toBeCloseTo(0.425);
    expect(s.fiveHourStatus).toBe("allowed");
    expect(s.fiveHourReset).toBe(inOneHour * 1000);
    expect(s.sevenDayUtilization).toBeCloseTo(0.1);
    expect(s.sevenDayReset).toBe(inOneDay * 1000);
    expect(s.unifiedStatus).toBe("allowed");
  });

  test("exhausted primary window reads as rejected", () => {
    const h = new Headers({ "x-codex-primary-used-percent": "100" });
    const s = parseCodexRateLimitSnapshot(h);
    expect(s.fiveHourStatus).toBe("rejected");
    expect(s.unifiedStatus).toBe("rejected");
  });

  test("no headers → all-null snapshot", () => {
    const s = parseCodexRateLimitSnapshot(new Headers());
    expect(s.fiveHourUtilization).toBeNull();
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

describe("proxyCodexMessages", () => {
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
      expect(mgr.getAccount("gpt1").usage.rateLimitStatus?.fiveHourUtilization).toBeCloseTo(0.05);
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
