/**
 * Helpers shared across upstream proxy backends (Anthropic direct, Codex).
 */

import type { Config } from "../config.ts";
import { UpstreamTransportError } from "./transport-error.ts";

export const RETRYABLE_TRANSPORT_HEADER = "X-Pool-Retryable-Transport";

export interface ProxyHooks {
  onFailover?: (from: string, to: string) => void;
  /** false: neither read nor refresh the session's account pin. */
  sessionAffinity?: boolean;
  slotWaitBudget?: { remainingMs: number };
}

export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Hard ceiling on a single buffered (not-yet-newline-terminated) SSE line.
 * Codex's `response.created` alone can legitimately run past the caller's
 * 64 KiB "give up and commit" threshold (it echoes the full instructions +
 * tool schemas), so this must stay well above that — it exists only to bound
 * memory against a misbehaving/malicious upstream that never sends a newline.
 */
const DEFAULT_MAX_BUFFER_CHARS = 8 * 1024 * 1024;

export class SseParser {
  private decoder = new TextDecoder();
  private buffer = "";
  private eventName = "";
  private data: string[] = [];

  constructor(
    private onEvent: (event: SseEvent) => void,
    private maxBufferChars = DEFAULT_MAX_BUFFER_CHARS,
  ) {}

  push(chunk: Uint8Array): void {
    this.pushText(this.decoder.decode(chunk, { stream: true }));
  }

  /**
   * Flushes the decoder at EOF. An event without its terminating blank line
   * is discarded by design: callers treat it as a truncated stream, not a
   * complete event.
   */
  end(): void {
    const rest = this.decoder.decode();
    if (rest) this.pushText(rest);
  }

  private pushText(text: string): void {
    this.buffer += text;
    while (true) {
      const i = this.buffer.indexOf("\n");
      if (i < 0) break;
      const raw = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 1);
      this.line(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
    }
    if (this.buffer.length > this.maxBufferChars) {
      throw new Error(`SSE line exceeded ${this.maxBufferChars} bytes without a terminator`);
    }
  }

  private line(line: string): void {
    if (line === "") {
      this.dispatch();
      return;
    }
    if (line.startsWith(":")) return;

    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") this.eventName = value;
    else if (field === "data") this.data.push(value);
  }

  private dispatch(): void {
    if (!this.eventName && this.data.length === 0) return;
    this.onEvent({ event: this.eventName || "message", data: this.data.join("\n") });
    this.eventName = "";
    this.data = [];
  }
}

export function anthropicError(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function clientAbortedResponse(): Response {
  return anthropicError(499, "request_aborted", "Request aborted by client");
}

export function makeAbort(config: Config, signal: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Upstream request timeout", "TimeoutError")),
    config.requestTimeoutMs,
  );
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    },
  };
}

function transportFailure(cause: unknown, phase: "headers" | "body"): UpstreamTransportError {
  return cause instanceof UpstreamTransportError ? cause : new UpstreamTransportError(cause, phase);
}

/** Bun 1.3.14 ignores numeric fetch timeout values. Disable its implicit socket
 * timer and bound header waiting and each demanded body read explicitly instead.
 * Bytes pass through unchanged. Backpressure with no read pending is not idle.
 */
export async function fetchWithIdleTimeout(
  input: string | URL,
  init: RequestInit,
  idleMs: number,
  fetchFn: typeof fetch = fetch,
  // The uncomposed caller signal when init.signal also carries a pool deadline.
  clientSignal: AbortSignal | undefined = init.signal ?? undefined,
): Promise<{ response: Response; cleanup: () => void; failureSignal: AbortSignal }> {
  const abort = new AbortController();
  // Error-only notification: intentional cleanup/EOF must not report failure.
  const failure = new AbortController();
  const incoming = init.signal;
  const classifyFailure = (cause: unknown, phase: "headers" | "body") =>
    clientSignal?.aborted ? clientSignal.reason : transportFailure(cause, phase);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel"> | undefined;
  let output: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  const clear = () => { clearTimeout(timer); timer = undefined; };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clear();
    incoming?.removeEventListener("abort", onIncomingAbort);
    abort.signal.removeEventListener("abort", onAbort);
    abort.abort();
    void reader?.cancel().catch(() => {});
  };
  const onAbort = () => {
    if (closed) return;
    const reason = classifyFailure(abort.signal.reason, "body");
    output?.error(reason);
    failure.abort(reason);
    cleanup();
  };
  const onIncomingAbort = () => abort.abort(incoming?.reason);
  const arm = () => {
    clear();
    timer = setTimeout(() => abort.abort(new DOMException("Upstream idle timeout", "TimeoutError")), idleMs);
  };
  abort.signal.addEventListener("abort", onAbort, { once: true });
  incoming?.addEventListener("abort", onIncomingAbort, { once: true });
  if (incoming?.aborted) onIncomingAbort();
  try {
    abort.signal.throwIfAborted();
    arm();
    const response = await fetchFn(input, { ...init, signal: abort.signal, timeout: false } as RequestInit & { timeout: false });
    clear();
    abort.signal.throwIfAborted();
    if (!response.body) { cleanup(); return { response, cleanup, failureSignal: failure.signal }; }
    reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { output = controller; },
      async pull(controller) {
        if (closed) return;
        arm();
        try {
          while (!closed) {
            const part = await reader!.read();
            if (closed) return;
            if (part.done) { cleanup(); controller.close(); return; }
            // Empty chunks are not byte progress and must not re-arm the timer.
            if (part.value.byteLength === 0) continue;
            clear();
            controller.enqueue(part.value);
            return;
          }
        } catch (err) {
          if (closed) return;
          const reason = classifyFailure(err, "body");
          controller.error(reason);
          failure.abort(reason);
          cleanup();
        }
      },
      cancel() { cleanup(); },
    }, { highWaterMark: 0 });
    return { response: new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }), cleanup, failureSignal: failure.signal };
  } catch (err) {
    const reason = classifyFailure(abort.signal.aborted ? abort.signal.reason : err, "headers");
    cleanup();
    throw reason;
  }
}

