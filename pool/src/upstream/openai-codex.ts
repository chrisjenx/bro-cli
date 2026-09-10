/**
 * Codex (ChatGPT-subscription) Responses-API proxy.
 *
 * Selects a pooled OpenAI account, refreshes its Codex OAuth token when
 * needed, translates the caller's Anthropic-shaped /v1/messages body into a
 * Codex Responses request, forwards it, and translates the Codex SSE stream
 * back into Anthropic Messages SSE frames (or a folded JSON message for
 * non-streaming callers).
 */

import type { Config } from "../config.ts";
import { AccountManager } from "../accounts/manager.ts";
import type { Account, OpenAIOauthCreds, RateLimitSnapshot, RateLimitWindow } from "../accounts/types.ts";
import { supportedEffortsFor, type ModelRoute } from "../models.ts";
import { refreshOpenAIToken } from "../accounts/openai-oauth.ts";
import { anthropicToCodexRequest, CodexToAnthropicStream } from "./codex-translate.ts";
import { durationToWindowKey } from "./codex-windows.ts";
import { CODEX_RESPONSES_URL, CODEX_ORIGINATOR, CODEX_ACCOUNT_ID_HEADER, CODEX_RATE_LIMIT_HEADERS } from "./codex-constants.ts";
import { anthropicError, clientAbortedResponse, makeAbort, fetchWithIdleTimeout, SseParser, isRateLimit, retryAfterMs, parseJson, stringProp, objectProp, RETRYABLE_TRANSPORT_HEADER } from "./shared.ts";
import type { ProxyHooks } from "./shared.ts";

interface RetryReason {
  status: number;
  type: string;
  message: string;
  rateLimited: boolean;
  resetAt?: number;
  /** No bytes reached the caller and the upstream inference transport failed. */
  transport?: boolean;
}

type AttemptResult =
  | { kind: "response"; response: Response }
  | { kind: "retry"; reason: RetryReason }
  | { kind: "terminal"; response: Response };

const refreshLocks = new Map<string, Promise<OpenAIOauthCreds>>();

/** Anthropic SSE keep-alive frame, emitted during no-content phases (e.g. reasoning). */
const PING_FRAME = `event: ping\ndata: ${JSON.stringify({ type: "ping" })}\n\n`;
const MAX_CONTEXT_USAGE_ENTRIES = 1_000;

class ContextUsageCache {
  private values = new Map<string, number>();

  constructor(private maxEntries = MAX_CONTEXT_USAGE_ENTRIES) {}

