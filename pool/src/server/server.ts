/**
 * HTTP server (Bun.serve). Routes:
 *   GET  /                      -> status dashboard
 *   GET  /health                -> liveness + pool summary
 *   GET  /api/status            -> JSON account/usage status (dashboard polls this)
 *   GET  /v1/models             -> OpenAI-style model list
 *   POST /v1/chat/completions   -> OpenAI Chat Completions (stream + non-stream)
 *   POST /v1/messages           -> Anthropic Messages (stream + non-stream)
 */

import type { Config } from "../config.ts";
import { AccountManager, isValidPriority, isValidWeight, TUNING_BOUNDS, type RoutingTuning } from "../accounts/manager.ts";
import { loadModelTable, resolveModel, type ModelRoute } from "../models.ts";
import { runClaude } from "../subprocess/claude.ts";
import type { Account } from "../accounts/types.ts";
import { modelFamilyOf } from "../accounts/types.ts";
import { runWithFailover } from "./failover.ts";
import { dashboardHtml } from "./dashboard.ts";
import { proxyAnthropicMessages } from "../upstream/anthropic.ts";
import { proxyCodexMessages } from "../upstream/openai-codex.ts";
import {
  parseOpenAI,
  collectOpenAI,
  streamOpenAI,
  type OpenAIChatRequest,
} from "../adapters/openai.ts";
import {
  parseAnthropic,
  collectAnthropic,
  streamAnthropic,
  type AnthropicRequest,
} from "../adapters/anthropic.ts";
import { anthropicError } from "../upstream/shared.ts";

const APPEND_SYSTEM_PROMPT =
  "You are being used as an API model endpoint. Respond directly to the user's request. " +
  "Do not ask clarifying questions unless strictly necessary; produce the best answer you can from the information given.";

export function startServer(config: Config): void {
  const mgr = new AccountManager(config);
  const modelTable = loadModelTable(config.modelsFile);

  // Sweep idle session pins so load counts decay even when traffic stops.
  setInterval(() => mgr.pruneSessions(), 60_000);

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: 255, // allow long-running generations
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (req.method === "GET" && path === "/") {
        return html(dashboardHtml());
      }
      if (req.method === "GET" && (path === "/health" || path === "/healthz")) {
        const accounts = mgr.listAccounts();
        return json({
          status: "ok",
          accounts: accounts.length,
          available: accounts.filter((a) => a.available).length,
        });
      }
      if (req.method === "GET" && path === "/api/status") {
        return json({
          accounts: mgr.listAccounts(),
          routing: mgr.routingSnapshot(),
          tuning: mgr.getTuning(),
          usageWindowMs: config.usageWindowMs,
          now: Date.now(),
        });
      }
      if (path === "/api/routing") {
        if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return json({ error: { message: "Invalid JSON body" } }, 400);
        }
        return handleRoutingUpdate(mgr, body);
      }
      if (path === "/api/tuning") {
        if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return json({ error: { message: "Invalid JSON body" } }, 400);
        }
        return handleTuningUpdate(mgr, body);
      }
      if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
        return json({
          object: "list",
          data: modelTable.map((m) => ({
            id: m.id,
            object: "model",
            created: 0,
            owned_by: m.provider === "openai" ? "openai-chatgpt-pool" : "anthropic-claude-max-pool",
          })),
        });
      }

      // ---- Inference endpoints (require proxy auth if configured) ----
      if (path === "/v1/chat/completions" || path === "/v1/messages") {
        if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
        const authErr = checkAuth(req, config);
        if (authErr) return authErr;

        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return json({ error: { message: "Invalid JSON body" } }, 400);
        }

        return path === "/v1/chat/completions"
          ? handleOpenAI(body as OpenAIChatRequest, mgr, config, req.signal, modelTable)
          : handleAnthropic(body, req.headers, mgr, config, req.signal, modelTable);
      }

      return json({ error: "not found" }, 404);
    },
  });

  const accounts = mgr.listAccounts();
  const available = accounts.filter((a) => a.available).length;
  const origin = `http://${config.host}:${server.port}`;
  console.log(`\n  Claude Max Pool listening on ${origin}`);
  console.log(`  Dashboard:  ${origin}/`);
  console.log(`  Accounts:   ${accounts.length} total, ${available} available`);
  console.log(`  Backend:    ${config.backend === "oauth" ? "direct Anthropic OAuth" : "Claude CLI subprocess"}`);
  console.log(`  Proxy auth: ${config.proxyApiKey ? "enabled (bearer token required)" : "disabled (set PROXY_API_KEY to require a token)"}`);

  if (accounts.length === 0) {
    console.log(`
  ──────────────────────────────────────────────────────────────
  No accounts yet. Get started (each is a separate Claude login):

    1. Install the Claude CLI, if needed:
         npm install -g @anthropic-ai/claude-code

    2. Log in your first plan (do /login, then /exit in the CLI):
         bun run src/index.ts accounts login work

       …or import the login already on this machine:
         bun run src/index.ts accounts import primary

    3. Add more plans the same way, then send a request:
         curl ${origin}/v1/chat/completions \\
           -H "content-type: application/json" \\
           -d '{"model":"sonnet","messages":[{"role":"user","content":"Hello!"}]}'

  Open ${origin}/ for a live setup walkthrough + status.
  ──────────────────────────────────────────────────────────────
`);
  } else if (available === 0) {
    const anyAuthed = accounts.some((a) => a.authenticated);
    console.log(
      anyAuthed
        ? `\n  ⚠ No accounts are available right now (rate limited / token needs attention).\n    Check ${origin}/ — requests will 503 until one frees up.\n`
        : `\n  ⚠ No accounts are logged in. Authenticate one:\n      bun run src/index.ts accounts login <name>\n`,
    );
  } else {
    console.log("");
  }
}