/** Headers for a Claude Code OAuth request (usage, model list, …). One place to
 * bump the beta version. */
export function oauthHeaders(token: string, userAgent: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "oauth-2025-04-20",
    "user-agent": userAgent,
  };
}

/**
 * Joins an Anthropic API path onto the configured base URL, tolerating a base
 * that already ends in `/v1` or in the path itself (e.g. an LLM gateway that
 * is configured as https://gw.example/anthropic/v1). Never `new URL(path, base)`,
 * which would drop such a prefix.
 */
export function anthropicUrl(baseUrl: string, path: `/v1/${string}`): string {
  const clean = baseUrl.replace(/\/+$/, "");
  if (clean.endsWith(path)) return clean;
  return clean.endsWith("/v1") ? `${clean}${path.slice(3)}` : `${clean}${path}`;
}

export function parseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return asObject(parsed);
  } catch {
    return null;
  }
}

export function asObject(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function objectProp(value: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  return asObject(value?.[key]);
}

export function stringProp(value: Record<string, unknown> | null, key: string): string | undefined {
  const raw = value?.[key];
  return typeof raw === "string" ? raw : undefined;
}

export function numberProp(value: Record<string, unknown> | null, key: string): number | undefined {
  const raw = value?.[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

/**
 * Phrase-sniffs an error type/message for rate-limit language. Shared by
 * anthropic.ts and openai-codex.ts so both backends agree on what counts as
 * "rate limited" (their upstreams don't always agree on error shapes).
 */
export function isRateLimit(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("rate_limit") ||
    lower.includes("rate limit") ||
    lower.includes("usage limit") ||
    lower.includes("limit reached") ||
    lower.includes("too many requests")
  );
}

/**
 * Parses the standard `retry-after` header: an integer number of seconds, or
 * (per HTTP spec) an HTTP-date. Returns an absolute epoch-ms reset time.
 */
export function retryAfterMs(headers: Headers): number | undefined {
  const retryAfter = headers.get("retry-after");
  if (!retryAfter) return undefined;
  const seconds = Number.parseInt(retryAfter, 10);
  if (Number.isFinite(seconds)) return Date.now() + seconds * 1000;
  const parsed = Date.parse(retryAfter);
  if (Number.isFinite(parsed)) return parsed;
  return undefined;
}

export interface OverloadBackoffOpts {
  /** Base delay, doubled per attempt. */
  baseMs: number;
  /** Hard cap on any single sleep. */
  maxDelayMs: number;
}

/**
 * Delay before the next same-account retry of a transient overload.
 * A future `resetAt` (from Retry-After/reset headers) wins, capped at
 * `maxDelayMs` so a huge value can't stall the request. Otherwise full jitter
 * over the exponential ceiling `min(maxDelayMs, baseMs * 2**attempt)`.
 * `rand`/`now` are injectable for deterministic tests.
 */
export function overloadBackoffMs(
  attempt: number,
  opts: OverloadBackoffOpts,
  resetAt?: number,
  rand: () => number = Math.random,
  now: () => number = Date.now,
): number {
  if (resetAt !== undefined) {
    const wait = resetAt - now();
    if (wait > 0) return Math.min(wait, opts.maxDelayMs);
  }
  const ceiling = Math.min(opts.maxDelayMs, opts.baseMs * 2 ** attempt);
  return rand() * ceiling;
}

/**
 * Sleep `ms`, but resolve `false` immediately (or as soon as possible) if
 * `signal` is/gets aborted — so a client disconnect cuts the backoff short.
 * Resolves `true` when the delay elapses normally. Cleans up its timer and
 * listener on either outcome.
 */
export function sleepWithAbort(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
