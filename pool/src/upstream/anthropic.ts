/**
 * Direct Anthropic Messages proxy.
 *
 * This backend avoids spawning `claude --print`: it selects a pooled account,
 * refreshes that account's Claude Code OAuth token when needed, forwards the
 * caller's /v1/messages JSON to Anthropic, and streams Anthropic's SSE bytes
 * back unchanged.
 */

import type { Config } from "../config.ts";
import { AccountManager } from "../accounts/manager.ts";
import type { Account, RateLimitSnapshot, RateLimitWindow } from "../accounts/types.ts";
import { modelFamilyOf, sortRateLimitWindows, windowModelOf } from "../accounts/types.ts";
import type { CliUsage } from "../subprocess/types.ts";
import {
  anthropicError,
  makeAbort,
  SseParser,
  parseJson,
  asObject,
  objectProp,
  stringProp,
  numberProp,
  isRateLimit as isRateLimitShared,
  retryAfterMs,
} from "./shared.ts";
import type { SseEvent } from "./shared.ts";
import { accessTokenFor } from "./oauth-token.ts";
import { maybeRefreshUsage } from "./usage.ts";

interface ProxyHooks {
  onFailover?: (from: string, to: string) => void;
}

interface RetryReason {
  status: number;
  type: string;
  message: string;
  rateLimited: boolean;
  resetAt?: number;
}

type AttemptResult =
  | { kind: "response"; response: Response }
  | { kind: "retry"; reason: RetryReason }
  | { kind: "terminal"; response: Response };

interface FetchResult {
  response: Response;
  cleanup: () => void;
}

type ByteReadResult = { done: true; value?: undefined } | { done: false; value: Uint8Array };

interface ByteReader {
  read(): Promise<ByteReadResult>;
  cancel(reason?: unknown): Promise<void>;
}

export async function proxyAnthropicMessages(
  body: unknown,
  incomingHeaders: Headers,
  mgr: AccountManager,
  config: Config,
  signal: AbortSignal,
  hooks: ProxyHooks = {},
): Promise<Response> {
  const sessionKey = extractSessionKey(body);
  // Model-scoped usage windows (e.g. Fable's own allowance) only bind for
  // requests that actually target that model, so routing needs to know it.
  const modelFamily = modelFamilyOf(stringProp(asObject(body), "model"));
  const first = mgr.pick(sessionKey, undefined, "anthropic", modelFamily);
  if (!first) return anthropicError(503, "overloaded_error", noAccountMessage(mgr));

  // Off the hot path: refresh this account's usage for the NEXT routing decision.
  // Fire-and-forget — the current request routes immediately on existing data.
  void maybeRefreshUsage(first, mgr, config).catch(() => {});

  const bodyText = JSON.stringify(body ?? {});
  const tried = new Set<string>();
  let account: Account | null = first;
  let lastRetry: RetryReason | null = null;

  while (account) {
    tried.add(account.name);
    const attempt = await tryAccount(account, bodyText, incomingHeaders, mgr, config, signal);

    if (attempt.kind === "response") {
      if (sessionKey) mgr.setAffinity(sessionKey, account.name);
      return attempt.response;
    }

    if (attempt.kind === "terminal") return attempt.response;

    lastRetry = attempt.reason;
    const next = mgr.pick(sessionKey, tried, "anthropic", modelFamily);
    if (!next) break;
    hooks.onFailover?.(account.name, next.name);
    account = next;
  }

  return anthropicError(
    lastRetry?.status ?? 503,
    lastRetry?.type ?? "overloaded_error",
    lastRetry?.message ?? noAccountMessage(mgr),
  );
}

