/**
 * Helpers shared across upstream proxy backends (Anthropic direct, Codex).
 */

import type { Config } from "../config.ts";

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

export function makeAbort(config: Config, signal: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    },
  };
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