// ---- request handlers ----------------------------------------------------

async function handleOpenAI(
  body: OpenAIChatRequest,
  mgr: AccountManager,
  config: Config,
  signal: AbortSignal,
  modelTable: ModelRoute[],
): Promise<Response> {
  const parsed = parseOpenAI(body);
  // OpenAI-provider models are only served on the Anthropic /v1/messages path
  // (this compat endpoint flattens tool structure); reject them clearly here.
  const route = routeForRequest(modelTable, body);
  const rejection = openAIEndpointModelError(route, parsed.requestedModel);
  if (rejection) return rejection;

  // parsed.model is the CLI-resolved alias ("opus"/"sonnet"/"haiku") used to spawn
  // the subprocess; routing must key off the caller's actual requested model id
  // (e.g. "claude-fable-5"), which resolveModel() can't represent.
  const modelFamily = modelFamilyOf(parsed.requestedModel);
  const first = mgr.pick(parsed.sessionKey, undefined, "anthropic", modelFamily);
  if (!first) return json(noAccountError("openai", mgr), 503);

  const events = runWithFailover(
    mgr,
    parsed.sessionKey,
    first,
    makeEventFactory(config, parsed.prompt, parsed.model, signal),
    failoverHooks(config),
    modelFamily,
  );
  if (parsed.stream) {
    return sseResponse(streamOpenAI(events, parsed), first.name);
  }
  const { status, body: out } = await collectOpenAI(events, parsed);
  return json(out, status, { "X-Pool-Account": first.name });
}

/** Pure decision of which model route a request body should use — no I/O. */
export function routeForRequest(table: ModelRoute[], body: unknown): ModelRoute {
  const model =
    typeof (body as Record<string, unknown>)?.model === "string"
      ? String((body as Record<string, unknown>).model)
      : "";
  return resolveModel(table, model);
}

/**
 * The OpenAI-compat /v1/chat/completions endpoint flattens tool structure and
 * cannot drive the Codex backend. If the resolved route is an OpenAI/ChatGPT
 * model, reject with a clear 400 pointing the caller at /v1/messages instead
 * of silently misrouting the request to the Claude CLI. Returns null when the
 * route is fine to serve on this endpoint.
 */
export function openAIEndpointModelError(route: ModelRoute, modelId: string): Response | null {
  if (route.provider !== "openai") return null;
  return json(
    {
      error: {
        message:
          `Model '${modelId}' is served by an OpenAI/ChatGPT-subscription account and is only ` +
          "available via the Anthropic /v1/messages endpoint. Point your client at /v1/messages " +
          "(or use a Claude model here).",
        type: "invalid_request_error",
        code: "model_not_supported_on_this_endpoint",
      },
    },
    400,
  );
}

/**
 * On the `cli` backend, /v1/messages spawns the Claude CLI subprocess, which
 * can't drive an OpenAI/ChatGPT account. Only the `oauth` backend can route to
 * Codex (via proxyCodexMessages). Returns null when the request is fine to
 * serve on the configured backend.
 */
export function nonOauthOpenAIBackendError(route: ModelRoute, backend: Config["backend"]): Response | null {
  if (route.provider !== "openai" || backend === "oauth") return null;
  return anthropicError(
    400,
    "invalid_request_error",
    `OpenAI models require the direct (oauth) backend. Unset CLAUDE_POOL_BACKEND=cli to use '${route.id}'.`,
  );
}

async function handleAnthropic(
  body: unknown,
  headers: Headers,
  mgr: AccountManager,
  config: Config,
  signal: AbortSignal,
  modelTable: ModelRoute[],
): Promise<Response> {
  const route = routeForRequest(modelTable, body);
  const backendErr = nonOauthOpenAIBackendError(route, config.backend);
  if (backendErr) return backendErr;

  if (config.backend === "oauth") {
    if (route.provider === "openai") {
      return proxyCodexMessages(body, mgr, config, signal, route, failoverHooks(config));
    }
    return proxyAnthropicMessages(body, headers, mgr, config, signal, failoverHooks(config));
  }

  const legacyBody = body as AnthropicRequest;
  const parsed = parseAnthropic(legacyBody);
  // Same reasoning as handleOpenAI: route on the actual requested model id, not
  // the CLI-resolved alias.
  const modelFamily = modelFamilyOf(parsed.requestedModel);
  const first = mgr.pick(parsed.sessionKey, undefined, "anthropic", modelFamily);
  if (!first) return json(noAccountError("anthropic", mgr), 503);

  const events = runWithFailover(
    mgr,
    parsed.sessionKey,
    first,
    makeEventFactory(config, parsed.prompt, parsed.model, signal),
    failoverHooks(config),
    modelFamily,
  );
  if (parsed.stream) {
    return sseResponse(streamAnthropic(events, parsed), first.name);
  }
  const { status, body: out } = await collectAnthropic(events, parsed);
  return json(out, status, { "X-Pool-Account": first.name });
}