async function tryAccount(
  account: Account,
  bodyText: string,
  incomingHeaders: Headers,
  mgr: AccountManager,
  config: Config,
  signal: AbortSignal,
): Promise<AttemptResult> {
  let upstream: FetchResult;
  try {
    upstream = await fetchWithAccount(account, bodyText, incomingHeaders, mgr, config, signal, false);
  } catch (err) {
    const message = (err as Error).message;
    mgr.recordError(account.name, message);
    return { kind: "retry", reason: authOrNetworkReason(message) };
  }

  if (upstream.response.status === 401) {
    upstream.cleanup();
    try {
      upstream = await fetchWithAccount(account, bodyText, incomingHeaders, mgr, config, signal, true);
    } catch (err) {
      const message = (err as Error).message;
      mgr.recordError(account.name, message);
      return { kind: "retry", reason: authOrNetworkReason(message) };
    }
  }

  if (hasRateLimitHeaders(upstream.response.headers)) {
    mgr.recordRateLimitSnapshot(account.name, parseRateLimitSnapshot(upstream.response.headers));
  }

  const streamRequested = bodyRequestsStream(bodyText);
  const contentType = upstream.response.headers.get("content-type") ?? "";
  const isSse = streamRequested || contentType.toLowerCase().includes("text/event-stream");

  if (!upstream.response.ok) {
    const text = await upstream.response.text().catch(() => "");
    upstream.cleanup();
    const reason = classifyHttpError(upstream.response.status, upstream.response.headers, text);
    if (reason.rateLimited) {
      mgr.markRateLimited(account.name, reason.resetAt);
      return { kind: "retry", reason };
    }
    mgr.recordError(account.name, reason.message);
    return {
      kind: "terminal",
      response: responseFromUpstreamText(text, upstream.response, account.name),
    };
  }

  if (isSse && upstream.response.body) {
    return prepareStreamingResponse(upstream, account, mgr);
  }

  const text = await upstream.response.text();
  upstream.cleanup();
  recordJsonUsage(text, mgr, account.name);
  return {
    kind: "response",
    response: responseFromUpstreamText(text, upstream.response, account.name),
  };
}

async function fetchWithAccount(
  account: Account,
  bodyText: string,
  incomingHeaders: Headers,
  mgr: AccountManager,
  config: Config,
  signal: AbortSignal,
  forceRefresh: boolean,
): Promise<FetchResult> {
  const token = await accessTokenFor(account, mgr, config, forceRefresh);
  const abort = makeAbort(config, signal);
  try {
    const response = await fetch(messagesUrl(config.anthropicApiBaseUrl), {
      method: "POST",
      headers: upstreamHeaders(incomingHeaders, token),
      body: bodyText,
      signal: abort.signal,
    });
    return { response, cleanup: abort.cleanup };
  } catch (err) {
    abort.cleanup();
    if (signal.aborted) throw new Error("Request aborted by client");
    throw err;
  }
}

async function prepareStreamingResponse(
  upstream: FetchResult,
  account: Account,
  mgr: AccountManager,
): Promise<AttemptResult> {
  const body = upstream.response.body;
  if (!body) {
    upstream.cleanup();
    mgr.recordError(account.name, "Anthropic returned an empty streaming body");
    return {
      kind: "terminal",
      response: anthropicError(502, "api_error", "Anthropic returned an empty streaming body"),
    };
  }

  const reader = body.getReader() as ByteReader;
  const prefix: Uint8Array[] = [];
  let prefixBytes = 0;
  const tap = new StreamUsageTap(mgr, account.name);

  try {
    while (!tap.committed && !tap.initialRateLimit && prefixBytes < 64 * 1024) {
      const { value, done } = await reader.read();
      if (done) {
        tap.finish();
        upstream.cleanup();
        return {
          kind: "response",
          response: new Response(bytesStream(prefix), {
            status: upstream.response.status,
            statusText: upstream.response.statusText,
            headers: responseHeaders(upstream.response.headers, account.name),
          }),
        };
      }
      if (!value) continue;
      prefix.push(value);
      prefixBytes += value.byteLength;
      tap.push(value);
    }

    if (tap.initialRateLimit) {
      await reader.cancel().catch(() => {});
      upstream.cleanup();
      mgr.markRateLimited(account.name, tap.initialRateLimit.resetAt);
      return { kind: "retry", reason: tap.initialRateLimit };
    }

    const stream = streamWithTap(reader, prefix, tap, upstream.cleanup);
    return {
      kind: "response",
      response: new Response(stream, {
        status: upstream.response.status,
        statusText: upstream.response.statusText,
        headers: responseHeaders(upstream.response.headers, account.name),
      }),
    };
  } catch (err) {
    upstream.cleanup();
    mgr.recordError(account.name, (err as Error).message);
    return {
      kind: "terminal",
      response: anthropicError(502, "api_error", `Streaming proxy error: ${(err as Error).message}`),
    };
  }
}

