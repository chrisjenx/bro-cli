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
  fetchWithIdleTimeout,
  SseParser,
  parseJson,
  asObject,
  objectProp,
  stringProp,
  numberProp,
  isRateLimit as isRateLimitShared,
  retryAfterMs,
  overloadBackoffMs,
  sleepWithAbort,
  anthropicUrl,
} from "./shared.ts";
import type { SseEvent } from "./shared.ts";
import { accessTokenFor } from "./oauth-token.ts";
import { stripCodexThinking } from "./codex-translate.ts";
import { maybeRefreshUsage } from "./usage.ts";

interface ProxyHooks {
  onFailover?: (from: string, to: string) => void;
  /**
   * false: neither read nor refresh the session's account pin. Used for
   * side requests (auto-mode classifier) that share the session id but must
   * not steer which provider/account the session's real turns land on.
   */
  sessionAffinity?: boolean;
  slotWaitBudget?: { remainingMs: number };
}

interface RetryReason {
  status: number;
  type: string;
  message: string;
  rateLimited: boolean;
  /** HTTP 429 that is NOT an account quota hit (no unified rate-limit headers,
   * no retry-after, no quota wording) — Anthropic rejecting this particular
   * request. Same on every account, so never bench or fail over. */
  rejected?: boolean;
  /** Transient upstream overload (529/500/503 or SSE overloaded_error) — retry same account with backoff. */
  transient: boolean;
  /** Anthropic refused the account itself (HTTP 403) — sideline it and fail over. */
  accessDenied?: boolean;
  resetAt?: number;
  /** Raw upstream error body + headers, captured so surfaceOverload can replay them verbatim (HTTP path only). */
  bodyText?: string;
  headers?: Headers;
}

type AttemptResult =
  | { kind: "response"; response: Response }
  | { kind: "retry"; reason: RetryReason }
  | { kind: "terminal"; response: Response };

interface FetchResult {
  response: Response;
  cleanup: () => void;
  failureSignal: AbortSignal;
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
  const sessionKey = hooks.sessionAffinity === false ? undefined : extractSessionKey(body);
  // Model-scoped usage windows (e.g. Fable's own allowance) only bind for
  // requests that actually target that model, so routing needs to know it.
  const modelFamily = modelFamilyOf(stringProp(asObject(body), "model"));
  // Strip only thinking signatures synthesized by our Codex translation.
  const bodyText = JSON.stringify(stripCodexThinking(body) ?? {});
  const streamRequested = Boolean(asObject(body)?.stream);
  const tried = new Set<string>();
  const budget = hooks.slotWaitBudget ?? { remainingMs: config.inFlightWaitMs };
  let previous: string | undefined;
  let lastRetry: RetryReason | null = null;

