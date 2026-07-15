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
import type { ModelRoute } from "../models.ts";
import { refreshOpenAIToken } from "../accounts/openai-oauth.ts";
import { anthropicToCodexRequest, CodexToAnthropicStream } from "./codex-translate.ts";
import { durationToWindowKey } from "./codex-windows.ts";
import { CODEX_RESPONSES_URL, CODEX_ORIGINATOR, CODEX_ACCOUNT_ID_HEADER, CODEX_RATE_LIMIT_HEADERS } from "./codex-constants.ts";
import { anthropicError, makeAbort, SseParser, isRateLimit, retryAfterMs, parseJson, stringProp, objectProp } from "./shared.ts";

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

const refreshLocks = new Map<string, Promise<OpenAIOauthCreds>>();

/** Anthropic SSE keep-alive frame, emitted during no-content phases (e.g. reasoning). */
const PING_FRAME = `event: ping\ndata: ${JSON.stringify({ type: "ping" })}\n\n`;

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
    metadata && typeof metadata.user_id === "string" && metadata.user_id ? metadata.user_id : undefined;
  const streamRequested = anthropicBody.stream === true;
  const codexBody = anthropicToCodexRequest(anthropicBody, route.upstreamModel, route.effortMap);

  let account = mgr.pick(sessionKey, undefined, "openai");
  if (!account) return anthropicError(503, "overloaded_error", noOpenAIAccountMessage(mgr));

  const tried = new Set<string>();
  let lastRetry: RetryReason | null = null;

  while (account) {
    tried.add(account.name);
    const attempt = await tryCodexAccount(account, codexBody, route, mgr, config, signal, streamRequested, fetchFn);

    if (attempt.kind === "response") {
      if (sessionKey) mgr.setAffinity(sessionKey, account.name, "openai");
      return attempt.response;
    }
    if (attempt.kind === "terminal") return attempt.response;

    lastRetry = attempt.reason;
    const next = mgr.pick(sessionKey, tried, "openai");
    if (!next) break;
    hooks.onFailover?.(account.name, next.name);
    account = next;
  }

  return anthropicError(
    lastRetry?.status ?? 503,
    lastRetry?.type ?? "overloaded_error",
    lastRetry?.message ?? noOpenAIAccountMessage(mgr),
  );
}

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
): Promise<AttemptResult> {
  let creds: OpenAIOauthCreds | null;
  try {
    creds = await ensureFreshToken(account.name, mgr, config, false, fetchFn);
  } catch (err) {
    const message = (err as Error).message;
    mgr.recordError(account.name, message);
    return { kind: "retry", reason: authReason(message) };
  }
  if (!creds?.accessToken) {
    const message = `Account "${account.name}" has no OpenAI access token`;
    mgr.recordError(account.name, message);
    return { kind: "retry", reason: authReason(message) };
  }

  let res: Response;
  let abortCleanup: () => void;
  try {
    const attempt = await fetchCodex(creds, codexBody, config, signal, fetchFn);
    res = attempt.response;
    abortCleanup = attempt.cleanup;
  } catch (err) {
    const message = (err as Error).message;
    mgr.recordError(account.name, message);
    return { kind: "retry", reason: { status: 502, type: "api_error", message, rateLimited: false } };
  }

  if (res.status === 401 || res.status === 403) {
    abortCleanup();
    try {
      creds = await ensureFreshToken(account.name, mgr, config, true, fetchFn);
    } catch (err) {
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
    } catch (err) {
      const message = (err as Error).message;
      mgr.recordError(account.name, message);
      return { kind: "retry", reason: { status: 502, type: "api_error", message, rateLimited: false } };
    }
    if (res.status === 401 || res.status === 403) {
      abortCleanup();
      const message = `Account "${account.name}" is not authorized against the Codex backend`;
      mgr.recordError(account.name, message);
      return { kind: "retry", reason: authReason(message, res.status) };
    }
  }

  mgr.recordRateLimitSnapshot(
    account.name,
    parseCodexRateLimitSnapshot(res.headers, { rejected: res.status === 429 }),
    true,
  );

  if (res.status === 429) {
    const text = await res.text().catch(() => "");
    abortCleanup();
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

  return streamCodexResponse(res.body, account, mgr, route, streamRequested, abortCleanup, config);
}

async function fetchCodex(
  creds: OpenAIOauthCreds,
  codexBody: Record<string, unknown>,
  config: Config,
  signal: AbortSignal,
  fetchFn: typeof fetch,
): Promise<{ response: Response; cleanup: () => void }> {
  const abort = makeAbort(config, signal);
  try {
    const response = await fetchFn(CODEX_RESPONSES_URL, {
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
    });
    return { response, cleanup: abort.cleanup };
  } catch (err) {
    abort.cleanup();
    if (signal.aborted) throw new Error("Request aborted by client");
    throw err;
  }
}

async function ensureFreshToken(
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
): Promise<AttemptResult> {
  const translator = new CodexToAnthropicStream(route.id);
  const reader = body.getReader();
  const encoder = new TextEncoder();

  if (streamRequested) {
    const pending: string[] = [];
    let committed = false;
    let initialRateLimit: RetryReason | null = null;

    const parser = new SseParser((event) => {
      const frames = translator.handleEvent(event);
      if (translator.sawError && !committed) {
        if (isRateLimit(translator.sawError.message)) {
          initialRateLimit = {
            status: 429,
            type: translator.sawError.type,
            message: translator.sawError.message,
            rateLimited: true,
          };
          return;
        }
      }
      // gpt-5.5's reasoning-summary events (and other droppable preamble)
      // translate to no frames. Once the stream has started, emit a ping in
      // their place so the client sees keep-alive activity rather than silence
      // during a long reasoning phase — mirroring Anthropic's own ping events.
      if (frames.length === 0 && translator.hasStarted && !translator.sawError) {
        pending.push(PING_FRAME);
      }
      if (frames.length > 0) committed = true;
      pending.push(...frames);
    });

    // Drain until we can decide: either content committed, an early rate-limit
    // error surfaced, the upstream stream ended, or we've buffered enough
    // non-content preamble (64 KiB, matching anthropic.ts's prefix cap) that
    // we should commit and stream the rest through normally rather than risk
    // unbounded buffering against a misbehaving upstream.
    let upstreamDone = false;
    let prefixBytes = 0;
    try {
      while (!committed && !initialRateLimit && !upstreamDone && prefixBytes < 64 * 1024) {
        const { value, done: d } = await reader.read();
        if (d) {
          upstreamDone = true;
          break;
        }
        if (value) prefixBytes += value.byteLength;
        parser.push(value);
      }
    } catch (err) {
      await reader.cancel().catch(() => {});
      cleanup();
      const message = (err as Error).message;
      mgr.recordError(account.name, message);
      return { kind: "retry", reason: { status: 502, type: "api_error", message, rateLimited: false } };
    }

    if (initialRateLimit) {
      await reader.cancel().catch(() => {});
      cleanup();
      mgr.markRateLimited(account.name, (initialRateLimit as RetryReason).resetAt);
      return { kind: "retry", reason: initialRateLimit };
    }

    // We hit the byte cap without the translator producing a single frame. That
    // happens when Codex's first event (response.created, which echoes the full
    // instructions + tool schemas) is a single SSE line larger than the cap:
    // the parser can't complete it, so no message_start was emitted and the
    // client would see a 200 with no opening frame and hang. Synthesize the
    // message_start envelope now so the stream always opens promptly; the real
    // response.created becomes a no-op once it finally parses in pull().
    if (!committed && !upstreamDone) {
      pending.push(...translator.forceMessageStart());
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
    let closed = false;
    let keepAliveTimer: ReturnType<typeof setInterval> | undefined;
    const stopKeepAlive = () => {
      closed = true;
      if (keepAliveTimer) clearInterval(keepAliveTimer);
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of prefix) controller.enqueue(encoder.encode(frame));
        lastSentAt = Date.now();
        keepAliveTimer = setInterval(() => {
          if (closed) return;
          if (Date.now() - lastSentAt >= config.streamKeepAliveMs) {
            try {
              controller.enqueue(encoder.encode(PING_FRAME));
              lastSentAt = Date.now();
            } catch {
              // Stream already closed/errored — stop pinging.
              stopKeepAlive();
            }
          }
        }, config.streamKeepAliveMs);
      },
      async pull(controller) {
        const finalize = () => {
          upstreamDone = true;
          stopKeepAlive();
          parser.end();
          for (const frame of translator.finish()) controller.enqueue(encoder.encode(frame));
          if (translator.sawError) mgr.recordError(account.name, translator.sawError.message);
          else mgr.recordSuccess(account.name, translator.usage, 0);
          cleanup();
          controller.close();
        };
        if (upstreamDone) {
          finalize();
          return;
        }
        try {
          const { value, done: d } = await reader.read();
          if (d) {
            finalize();
            return;
          }
          parser.push(value);
          const frames = pending.splice(0, pending.length);
          if (frames.length > 0) {
            for (const frame of frames) controller.enqueue(encoder.encode(frame));
            lastSentAt = Date.now();
          }
        } catch (err) {
          stopKeepAlive();
          mgr.recordError(account.name, (err as Error).message);
          cleanup();
          controller.error(err);
        }
      },
      async cancel(reason) {
        stopKeepAlive();
        cleanup();
        await reader.cancel(reason).catch(() => {});
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
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      collector.push(value);
    }
    collector.end();
    translator.finish();
  } catch (err) {
    cleanup();
    mgr.recordError(account.name, (err as Error).message);
    return { kind: "terminal", response: anthropicError(502, "api_error", `Streaming proxy error: ${(err as Error).message}`) };
  }
  cleanup();

  if (translator.sawError) {
    if (isRateLimit(translator.sawError.message)) {
      mgr.markRateLimited(account.name);
      return {
        kind: "retry",
        reason: { status: 429, type: translator.sawError.type, message: translator.sawError.message, rateLimited: true },
      };
    }
    mgr.recordError(account.name, translator.sawError.message);
    return {
      kind: "terminal",
      response: anthropicError(502, translator.sawError.type, translator.sawError.message),
    };
  }

  const message = translator.toAnthropicMessage();
  mgr.recordSuccess(account.name, translator.usage, 0);
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
  // Codex's own absolute reset-at is the authoritative cooldown-until, so it
  // takes precedence over a generic retry-after (which a gateway/CDN might
  // inject alongside it); retry-after is only a fallback.
  const primaryResetAt = headers.get(CODEX_RATE_LIMIT_HEADERS.primaryResetAt);
  if (primaryResetAt) {
    const n = Number.parseInt(primaryResetAt, 10);
    if (Number.isFinite(n)) return n * 1000;
  }
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