function streamWithTap(
  reader: ByteReader,
  prefix: Uint8Array[],
  tap: StreamUsageTap,
  cleanup: () => void,
): ReadableStream<Uint8Array> {
  let prefixIndex = 0;
  let finished = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    tap.finish();
    cleanup();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (prefixIndex < prefix.length) {
        controller.enqueue(prefix[prefixIndex++]!);
        return;
      }
      try {
        const { value, done } = await reader.read();
        if (done) {
          finish();
          controller.close();
          return;
        }
        if (value) {
          tap.push(value);
          controller.enqueue(value);
        }
      } catch (err) {
        tap.error((err as Error).message);
        cleanup();
        controller.error(err);
      }
    },
    async cancel(reason) {
      tap.cancel();
      cleanup();
      await reader.cancel(reason).catch(() => {});
    },
  });
}

class StreamUsageTap {
  committed = false;
  initialRateLimit: RetryReason | null = null;

  private parser = new SseParser((event) => this.onEvent(event));
  private usage: CliUsage = { input_tokens: 0, output_tokens: 0 };
  private sawError = false;
  private finalError: RetryReason | null = null;
  private done = false;

  constructor(
    private mgr: AccountManager,
    private accountName: string,
  ) {}

  push(chunk: Uint8Array): void {
    this.parser.push(chunk);
  }

  finish(): void {
    if (this.done) return;
    this.done = true;
    this.parser.end();
    if (this.sawError && this.finalError) {
      if (this.finalError.rateLimited) this.mgr.markRateLimited(this.accountName, this.finalError.resetAt);
      else this.mgr.recordError(this.accountName, this.finalError.message);
      return;
    }
    this.mgr.recordSuccess(this.accountName, this.usage, 0);
  }

  error(message: string): void {
    if (this.done) return;
    this.done = true;
    this.mgr.recordError(this.accountName, message);
  }

  cancel(): void {
    this.done = true;
  }

  private onEvent(event: SseEvent): void {
    const data = parseJson(event.data);
    const type = stringProp(data, "type") ?? event.event;

    if (type === "ping") return;

    if (type === "message_start") {
      const message = objectProp(data, "message");
      this.mergeUsage(objectProp(message, "usage"));
    } else if (type === "message_delta") {
      this.mergeUsage(objectProp(data, "usage"));
    } else if (type === "error") {
      const reason = classifySseError(data);
      if (!this.committed && reason.rateLimited) {
        this.initialRateLimit = reason;
        return;
      }
      this.sawError = true;
      this.finalError = reason;
    }

    if (!this.committed) this.committed = true;
  }

  private mergeUsage(usage: Record<string, unknown> | null): void {
    if (!usage) return;
    this.usage.input_tokens = numberProp(usage, "input_tokens") ?? this.usage.input_tokens;
    this.usage.output_tokens = numberProp(usage, "output_tokens") ?? this.usage.output_tokens;
    const cacheCreation = numberProp(usage, "cache_creation_input_tokens");
    const cacheRead = numberProp(usage, "cache_read_input_tokens");
    if (cacheCreation != null) this.usage.cache_creation_input_tokens = cacheCreation;
    if (cacheRead != null) this.usage.cache_read_input_tokens = cacheRead;
  }
}

function recordJsonUsage(text: string, mgr: AccountManager, accountName: string): void {
  const json = parseJson(text);
  const usage = objectProp(json, "usage");
  mgr.recordSuccess(
    accountName,
    {
      input_tokens: numberProp(usage, "input_tokens") ?? 0,
      output_tokens: numberProp(usage, "output_tokens") ?? 0,
      cache_creation_input_tokens: numberProp(usage, "cache_creation_input_tokens") ?? 0,
      cache_read_input_tokens: numberProp(usage, "cache_read_input_tokens") ?? 0,
    },
    0,
  );
}

function classifyHttpError(status: number, headers: Headers, text: string): RetryReason {
  const json = parseJson(text);
  const error = objectProp(json, "error");
  const type = stringProp(error, "type") ?? (status === 429 ? "rate_limit_error" : "api_error");
  const message = stringProp(error, "message") ?? (text.slice(0, 500) || `Anthropic API returned HTTP ${status}`);
  const rateLimited = status === 429 || isRateLimit(type, message);
  return { status, type, message, rateLimited, resetAt: resetAtFromHeaders(headers) };
}

function classifySseError(data: Record<string, unknown> | null): RetryReason {
  const error = objectProp(data, "error");
  const type = stringProp(error, "type") ?? "api_error";
  const message = stringProp(error, "message") ?? "Anthropic streaming error";
  const rateLimited = isRateLimit(type, message);
  return { status: rateLimited ? 429 : 502, type, message, rateLimited };
}

function isRateLimit(type: string, message: string): boolean {
  return isRateLimitShared(`${type}\n${message}`);
}