  while (true) {
    const lease = await mgr.reserveInFlight(sessionKey, tried, "anthropic", modelFamily, signal, budget);
    if (signal.aborted) { lease?.release(); return anthropicError(499, "request_aborted", "Request aborted by client"); }
    if (!lease) break;
    const { account, release } = lease;
    let streaming = false;
    let attempt: AttemptResult;
    try {
      if (previous) hooks.onFailover?.(previous, account.name);
      tried.add(account.name);
      void maybeRefreshUsage(account, mgr, config).catch(() => {});
      attempt = await tryAccount(account, bodyText, incomingHeaders, mgr, config, signal, streamRequested, () => {
        streaming = true;
        return release;
      });
    } finally { if (!streaming) release(); }
    if (signal.aborted) { release(); return anthropicError(499, "request_aborted", "Request aborted by client"); }
    if (attempt.kind === "response") {
      if (sessionKey) mgr.setAffinity(sessionKey, account.name);
      return attempt.response;
    }
    if (attempt.kind === "terminal") return attempt.response;
    lastRetry = attempt.reason;
    previous = account.name;
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
  streamRequested: boolean,
  onStream: () => () => void,
): Promise<AttemptResult> {
  const opts = { baseMs: config.overloadRetryBaseMs, maxDelayMs: config.overloadRetryMaxDelayMs };
  // Backoff budget spent (or client gone): record the overload once, at surface
  // time, and hand the caller the faithful upstream error.
  const surface = (reason: RetryReason): AttemptResult => {
    if (signal.aborted) return { kind: "terminal", response: anthropicError(499, "request_aborted", "Request aborted by client") };
    mgr.recordError(account.name, reason.message);
    return { kind: "terminal", response: surfaceOverload(reason, account.name) };
  };
  let attempt = 0;
  while (true) {
    const result = await attemptOnce(account, bodyText, incomingHeaders, mgr, config, signal, streamRequested, onStream);
    // Success, terminal, or a 429 rate-limit retry all pass straight up; only a
    // transient overload retry is handled here (same-account backoff).
    if (result.kind !== "retry" || !result.reason.transient) return result;
    const reason = result.reason;

    if (attempt >= config.overloadRetryMax) return surface(reason);

    const delay = overloadBackoffMs(attempt, opts, reason.resetAt);
    if (config.logFailover) {
      console.log(
        `  ⏳ overloaded (${reason.status}) on "${account.name}" — retry ${attempt + 1}/${config.overloadRetryMax} in ~${Math.round(delay)}ms`,
      );
    }
    // Client disconnected mid-backoff — stop and surface the last overload.
    if (!(await sleepWithAbort(delay, signal))) return surface(reason);
    attempt += 1;
  }
}

async function attemptOnce(
  account: Account,
  bodyText: string,
  incomingHeaders: Headers,
  mgr: AccountManager,
  config: Config,
  signal: AbortSignal,
  streamRequested: boolean,
  onStream: () => () => void,
): Promise<AttemptResult> {
  let upstream: FetchResult;
  try {
    upstream = await fetchWithAccount(account, bodyText, incomingHeaders, mgr, config, signal, false);
  } catch (err) {
    if (signal.aborted) return { kind: "terminal", response: anthropicError(499, "request_aborted", "Request aborted by client") };
    const message = (err as Error).message;
    mgr.recordError(account.name, message);
    return { kind: "retry", reason: authOrNetworkReason(message) };
  }

  if (upstream.response.status === 401) {
    upstream.cleanup();
    try {
      upstream = await fetchWithAccount(account, bodyText, incomingHeaders, mgr, config, signal, true);
    } catch (err) {
      if (signal.aborted) return { kind: "terminal", response: anthropicError(499, "request_aborted", "Request aborted by client") };
      const message = (err as Error).message;
      mgr.recordError(account.name, message);
      return { kind: "retry", reason: authOrNetworkReason(message) };
    }
  }

  if (hasRateLimitHeaders(upstream.response.headers)) {
    mgr.recordRateLimitSnapshot(account.name, parseRateLimitSnapshot(upstream.response.headers));
  }

  const contentType = upstream.response.headers.get("content-type") ?? "";
  const isSse = streamRequested || contentType.toLowerCase().includes("text/event-stream");

  if (!upstream.response.ok) {
    const text = await upstream.response.text().catch(() => "");
    upstream.cleanup();
    if (signal.aborted) return { kind: "terminal", response: anthropicError(499, "request_aborted", "Request aborted by client") };
    const reason = classifyHttpError(upstream.response.status, upstream.response.headers, text);
    if (reason.rejected) {
      // Benching here would sideline every account for rateLimitCooldownMs on
      // a request Anthropic refuses regardless of account. Hand it straight
      // back; the marker header stops the cross-provider hop as well.
      console.warn(
        `  ⚠ upstream rejected a request on "${account.name}" (429 without rate-limit headers) — ` +
          `system prompt: ${JSON.stringify(systemPromptPreview(bodyText))}`,
      );
      return {
        kind: "terminal",
        response: responseFromUpstreamText(text, upstream.response, account.name, { [UPSTREAM_REJECTED_HEADER]: "1" }),
      };
    }
    if (reason.rateLimited) {
      mgr.markRateLimited(account.name, reason.resetAt);
      return { kind: "retry", reason };
    }
    if (reason.transient) {
      // Overload/5xx: let tryAccount's backoff loop retry the SAME account.
      // recordError is deferred to surface time so a healthy account isn't
      // spammed with "Overloaded" on every capacity blip.
      return { kind: "retry", reason };
    }
    if (reason.accessDenied) {
      mgr.markAccessDenied(account.name, reason.message);
      return { kind: "retry", reason };
    }
    mgr.recordError(account.name, reason.message);
    return {
      kind: "terminal",
      response: responseFromUpstreamText(text, upstream.response, account.name),
    };
  }

  if (isSse && upstream.response.body) {
    return prepareStreamingResponse(upstream, account, mgr, signal, onStream);
  }

  let text: string;
  try {
    text = await upstream.response.text();
  } catch (err) {
    if (signal.aborted) return { kind: "terminal", response: anthropicError(499, "request_aborted", "Request aborted by client") };
    const message = (err as Error).message;
    mgr.recordError(account.name, message);
    return { kind: "terminal", response: anthropicError(502, "api_error", message) };
  } finally { upstream.cleanup(); }
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
    const upstream = await fetchWithIdleTimeout(messagesUrl(config.anthropicApiBaseUrl), {
      method: "POST",
      headers: upstreamHeaders(incomingHeaders, token),
      body: bodyText,
      signal: abort.signal,
    }, config.anthropicIdleTimeoutMs);
    return { response: upstream.response, cleanup: () => { upstream.cleanup(); abort.cleanup(); }, failureSignal: upstream.failureSignal };
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
  signal: AbortSignal,
  onStream: () => () => void,
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
    while (!tap.committed && !tap.initialRateLimit && !tap.initialTransient && prefixBytes < 64 * 1024) {
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

    if (tap.initialTransient) {
      await reader.cancel().catch(() => {});
      upstream.cleanup();
      // Overload is not the account's fault — do not sideline or recordError
      // here; tryAccount's backoff loop retries the same account.
      return { kind: "retry", reason: tap.initialTransient };
    }

    const release = onStream();
    const stream = streamWithTap(reader, prefix, tap, () => { upstream.cleanup(); release(); }, signal, upstream.failureSignal);
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
    if (signal.aborted) return { kind: "terminal", response: anthropicError(499, "request_aborted", "Request aborted by client") };
    // Nothing reached the client yet (the prefix is still buffered), so a
    // transport fault here — an idle-watchdog abort on an upstream that sent
    // headers and then went silent, say — is worth another account rather than
    // a hard 502. Mirrors the Codex path's readFailed().
    const message = (err as Error).message;
    mgr.recordError(account.name, message);
    return {
      kind: "retry",
      reason: {
        status: 502,
        type: "api_error",
        message: `Streaming proxy error: ${message}`,
        rateLimited: false,
        transient: false,
      },
    };
  }
}

function streamWithTap(
  reader: ByteReader,
  prefix: Uint8Array[],
  tap: StreamUsageTap,
  cleanup: () => void,
  signal: AbortSignal,
  failureSignal: AbortSignal,
): ReadableStream<Uint8Array> {
  let prefixIndex = 0;
  let finished = false;
  let output: ReadableStreamDefaultController<Uint8Array>;
  const stop = () => {
    failureSignal.removeEventListener("abort", onFailure);
    cleanup();
  };
  const fail = (error: unknown) => {
    if (finished) return;
    finished = true;
    if (signal.aborted) tap.cancel();
    else tap.error(error instanceof Error ? error.message : String(error));
    stop();
    output.error(error);
  };
  const onFailure = () => fail(failureSignal.reason);

  return new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller;
      failureSignal.addEventListener("abort", onFailure, { once: true });
      if (failureSignal.aborted) onFailure();
    },
    async pull(controller) {
      if (finished) return;
      if (prefixIndex < prefix.length) {
        controller.enqueue(prefix[prefixIndex++]!);
        return;
      }
      try {
        const { value, done } = await reader.read();
        if (finished) return;
        if (done) {
          tap.finish();
          finished = true;
          stop();
          controller.close();
        } else if (value) {
          tap.push(value);
          controller.enqueue(value);
        }
      } catch (err) { fail(err); }
    },
    async cancel(reason) {
      if (finished) return;
      finished = true;
      tap.cancel();
      stop();
      await reader.cancel(reason).catch(() => {});
    },
  });
}

