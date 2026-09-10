import { describe, expect, test } from "bun:test";
import { SseParser, fetchWithIdleTimeout, overloadBackoffMs, sleepWithAbort } from "./shared.ts";
import { UpstreamTransportError } from "./transport-error.ts";

describe("SseParser", () => {
  test("parses events split across chunks and across lines", () => {
    const events: { event: string; data: string }[] = [];
    const parser = new SseParser((e) => events.push(e));
    parser.push(new TextEncoder().encode("event: message_start\ndata: {\"a\":1}\n"));
    parser.push(new TextEncoder().encode("\n"));
    expect(events).toEqual([{ event: "message_start", data: '{"a":1}' }]);
  });

  test("throws instead of buffering forever when a single line never terminates", () => {
    const parser = new SseParser(() => {}, 1024);
    const chunk = new TextEncoder().encode("data: " + "x".repeat(2048));
    expect(() => parser.push(chunk)).toThrow(/exceeded/);
  });

  test("a legitimately long line under the cap is buffered fine until its newline arrives", () => {
    const events: { event: string; data: string }[] = [];
    const parser = new SseParser((e) => events.push(e), 1024);
    const longValue = "x".repeat(900);
    parser.push(new TextEncoder().encode(`data: ${longValue}`));
    parser.push(new TextEncoder().encode("\n\n"));
    expect(events).toEqual([{ event: "message", data: longValue }]);
  });
});

describe("overloadBackoffMs", () => {
  const opts = { baseMs: 100, maxDelayMs: 800 };

  test("full-jitter grows per attempt but never exceeds the exponential ceiling", () => {
    // rand()=1 returns the ceiling exactly: base * 2**attempt, capped at maxDelayMs.
    const one = () => 1;
    expect(overloadBackoffMs(0, opts, undefined, one)).toBe(100);
    expect(overloadBackoffMs(1, opts, undefined, one)).toBe(200);
    expect(overloadBackoffMs(2, opts, undefined, one)).toBe(400);
    expect(overloadBackoffMs(3, opts, undefined, one)).toBe(800);
    expect(overloadBackoffMs(4, opts, undefined, one)).toBe(800); // capped
  });

  test("jitter floor is 0", () => {
    expect(overloadBackoffMs(3, opts, undefined, () => 0)).toBe(0);
  });

  test("a future resetAt takes precedence, capped at maxDelayMs", () => {
    const now = () => 1_000_000;
    // 300ms in the future, under the cap → use it.
    expect(overloadBackoffMs(0, opts, 1_000_300, () => 1, now)).toBe(300);
    // 5s in the future, over the 800ms cap → clamp to cap.
    expect(overloadBackoffMs(0, opts, 1_005_000, () => 1, now)).toBe(800);
  });

  test("a past resetAt is ignored in favor of jitter", () => {
    const now = () => 1_000_000;
    expect(overloadBackoffMs(1, opts, 999_000, () => 1, now)).toBe(200);
  });

  test("zeroed delays collapse to 0 (test-mode fast path)", () => {
    expect(overloadBackoffMs(5, { baseMs: 0, maxDelayMs: 0 }, undefined, () => 1)).toBe(0);
  });
});

describe("fetchWithIdleTimeout", () => {
  test("normalizes an inference fetch failure as a headers transport error", async () => {
    const cause = Object.assign(new Error("socket reset"), { code: "ECONNRESET", headers: { authorization: "secret" } });
    const fetchFn = Object.assign(async () => { throw cause; }, { preconnect() {} }) as typeof fetch;

    let error: unknown;
    try {
      await fetchWithIdleTimeout("https://example.invalid", {}, 100, fetchFn);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(UpstreamTransportError);
    expect((error as Error).message).toContain("headers");
    expect((error as Error).message).toContain("ECONNRESET");
    expect((error as Error).message).not.toContain("secret");
    expect((error as Error).cause).toBe(cause);
  });

  test("forwards one normalized body failure to the reader and failure signal", async () => {
    const cause = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
    const upstream = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.error(cause); },
    }));
    const fetchFn = Object.assign(async () => upstream, { preconnect() {} }) as typeof fetch;
    const { response, cleanup, failureSignal } = await fetchWithIdleTimeout("https://example.invalid", {}, 100, fetchFn);

    try {
      let error: unknown;
      try {
        await response.text();
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(UpstreamTransportError);
      expect((error as Error).message).toContain("body");
      expect((error as Error).message).toContain("ECONNRESET");
      expect(failureSignal.aborted).toBe(true);
      expect(failureSignal.reason).toBe(error);
      expect((error as Error).cause).toBe(cause);
    } finally {
      cleanup();
    }
  });

  test("preserves an external abort reason", async () => {
    const client = new AbortController();
    const reason = new DOMException("Client left", "AbortError");
    const fetchFn = Object.assign(async (_input: string | URL, init?: RequestInit) => {
      await new Promise<never>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }));
      throw new Error("unreachable");
    }, { preconnect() {} }) as typeof fetch;
    const request = fetchWithIdleTimeout("https://example.invalid", { signal: client.signal }, 100, fetchFn);
    client.abort(reason);

    await expect(request).rejects.toBe(reason);
  });
});

describe("sleepWithAbort", () => {
  test("resolves true after the delay elapses", async () => {
    const ac = new AbortController();
    expect(await sleepWithAbort(5, ac.signal)).toBe(true);
  });

  test("resolves false immediately when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await sleepWithAbort(10_000, ac.signal)).toBe(false);
  });

  test("resolves false when aborted mid-sleep", async () => {
    const ac = new AbortController();
    const p = sleepWithAbort(10_000, ac.signal);
    ac.abort();
    expect(await p).toBe(false);
  });
});