const UNIFIED_HEADER_PREFIX = "anthropic-ratelimit-unified-";

function hasRateLimitHeaders(headers: Headers): boolean {
  // Claude subscription (OAuth) traffic reports a unified rolling-window model.
  for (const name of headers.keys()) {
    if (name.startsWith(UNIFIED_HEADER_PREFIX)) return true;
  }
  return false;
}

/**
 * Reads every `anthropic-ratelimit-unified-*` header — present on direct
 * subscription (OAuth) responses. Windows are parsed generically from
 * `...unified-<key>-{status,utilization,reset}` triples, so beyond the
 * account-wide "5h"/"7d" windows this also captures any model-scoped windows
 * Anthropic sends (e.g. a separate Fable allowance as "7d-fable") without a
 * code change. Reset headers are unix seconds.
 */
function parseRateLimitSnapshot(headers: Headers): RateLimitSnapshot {
  let unifiedStatus: string | null = null;
  const windows = new Map<string, RateLimitWindow>();

  for (const [name, raw] of headers) {
    if (!name.startsWith(UNIFIED_HEADER_PREFIX)) continue;
    const rest = name.slice(UNIFIED_HEADER_PREFIX.length);
    if (rest === "status") {
      unifiedStatus = raw;
      continue;
    }
    const match = /^(.+)-(status|utilization|reset)$/.exec(rest);
    if (!match) continue;
    const key = match[1]!;
    let w = windows.get(key);
    if (!w) {
      w = { key, model: windowModelOf(key), status: null, utilization: null, reset: null };
      windows.set(key, w);
    }
    if (match[2] === "status") {
      w.status = raw;
    } else if (match[2] === "utilization") {
      const n = Number.parseFloat(raw);
      if (Number.isFinite(n)) w.utilization = n;
    } else {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n)) w.reset = n * 1000;
    }
  }

  return { unifiedStatus, windows: sortRateLimitWindows([...windows.values()]), updatedAt: Date.now() };
}

function resetAtFromHeaders(headers: Headers): number | undefined {
  const viaRetryAfter = retryAfterMs(headers);
  if (viaRetryAfter !== undefined) return viaRetryAfter;

  for (const name of [
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-reset",
    "anthropic-ratelimit-input-tokens-reset",
    "anthropic-ratelimit-output-tokens-reset",
  ]) {
    const value = headers.get(name);
    if (!value) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function authOrNetworkReason(message: string): RetryReason {
  return { status: 401, type: "authentication_error", message, rateLimited: false };
}

function upstreamHeaders(incoming: Headers, token: string): Headers {
  const headers = new Headers(incoming);

  for (const name of HOP_BY_HOP_REQUEST_HEADERS) {
    headers.delete(name);
  }

  // The caller's proxy credential is local to this pool. Upstream auth must be
  // the selected Claude account's OAuth bearer token.
  headers.set("authorization", `Bearer ${token}`);
  headers.delete("x-api-key");
  return headers;
}

const HOP_BY_HOP_REQUEST_HEADERS = [
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

function responseFromUpstreamText(text: string, upstream: Response, accountName: string): Response {
  return new Response(text, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders(upstream.headers, accountName),
  });
}

function responseHeaders(source: Headers, accountName: string): Headers {
  const headers = new Headers(source);
  for (const name of [
    "connection",
    "content-encoding",
    "content-length",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]) {
    headers.delete(name);
  }
  headers.set("X-Pool-Account", accountName);
  return headers;
}

function bytesStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function extractSessionKey(body: unknown): string | undefined {
  const metadata = objectProp(asObject(body), "metadata");
  const userId = stringProp(metadata, "user_id");
  return userId || undefined;
}

function bodyRequestsStream(bodyText: string): boolean {
  const body = parseJson(bodyText);
  return Boolean(body?.stream);
}

function noAccountMessage(mgr: AccountManager): string {
  const total = mgr.listAccounts().length;
  return total === 0
    ? "No Claude accounts configured. Add one with: bun run src/index.ts accounts login <name>"
    : "All Claude accounts are currently unavailable (logged out or rate limited). Check the dashboard.";
}

function messagesUrl(baseUrl: string): string {
  const clean = baseUrl.replace(/\/+$/, "");
  if (clean.endsWith("/v1/messages")) return clean;
  return clean.endsWith("/v1") ? `${clean}/messages` : `${clean}/v1/messages`;
}