class StreamUsageTap {
  committed = false;
  initialRateLimit: RetryReason | null = null;
  initialTransient: RetryReason | null = null;

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
      if (!this.committed && reason.transient) {
        this.initialTransient = reason;
        return; // do NOT fall through to `this.committed = true`
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

/** Marks a pass-through 429 that is a per-request refusal, not pool exhaustion. */
export const UPSTREAM_REJECTED_HEADER = "x-pool-upstream-rejected";

/** First ~80 chars of the request's system prompt, for the rejection log. */
function systemPromptPreview(bodyText: string): string {
  const body = parseJson(bodyText);
  const system = body?.system;
  const text =
    typeof system === "string"
      ? system
      : Array.isArray(system)
        ? (stringProp(asObject(system[0]), "text") ?? "")
        : "";
  return text.length > 80 ? `${text.slice(0, 80)}…` : text || "(none)";
}

function classifyHttpError(status: number, headers: Headers, text: string): RetryReason {
  const json = parseJson(text);
  const error = objectProp(json, "error");
  const type = stringProp(error, "type") ?? (status === 429 ? "rate_limit_error" : "api_error");
  const message = stringProp(error, "message") ?? (text.slice(0, 500) || `Anthropic API returned HTTP ${status}`);
  // A quota 429 carries the unified window headers (or at least retry-after)
  // or says so in the body. Anthropic also answers 429 {"message":"Error"}
  // with none of those for requests it refuses outright (e.g. OAuth traffic
  // without Claude Code's system prompt); that is per-request, not per-account.
  // The type alone proves nothing: the refusal is also "rate_limit_error".
  const quotaSignal = hasRateLimitHeaders(headers) || headers.has("retry-after") || isRateLimitShared(message);
  const rateLimited = status === 429 ? quotaSignal : isRateLimit(type, message);
  const rejected = status === 429 && !rateLimited;
  const transient = !rateLimited && (status === 529 || status === 500 || status === 503);
  const accessDenied = !rateLimited && status === 403;
  return {
    status,
    type,
    message,
    rateLimited,
    rejected,
    transient,
    accessDenied,
    resetAt: resetAtFromHeaders(headers),
    bodyText: text,
    headers,
  };
}

function classifySseError(data: Record<string, unknown> | null): RetryReason {
  const error = objectProp(data, "error");
  const type = stringProp(error, "type") ?? "api_error";
  const message = stringProp(error, "message") ?? "Anthropic streaming error";
  const rateLimited = isRateLimit(type, message);
  const transient = !rateLimited && type === "overloaded_error";
  // Overload as a stream event must surface as 529 (not 502) so it stays in
  // CROSS_PROVIDER_RETRY_STATUSES and the client sees the status it handles.
  const status = rateLimited ? 429 : transient ? 529 : 502;
  return { status, type, message, rateLimited, transient };
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
  return { status: 401, type: "authentication_error", message, rateLimited: false, transient: false };
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

function responseFromUpstreamText(
  text: string,
  upstream: Response,
  accountName: string,
  extraHeaders: Record<string, string> = {},
): Response {
  const headers = responseHeaders(upstream.headers, accountName);
  for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  return new Response(text, { status: upstream.status, statusText: upstream.statusText, headers });
}

/**
 * Build the client-facing response when overload survives the backoff budget.
 * Replays the real upstream error as closely as possible: the captured upstream
 * headers go through the same `responseHeaders` path as every other proxied
 * response (hop-by-hop stripped, `X-Pool-Account` set), so the SDK's
 * `retry-after`/`request-id` and any other diagnostic headers survive. For the
 * SSE-origin case (no HTTP headers/body) it synthesizes the Anthropic error
 * shape and derives `retry-after` from any known reset time.
 */
function surfaceOverload(reason: RetryReason, accountName: string): Response {
  const headers = reason.headers
    ? responseHeaders(reason.headers, accountName)
    : new Headers({ "content-type": "application/json", "X-Pool-Account": accountName });
  if (!headers.get("retry-after")) {
    const retryAfter = retryAfterHeaderFrom(reason.resetAt);
    if (retryAfter) headers.set("retry-after", retryAfter);
  }
  const body =
    reason.bodyText ??
    JSON.stringify({ type: "error", error: { type: reason.type, message: reason.message } });
  return new Response(body, { status: reason.status, headers });
}

function retryAfterHeaderFrom(resetAt: number | undefined): string | undefined {
  if (resetAt === undefined) return undefined;
  const secs = Math.ceil((resetAt - Date.now()) / 1000);
  return secs > 0 ? String(secs) : undefined;
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

export function extractSessionKey(body: unknown): string | undefined {
  const metadata = objectProp(asObject(body), "metadata");
  const userId = stringProp(metadata, "user_id");
  return userId || undefined;
}

function noAccountMessage(mgr: AccountManager): string {
  const total = mgr.listAccounts().length;
  return total === 0
    ? "No Claude accounts configured. Add one with: bun run src/index.ts accounts login <name>"
    : "All Claude accounts are currently unavailable (logged out or rate limited). Check the dashboard.";
}

function messagesUrl(baseUrl: string): string {
  return anthropicUrl(baseUrl, "/v1/messages");
}