  get(sessionKey: string | undefined, routeId: string): number {
    if (!sessionKey) return 0;
    const key = JSON.stringify([sessionKey, routeId]);
    const value = this.values.get(key);
    if (value === undefined) return 0;
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  set(sessionKey: string | undefined, routeId: string, tokens: number): void {
    if (!sessionKey || !Number.isFinite(tokens) || tokens < 0) return;
    const key = JSON.stringify([sessionKey, routeId]);
    this.values.delete(key);
    this.values.set(key, Math.floor(tokens));
    while (this.values.size > this.maxEntries) {
      const oldest = this.values.keys().next().value;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
  }
}

const contextUsageByManager = new WeakMap<AccountManager, ContextUsageCache>();

function contextUsageFor(mgr: AccountManager): ContextUsageCache {
  let cache = contextUsageByManager.get(mgr);
  if (!cache) {
    cache = new ContextUsageCache();
    contextUsageByManager.set(mgr, cache);
  }
  return cache;
}

/** Keep account totals on Codex's full input count without changing client usage. */
function recordCodexSuccess(mgr: AccountManager, accountName: string, translator: CodexToAnthropicStream): void {
  const usage = {
    ...translator.usage,
    input_tokens: translator.hasTerminalUsage
      ? translator.usage.input_tokens + (translator.usage.cache_read_input_tokens ?? 0)
      : 0,
  };
  mgr.recordSuccess(accountName, usage, 0);
}

export async function proxyCodexMessages(
  body: unknown,
  mgr: AccountManager,
  config: Config,
  signal: AbortSignal,
  route: ModelRoute,
  hooks: ProxyHooks = {},
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  const anthropicBody = (body ?? {}) as Record<string, unknown>;
  const metadata = anthropicBody.metadata as Record<string, unknown> | undefined;
  const sessionKey =
    hooks.sessionAffinity !== false && metadata && typeof metadata.user_id === "string" && metadata.user_id
      ? metadata.user_id
      : undefined;
  const streamRequested = anthropicBody.stream === true;
  const codexBody = anthropicToCodexRequest(
    anthropicBody,
    route.upstreamModel,
    { effortMap: route.effortMap, supportedEfforts: supportedEffortsFor(route) },
  );

  const tried = new Set<string>();
  const budget = hooks.slotWaitBudget ?? { remainingMs: config.inFlightWaitMs };
  let previous: string | undefined;
  let lastRetry: RetryReason | null = null;

  while (true) {
    const lease = await mgr.reserveInFlight(sessionKey, tried, "openai", null, signal, budget);
    if (signal.aborted) { lease?.release(); return clientAbortedResponse(); }
    if (!lease) break;
    const { account, release } = lease;
    let streaming = false;
    let attempt: AttemptResult;
    try {
      if (previous) hooks.onFailover?.(previous, account.name);
      tried.add(account.name);
      attempt = await tryCodexAccount(
        account, codexBody, route, mgr, config, signal, streamRequested, fetchFn, sessionKey,
        () => { streaming = true; return release; },
      );
    } finally { if (!streaming) release(); }
    if (signal.aborted) { release(); return clientAbortedResponse(); }
    if (attempt.kind === "response") {
      if (sessionKey) mgr.setAffinity(sessionKey, account.name, "openai");
      return attempt.response;
    }
    if (attempt.kind === "terminal") return attempt.response;
    lastRetry = attempt.reason;
    previous = account.name;
  }

  const response = anthropicError(
    lastRetry?.status ?? 503,
    lastRetry?.type ?? "overloaded_error",
    lastRetry?.message ?? noOpenAIAccountMessage(mgr),
  );
  if (lastRetry?.transport) response.headers.set(RETRYABLE_TRANSPORT_HEADER, "1");
  return response;
}

/** Response for a request whose client disconnected mid-flight; nobody reads it. */
function authReason(message: string, status = 401): RetryReason {
  return { status, type: "authentication_error", message, rateLimited: false };
}

async function tryCodexAccount(
  account: Account,
  codexBody: Record<string, unknown>,
  route: ModelRoute,
  mgr: AccountManager,
  config: Config,
  signal: AbortSignal,
  streamRequested: boolean,
  fetchFn: typeof fetch,
  sessionKey: string | undefined,
  onStream: () => () => void,
): Promise<AttemptResult> {
  let creds: OpenAIOauthCreds | null;
  try {
    creds = await ensureFreshToken(account.name, mgr, config, false, fetchFn);
  } catch (err) {
    if (signal.aborted) return { kind: "terminal", response: clientAbortedResponse() };
    const message = (err as Error).message;
    mgr.recordError(account.name, message);
    return { kind: "retry", reason: authReason(message) };
  }
  if (signal.aborted) return { kind: "terminal", response: clientAbortedResponse() };
  if (!creds?.accessToken) {
    const message = `Account "${account.name}" has no OpenAI access token`;
    mgr.recordError(account.name, message);
    return { kind: "retry", reason: authReason(message) };
  }

  let res: Response;
  let abortCleanup: () => void;
  let upstreamFailure: AbortSignal;
  try {
    const attempt = await fetchCodex(creds, codexBody, config, signal, fetchFn);
    res = attempt.response;
    abortCleanup = attempt.cleanup;
    upstreamFailure = attempt.failureSignal;
  } catch (err) {
    if (signal.aborted) return { kind: "terminal", response: clientAbortedResponse() };
    const message = (err as Error).message;
    mgr.recordError(account.name, message);
    return { kind: "retry", reason: { status: 502, type: "api_error", message, rateLimited: false, transport: true } };
  }

  if (res.status === 401 || res.status === 403) {
    abortCleanup();
    try {
      creds = await ensureFreshToken(account.name, mgr, config, true, fetchFn);
    } catch (err) {
      if (signal.aborted) return { kind: "terminal", response: clientAbortedResponse() };
      const message = (err as Error).message;
      mgr.recordError(account.name, message);
      return { kind: "retry", reason: authReason(message) };
    }
    if (!creds?.accessToken) {
      const message = `Account "${account.name}" has no OpenAI access token after refresh`;
      mgr.recordError(account.name, message);
      return { kind: "retry", reason: authReason(message) };
    }
    try {
      const retryAttempt = await fetchCodex(creds, codexBody, config, signal, fetchFn);
      res = retryAttempt.response;
      abortCleanup = retryAttempt.cleanup;
      upstreamFailure = retryAttempt.failureSignal;
    } catch (err) {
      if (signal.aborted) return { kind: "terminal", response: clientAbortedResponse() };
      const message = (err as Error).message;
      mgr.recordError(account.name, message);
      return { kind: "retry", reason: { status: 502, type: "api_error", message, rateLimited: false, transport: true } };
    }
    if (res.status === 401 || res.status === 403) {
      abortCleanup();
      const message = `Account "${account.name}" is not authorized against the Codex backend`;
      mgr.recordError(account.name, message);
      return { kind: "retry", reason: authReason(message, res.status) };
    }
  }

  // Skip an empty snapshot: a response with no x-codex-* headers (e.g. a
  // codex-exec-style turn) would otherwise wipe the account's known 5h/7d
  // windows via replace mode. Preserve the prior windows instead.
  const codexRateLimit = parseCodexRateLimitSnapshot(res.headers, { rejected: res.status === 429 });
  if (codexRateLimit.windows.length > 0) {
    mgr.recordRateLimitSnapshot(account.name, codexRateLimit, true);
  }

  if (res.status === 429) {
    const text = await res.text().catch(() => "");
    abortCleanup();
    if (signal.aborted) return { kind: "terminal", response: clientAbortedResponse() };
    const resetAt = resetAtFromCodexHeaders(res.headers);
    mgr.markRateLimited(account.name, resetAt);
    return {
      kind: "retry",
      reason: {
        status: 429,
        type: "rate_limit_error",
        message: text.slice(0, 500) || "Codex backend rate limited this account",
        rateLimited: true,
        resetAt,
      },
    };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    abortCleanup();
    if (signal.aborted) return { kind: "terminal", response: clientAbortedResponse() };
    // A non-OK that isn't auth (401/403) or rate limit (429) is a request-shape
    // or backend rejection — deterministic across accounts, so it's terminal
    // rather than a failover trigger. Render the backend's own reason into one
    // legible line instead of passing the raw JSON body through to the client.
    const message = describeCodexError(res.status, text, account.name);
    mgr.recordError(account.name, message);
    return { kind: "terminal", response: anthropicError(res.status, "api_error", message) };
  }

  if (!res.body) {
    abortCleanup();
    const message = "Codex backend returned an empty streaming body";
    mgr.recordError(account.name, message);
    return { kind: "terminal", response: anthropicError(502, "api_error", message) };
  }

  return streamCodexResponse(
    res.body,
    account,
    mgr,
    route,
    streamRequested,
    abortCleanup,
    config,
    sessionKey,
    signal,
    onStream,
    upstreamFailure,
  );
}

async function fetchCodex(
  creds: OpenAIOauthCreds,
  codexBody: Record<string, unknown>,
  config: Config,
  signal: AbortSignal,
  fetchFn: typeof fetch,
): Promise<{ response: Response; cleanup: () => void; failureSignal: AbortSignal }> {
  const abort = makeAbort(config, signal);
  try {
    const upstream = await fetchWithIdleTimeout(CODEX_RESPONSES_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${creds.accessToken}`,
        [CODEX_ACCOUNT_ID_HEADER]: creds.accountId ?? "",
        originator: CODEX_ORIGINATOR,
        accept: "text/event-stream",
      },
      body: JSON.stringify(codexBody),
      signal: abort.signal,
    }, config.codexIdleTimeoutMs, fetchFn, signal);
    return { response: upstream.response, cleanup: () => { upstream.cleanup(); abort.cleanup(); }, failureSignal: upstream.failureSignal };
  } catch (err) {
    abort.cleanup();
    if (signal.aborted) throw new Error("Request aborted by client");
    throw err;
  }
}

export async function ensureFreshToken(
  accountName: string,
  mgr: AccountManager,
  config: Config,
  forceRefresh: boolean,
  fetchFn: typeof fetch,
): Promise<OpenAIOauthCreds | null> {
  const creds = mgr.getOpenAICreds(accountName);
  if (!creds?.accessToken) return creds;
  if (!forceRefresh && tokenFresh(creds, config)) return creds;
  if (!creds.refreshToken) {
    if (!forceRefresh) return creds;
    throw new Error(`Account "${accountName}" cannot refresh OpenAI token; re-run accounts login`);
  }

  const existing = refreshLocks.get(accountName);
  if (existing) return existing;

  const refresh = refreshOpenAIToken(creds, fetchFn, config.tokenRefreshTimeoutMs)
    .then((refreshed) => {
      mgr.updateOpenAICreds(accountName, refreshed);
      return refreshed;
    })
    .finally(() => {
      refreshLocks.delete(accountName);
    });
  refreshLocks.set(accountName, refresh);
  return refresh;
}

function tokenFresh(creds: OpenAIOauthCreds, config: Config): boolean {
  if (!creds.expiresAt) return true;
  return creds.expiresAt - Date.now() > config.tokenRefreshSkewMs;
}

async function streamCodexResponse(
  body: ReadableStream<Uint8Array>,
  account: Account,
  mgr: AccountManager,
  route: ModelRoute,
  streamRequested: boolean,
  cleanup: () => void,
  config: Config,
  sessionKey: string | undefined,
  signal: AbortSignal,
  onStream: () => () => void,
  failureSignal: AbortSignal,
): Promise<AttemptResult> {
  const contextUsage = contextUsageFor(mgr);
  const translator = new CodexToAnthropicStream(
    route.id,
    contextUsage.get(sessionKey, route.id),
  );
  const recordTerminalContext = () => {
    if (translator.sawError || !translator.hasTerminalUsage) return;
    contextUsage.set(
      sessionKey,
      route.id,
      translator.usage.input_tokens
        + (translator.usage.cache_read_input_tokens ?? 0)
        + translator.usage.output_tokens,
    );
  };
  const reader = body.getReader();
  const encoder = new TextEncoder();

  // One teardown for every exit path: stop the keep-alive (a no-op before the
  // timer exists), drop the upstream reader (a terminal protocol event
  // completes the response; waiting for EOF can hang even after all output
  // has arrived), then release the abort/timeout wiring.
  let closed = false;
  let releaseStream: (() => void) | undefined;
  let outputController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let keepAliveTimer: ReturnType<typeof setInterval> | undefined;
  const teardown = (reason?: unknown) => {
    if (closed) return;
    closed = true;
    failureSignal.removeEventListener("abort", onFailure);
    releaseStream?.();
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    void reader.cancel(reason).catch(() => {});
    cleanup();
  };
  // Deadlines and disconnects must tear down even when downstream never pulls.
  const onFailure = () => {
    if (closed) return;
    const error = failureSignal.reason;
    teardown(error);
    // The client hung up, which is what aborted the upstream in the first
    // place: it isn't the account's fault, and there is nobody left to tell.
    // Erroring the response stream after its socket has gone leaves Bun with
    // a rejected promise no one can handle — a fatal unhandled rejection that
    // takes the whole pool down, not just this request.
    if (signal.aborted) return;
    mgr.recordError(account.name, error instanceof Error ? error.message : String(error));
    outputController?.error(error);
  };
  const failRetry = (message: string, transport: boolean): AttemptResult => {
    teardown();
    mgr.recordError(account.name, message);
    return { kind: "retry", reason: { status: 502, type: "api_error", message, rateLimited: false, transport } };
  };
  /**
   * Settles a response that failed before anything reached the client. Both
   * the streaming pre-commit path and the non-stream path land here so they
   * agree: an upstream rate limit sidelines the account and retries; any
   * other upstream-reported error is terminal (the next account would refuse
   * it just the same); a synthesized failure (truncation, terminal event
   * without message_start) is a transport fault worth another account.
   */
  const failedBeforeCommit = (upstreamError: { type: string; message: string } | null): AttemptResult => {
    translator.finish();
    if (upstreamError && isRateLimit(`${upstreamError.type} ${upstreamError.message}`)) {
      teardown();
      mgr.markRateLimited(account.name);
      return {
        kind: "retry",
        reason: { status: 429, type: upstreamError.type, message: upstreamError.message, rateLimited: true },
      };
    }
    if (upstreamError) {
      teardown();
      mgr.recordError(account.name, upstreamError.message);
      return { kind: "terminal", response: anthropicError(502, upstreamError.type, upstreamError.message) };
    }
    return failRetry(
      translator.sawError?.message ?? "Codex stream ended before any content",
      !translator.hasTerminalEvent,
    );
  };
  const readFailed = (err: unknown): AttemptResult => {
    // The client hung up: not the account's fault, and nobody to retry for.
    if (signal.aborted) {
      teardown();
      return { kind: "terminal", response: clientAbortedResponse() };
    }
    return failRetry((err as Error).message, true);
  };

  if (streamRequested) {
    const pending: string[] = [];
    let committed = false;

    const parser = new SseParser((event) => {
      const frames = translator.handleEvent(event);
      // An upstream error before anything was sent is settled by
      // failedBeforeCommit (retry / terminal 502), never streamed as a lone
      // error frame inside a 200.
      if (translator.sawError && !committed) return;
      // gpt-5.5's reasoning-summary events (and other droppable preamble)
      // translate to no frames. Once the stream has started, emit a ping in
      // their place so the client sees keep-alive activity rather than silence
      // during a long reasoning phase — mirroring Anthropic's own ping events.
      if (frames.length === 0 && translator.hasStarted && !translator.hasTerminalEvent) {
        pending.push(PING_FRAME);
      }
      if (frames.length > 0) committed = true;
      pending.push(...frames);
    });

    // Drain until we can decide: either content committed, the response ended
    // (terminal event or EOF), or we've buffered enough non-content preamble
    // (64 KiB, matching anthropic.ts's prefix cap) that we should commit and
    // stream the rest through normally rather than risk unbounded buffering
    // against a misbehaving upstream.
    let upstreamDone = false;
    let prefixBytes = 0;
    const responseDone = () => upstreamDone || translator.hasTerminalEvent;
    const readUpstream = async () => {
      const { value, done: d } = await reader.read();
      if (d) {
        upstreamDone = true;
        parser.end();
      } else {
        parser.push(value);
      }
      return value;
    };
    try {
      while (!committed && !responseDone() && prefixBytes < 64 * 1024) {
        const value = await readUpstream();
        if (value) prefixBytes += value.byteLength;
      }
    } catch (err) {
      return readFailed(err);
    }

    if (!committed && responseDone()) return failedBeforeCommit(translator.sawError);

    // We hit the byte cap without the translator producing a single frame. That
    // happens when Codex's first event (response.created, which echoes the full
    // instructions + tool schemas) is a single SSE line larger than the cap:
    // the parser can't complete it, so no message_start was emitted and the
    // client would see a 200 with no opening frame and hang. Synthesize the
    // message_start envelope now so the stream always opens promptly; the real
    // response.created becomes a no-op once it finally parses in pull(). This
    // counts as committed: a later upstream error must reach the client as an
    // error frame rather than be swallowed by the pre-commit guard.
    if (!committed) {
      pending.push(...translator.forceMessageStart());
      committed = true;
    }

    const prefix = pending.splice(0, pending.length);
    // Wall-clock of the last byte sent to the client, and an independent
    // keep-alive timer. The keep-alive must NOT be driven from pull(): Bun.serve
    // does not re-invoke pull() while it is blocked awaiting a silent upstream
    // read, so a pull-based ping never fires over real HTTP during a model's
    // thinking gap or a slow oversized response.created — the client is starved
    // and its inactivity timeout fires. An interval enqueues pings regardless of
    // pull cadence, matching Anthropic's own periodic ping.
    let lastSentAt = Date.now();
    const flush = (controller: ReadableStreamDefaultController<Uint8Array>, frames: string[]) => {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      if (frames.length > 0) lastSentAt = Date.now();
    };
    const finalize = (controller: ReadableStreamDefaultController<Uint8Array>) => {
      flush(controller, [...pending.splice(0, pending.length), ...translator.finish()]);
      if (translator.sawError) {
        // Bytes are already committed, so the error frame is the client's
        // answer; still sideline the account like the non-stream path does.
        if (isRateLimit(`${translator.sawError.type} ${translator.sawError.message}`)) mgr.markRateLimited(account.name);
        else mgr.recordError(account.name, translator.sawError.message);
      } else {
        recordTerminalContext();
        recordCodexSuccess(mgr, account.name, translator);
      }
      teardown();
      controller.close();
    };
    releaseStream = onStream();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        outputController = controller;
        failureSignal.addEventListener("abort", onFailure, { once: true });
        if (failureSignal.aborted) { onFailure(); return; }
        flush(controller, prefix);
        lastSentAt = Date.now();
        keepAliveTimer = setInterval(() => {
          if (closed) return;
          if (Date.now() - lastSentAt >= config.streamKeepAliveMs) {
            try {
              controller.enqueue(encoder.encode(PING_FRAME));
              lastSentAt = Date.now();
            } catch {
              // Stream already closed/errored — stop pinging.
              teardown();
            }
          }
        }, config.streamKeepAliveMs);
      },
      async pull(controller) {
        try {
          if (!responseDone()) {
            await readUpstream();
            if (closed) return;
          }
          if (responseDone()) {
            finalize(controller);
          } else {
            flush(controller, pending.splice(0, pending.length));
          }
        } catch (err) {
          if (closed) return;
          teardown();
          // Same rule as onFailure(): once the client is gone there is nobody
          // to blame and nobody to tell, and erroring a dead stream is fatal.
          if (signal.aborted) return;
          mgr.recordError(account.name, (err as Error).message);
          controller.error(err);
        }
      },
      cancel(reason) {
        teardown(reason);
      },
    });

    return {
      kind: "response",
      response: new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "X-Pool-Account": account.name,
        },
      }),
    };
  }

  // Non-stream: drain the entire upstream body through the translator, then
  // fold its accumulated structured state into one message (no re-parsing of
  // emitted SSE frame strings).
  const collector = new SseParser((event) => {
    translator.handleEvent(event);
  });
  try {
    while (!translator.hasTerminalEvent) {
      const { value, done } = await reader.read();
      if (done) {
        collector.end();
        break;
      }
      collector.push(value);
    }
  } catch (err) {
    return readFailed(err);
  }

  // Nothing has reached the client, so settle exactly as the streaming
  // pre-commit path does: an upstream error event is terminal or a rate-limit
  // retry; truncation or a terminal event without message_start fails over.
  if (translator.sawError || !translator.hasTerminalEvent || !translator.hasStarted) {
    return failedBeforeCommit(translator.sawError);
  }
  translator.finish();
  // Re-read after finish(): control-flow narrowing still sees the null above.
  const lateError = (translator as CodexToAnthropicStream).sawError;
  if (lateError) {
    // Corrupt tool arguments from the model: the response is unusable but
    // another account would not do better.
    teardown();
    mgr.recordError(account.name, lateError.message);
    return { kind: "terminal", response: anthropicError(502, lateError.type, lateError.message) };
  }

  const message = translator.toAnthropicMessage();
  recordTerminalContext();
  recordCodexSuccess(mgr, account.name, translator);
  teardown();
  return {
    kind: "response",
    response: new Response(JSON.stringify(message), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "X-Pool-Account": account.name,
      },
    }),
  };
}

/**
 * Reads Codex's `x-codex-{primary,secondary}-*` rate-limit headers. The
 * primary window maps onto the unified snapshot's five-hour fields, the
 * secondary window onto the seven-day fields. Reset headers are an ABSOLUTE
 * unix timestamp in seconds (`...-reset-at`), not a countdown.
 */
export function parseCodexRateLimitSnapshot(
  headers: Headers,
  opts: { rejected?: boolean } = {},
): RateLimitSnapshot {
  const num = (name: string): number | null => {
    const raw = headers.get(name);
    if (raw == null || raw === "") return null;
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? n : null;
  };
  const resetAt = (name: string): number | null => {
    const raw = headers.get(name);
    if (!raw) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n * 1000 : null;
  };

  // Codex's primary/secondary windows map onto the pool's account-wide unified
  // windows (model === null). Each window's real duration comes from its
  // `-window-minutes` header, not its slot — a weekly window can arrive in the
  // primary slot (see durationToWindowKey). Codex has no model-scoped windows.
  const windows: RateLimitWindow[] = [];
  const seen = new Set<string>();
  const addWindow = (
    slot: "primary" | "secondary",
    usedName: string,
    minutesName: string,
    resetName: string,
  ): void => {
    const usedPct = num(usedName);
    const reset = resetAt(resetName);
    if (usedPct == null && reset == null) return;
    const minutes = num(minutesName);
    let key = durationToWindowKey(minutes == null ? null : minutes * 60_000, slot);
    if (seen.has(key)) key = key === "5h" ? "7d" : "5h"; // collision guard (never today)
    seen.add(key);
    const utilization = usedPct == null ? null : usedPct / 100;
    // A snapshot from a successful response proves the account is serving now, so
    // windows are "allowed" even at 100% (unenforced limit). Only a 429 marks
    // them spent by utilization.
    const status = opts.rejected ? (utilization != null && utilization >= 1 ? "rejected" : "allowed") : "allowed";
    windows.push({ key, model: null, status, utilization, reset });
  };
  addWindow("primary", CODEX_RATE_LIMIT_HEADERS.primaryUsedPercent, CODEX_RATE_LIMIT_HEADERS.primaryWindowMinutes, CODEX_RATE_LIMIT_HEADERS.primaryResetAt);
  addWindow("secondary", CODEX_RATE_LIMIT_HEADERS.secondaryUsedPercent, CODEX_RATE_LIMIT_HEADERS.secondaryWindowMinutes, CODEX_RATE_LIMIT_HEADERS.secondaryResetAt);

  const unifiedStatus =
    windows.length === 0 ? null : windows.some((w) => w.status === "rejected") ? "rejected" : "allowed";
  return { unifiedStatus, windows, updatedAt: Date.now() };
}

export function resetAtFromCodexHeaders(headers: Headers): number | undefined {
  // Codex ships the weekly window in the primary slot when the session window is
  // absent, so a primary-only preference could bench for ~7d on a session 429.
  // Use the soonest FUTURE reset among both windows; fall back to retry-after.
  const now = Date.now();
  const resets: number[] = [];
  for (const name of [CODEX_RATE_LIMIT_HEADERS.primaryResetAt, CODEX_RATE_LIMIT_HEADERS.secondaryResetAt]) {
    const raw = headers.get(name);
    if (!raw) continue;
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n * 1000 > now) resets.push(n * 1000);
  }
  if (resets.length > 0) return Math.min(...resets);
  return retryAfterMs(headers);
}

/**
 * Renders a Codex backend non-OK response body into one legible line for the
 * caller. The backend reports the cause in `detail` (a string, e.g. "Unsupported
 * parameter: max_output_tokens") or, for OpenAI-style errors, `error.message`;
 * fall back to the raw body, then a bare status. Prefixed so the client can tell
 * a Codex-backend rejection apart from a pool/native error and see which pooled
 * account it hit.
 */
export function describeCodexError(status: number, bodyText: string, accountName: string): string {
  const parsed = parseJson(bodyText);
  const detail =
    stringProp(parsed, "detail") ??
    stringProp(objectProp(parsed, "error"), "message") ??
    stringProp(parsed, "message") ??
    (bodyText.trim() ? bodyText.trim().slice(0, 300) : "");
  const cause = detail ? `: ${detail.slice(0, 300)}` : "";
  return `Codex backend rejected the request (HTTP ${status})${cause} [account "${accountName}"]`;
}

function noOpenAIAccountMessage(mgr: AccountManager): string {
  const total = mgr.listAccounts().filter((a) => a.provider === "openai").length;
  return total === 0
    ? "No OpenAI (ChatGPT) accounts configured. Add one with: bun run src/index.ts accounts login <name> --provider openai"
    : "All OpenAI accounts are currently unavailable (logged out or rate limited). Check the dashboard.";
}