/** Builds the per-account event factory that spawns the Claude CLI. */
function makeEventFactory(
  config: Config,
  prompt: string,
  model: "opus" | "sonnet" | "haiku",
  signal: AbortSignal,
) {
  return (account: Account) =>
    runClaude(prompt, {
      claudeBin: config.claudeBin,
      configDir: account.configDir,
      model,
      appendSystemPrompt: APPEND_SYSTEM_PROMPT,
      timeoutMs: config.requestTimeoutMs,
      signal,
    });
}

function failoverHooks(config: Config) {
  return {
    onFailover: (from: string, to: string) => {
      if (config.logFailover) {
        console.log(`  ↻ failover: "${from}" exhausted → retrying on "${to}"`);
      }
    },
  };
}

// ---- helpers -------------------------------------------------------------

/**
 * Apply a dashboard routing edit (priority and/or weight). Validates the
 * account exists and each provided field independently, then persists them.
 * Unauthenticated by design, matching the rest of the dashboard/status routes.
 */
export function handleRoutingUpdate(mgr: AccountManager, body: unknown): Response {
  const b = (body ?? {}) as { account?: unknown; priority?: unknown; weight?: unknown };
  const account = typeof b.account === "string" ? b.account : "";
  const { priority, weight } = b;
  if (!account || !mgr.listNames().includes(account)) {
    return json({ error: { message: `Unknown account: ${account || "(missing)"}` } }, 400);
  }
  if (priority === undefined && weight === undefined) {
    return json({ error: { message: "provide priority and/or weight" } }, 400);
  }
  if (priority !== undefined && !isValidPriority(priority)) {
    return json({ error: { message: "priority must be a non-negative integer" } }, 400);
  }
  if (weight !== undefined && !isValidWeight(weight)) {
    return json({ error: { message: "weight must be a number between 0.1 and 10" } }, 400);
  }
  if (priority !== undefined) mgr.setPriority(account, priority);
  if (weight !== undefined) mgr.setWeight(account, weight);
  return json({ ok: true, account, priority: mgr.priorityFor(account), weight: mgr.weightFor(account) });
}

/**
 * Apply a dashboard routing-tuning edit: any subset of the weighted-score knobs.
 * Each supplied field is validated against its bounds; the rest are preserved.
 * Unauthenticated by design, like the other dashboard/status routes.
 */
export function handleTuningUpdate(mgr: AccountManager, body: unknown): Response {
  const b = (body ?? {}) as Partial<Record<keyof RoutingTuning, unknown>>;
  const patch: Partial<RoutingTuning> = {};
  for (const key of Object.keys(TUNING_BOUNDS) as (keyof RoutingTuning)[]) {
    if (b[key] !== undefined) patch[key] = b[key] as number;
  }
  if (Object.keys(patch).length === 0) {
    return json({ error: { message: "provide at least one tuning field" } }, 400);
  }
  // setTuning is the single validation authority; surface its bounds error
  // (per-field, with the offending value) as a 400 instead of a 500.
  try {
    mgr.setTuning(patch);
  } catch (e) {
    return json({ error: { message: e instanceof Error ? e.message : String(e) } }, 400);
  }
  return json({ ok: true, tuning: mgr.getTuning() });
}

function checkAuth(req: Request, config: Config): Response | null {
  if (!config.proxyApiKey) return null;
  const header = req.headers.get("authorization") || "";
  const xkey = req.headers.get("x-api-key") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (bearer === config.proxyApiKey || xkey === config.proxyApiKey) return null;
  return json({ error: { message: "Unauthorized: invalid or missing API key", type: "authentication_error" } }, 401);
}

function noAccountError(shape: "openai" | "anthropic", mgr: AccountManager): unknown {
  const total = mgr.listAccounts().length;
  const message =
    total === 0
      ? "No Claude accounts configured. Add one with: bun run src/index.ts accounts login <name>"
      : "All Claude accounts are currently unavailable (logged out or rate limited). Check the dashboard.";
  return shape === "openai"
    ? { error: { message, type: "service_unavailable" } }
    : { type: "error", error: { type: "overloaded_error", message } };
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function html(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function sseResponse(gen: AsyncGenerator<string>, accountName: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const encoder = new TextEncoder();
      try {
        const { value, done } = await gen.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(value));
      } catch (err) {
        controller.error(err);
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "X-Pool-Account": accountName,
    },
  });
}
