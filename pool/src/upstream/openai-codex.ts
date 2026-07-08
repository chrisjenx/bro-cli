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
import type { Account, OpenAIOauthCreds, RateLimitSnapshot } from "../accounts/types.ts";
import type { ModelRoute } from "../models.ts";
import { refreshOpenAIToken } from "../accounts/openai-oauth.ts";
import { anthropicToCodexRequest, CodexToAnthropicStream } from "./codex-translate.ts";
import { CODEX_RESPONSES_URL, CODEX_ORIGINATOR, CODEX_ACCOUNT_ID_HEADER, CODEX_RATE_LIMIT_HEADERS } from "./codex-constants.ts";
import { anthropicError, makeAbort, SseParser, isRateLimit, retryAfterMs } from "./shared.ts";

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
  const codexBody = anthropicToCodexRequest(anthropicBody, route.upstreamModel);

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

  mgr.recordRateLimitSnapshot(account.name, parseCodexRateLimitSnapshot(res.headers));

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
    const message = text.slice(0, 500) || `Codex backend returned HTTP ${res.status}`;
    mgr.recordError(account.name, message);
    return { kind: "terminal", response: anthropicError(res.status, "api_error", message) };
  }

  if (!res.body) {
    abortCleanup();
    const message = "Codex backend returned an empty streaming body";
    mgr.recordError(account.name, message);
    return { kind: "terminal", response: anthropicError(502, "api_error", message) };
  }

  return streamCodexResponse(res.body, account, mgr, route, streamRequested, abortCleanup);
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

  const refresh = refreshOpenAIToken(creds, fetchFn)
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
    while (!committed && !initialRateLimit && !upstreamDone && prefixBytes < 64 * 1024) {
      const { value, done: d } = await reader.read();
      if (d) {
        upstreamDone = true;
        break;
      }
      if (value) prefixBytes += value.byteLength;
      parser.push(value);
    }

    if (initialRateLimit) {
      await reader.cancel().catch(() => {});
      cleanup();
      mgr.markRateLimited(account.name, (initialRateLimit as RetryReason).resetAt);
      return { kind: "retry", reason: initialRateLimit };
    }

    const prefix = pending.splice(0, pending.length);
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const frame of prefix) controller.enqueue(encoder.encode(frame));
      },
      async pull(controller) {
        if (upstreamDone) {
          parser.end();
          for (const frame of translator.finish()) controller.enqueue(encoder.encode(frame));
          if (translator.sawError) mgr.recordError(account.name, translator.sawError.message);
          else mgr.recordSuccess(account.name, translator.usage, 0);
          cleanup();
          controller.close();
          return;
        }
        try {
          const { value, done: d } = await reader.read();
          if (d) {
            upstreamDone = true;
            parser.end();
            for (const frame of translator.finish()) controller.enqueue(encoder.encode(frame));
            if (translator.sawError) mgr.recordError(account.name, translator.sawError.message);
            else mgr.recordSuccess(account.name, translator.usage, 0);
            cleanup();
            controller.close();
            return;
          }
          parser.push(value);
          for (const frame of pending.splice(0, pending.length)) controller.enqueue(encoder.encode(frame));
        } catch (err) {
          mgr.recordError(account.name, (err as Error).message);
          cleanup();
          controller.error(err);
        }
      },
      async cancel(reason) {
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
export function parseCodexRateLimitSnapshot(headers: Headers): RateLimitSnapshot {
  const pct = (name: string): number | null => {
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
  const statusFor = (usedPercent: number | null): string | null => {
    if (usedPercent == null) return null;
    return usedPercent < 100 ? "allowed" : "rejected";
  };

  const primaryPct = pct(CODEX_RATE_LIMIT_HEADERS.primaryUsedPercent);
  const secondaryPct = pct(CODEX_RATE_LIMIT_HEADERS.secondaryUsedPercent);
  const fiveHourStatus = statusFor(primaryPct);
  const sevenDayStatus = statusFor(secondaryPct);

  let unifiedStatus: string | null = null;
  if (fiveHourStatus || sevenDayStatus) {
    unifiedStatus = fiveHourStatus === "rejected" || sevenDayStatus === "rejected" ? "rejected" : "allowed";
  }

  return {
    unifiedStatus,
    fiveHourStatus,
    fiveHourUtilization: primaryPct == null ? null : primaryPct / 100,
    fiveHourReset: resetAt(CODEX_RATE_LIMIT_HEADERS.primaryResetAt),
    sevenDayStatus,
    sevenDayUtilization: secondaryPct == null ? null : secondaryPct / 100,
    sevenDayReset: resetAt(CODEX_RATE_LIMIT_HEADERS.secondaryResetAt),
    updatedAt: Date.now(),
  };
}

function resetAtFromCodexHeaders(headers: Headers): number | undefined {
  const viaRetryAfter = retryAfterMs(headers);
  if (viaRetryAfter !== undefined) return viaRetryAfter;

  const primaryResetAt = headers.get(CODEX_RATE_LIMIT_HEADERS.primaryResetAt);
  if (primaryResetAt) {
    const n = Number.parseInt(primaryResetAt, 10);
    if (Number.isFinite(n)) return n * 1000;
  }
  return undefined;
}

function noOpenAIAccountMessage(mgr: AccountManager): string {
  const total = mgr.listAccounts().filter((a) => a.provider === "openai").length;
  return total === 0
    ? "No OpenAI (ChatGPT) accounts configured. Add one with: bun run src/index.ts accounts login <name> --provider openai"
    : "All OpenAI accounts are currently unavailable (logged out or rate limited). Check the dashboard.";
}
