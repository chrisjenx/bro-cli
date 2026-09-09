import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig, type Config } from "../config.ts";
import { AccountManager } from "../accounts/manager.ts";
import { OPENAI_CREDS_FILENAME, type Provider } from "../accounts/types.ts";
import { proxyCodexMessages } from "./openai-codex.ts";
import { proxyAnthropicMessages } from "./anthropic.ts";

const enc = new TextEncoder();
const prefix = (provider: Provider) => provider === "openai"
  ? 'event: response.created\ndata: {"type":"response.created","response":{"id":"r","model":"gpt-5.2-codex"}}\n\n'
  : 'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"claude-sonnet-5","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n';
const terminal = (provider: Provider) => provider === "openai"
  ? 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n'
  : 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

function fixture(provider: Provider, names = ["one"], overrides: Partial<Config> = {}, kind: "stream" | "headers" | "preamble" | "json" | "error" = "stream") {
  const dir = mkdtempSync(join(process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, "tmp") : tmpdir(), "proxy-inflight-"));
  for (const name of names) {
    mkdirSync(join(dir, "accounts", name), { recursive: true });
    const token = { accessToken: name, refreshToken: "refresh", expiresAt: Date.now() + 3600000 };
    writeFileSync(join(dir, "accounts", name, provider === "openai" ? OPENAI_CREDS_FILENAME : ".credentials.json"), JSON.stringify(provider === "openai" ? token : { claudeAiOauth: token }));
  }
  const bodies: ReadableStreamDefaultController<Uint8Array>[] = [];
  let calls = 0;
  const server = Bun.serve({ port: 0, idleTimeout: 0, async fetch(req) {
    calls++;
    if (kind === "headers") await new Promise<void>(resolve => req.signal.addEventListener("abort", () => resolve(), { once: true }));
    const text = kind === "preamble" ? ": still waiting\n\n" : kind === "json" ? "{" : kind === "error" ? "request rejected" : prefix(provider);
    return new Response(new ReadableStream<Uint8Array>({ start(c) { bodies.push(c); c.enqueue(enc.encode(text)); } }), { status: kind === "error" ? 400 : 200, headers: { "content-type": kind === "json" ? "application/json" : "text/event-stream" } });
  } });
  const config = loadConfig({ poolDir: dir, accountsDir: join(dir, "accounts"), usageFile: join(dir, "usage.json"), sessionsFile: join(dir, "sessions.json"), anthropicApiBaseUrl: String(server.url), anthropicMaxInFlight: 1, codexMaxInFlight: 1, inFlightWaitMs: 1000, usageRefreshEnabled: false, logFailover: false, ...overrides });
  const mgr = new AccountManager(config);
  const responses: Response[] = [];
  const request = async (signal = new AbortController().signal, stream = true) => {
    const response = await (provider === "openai"
    ? proxyCodexMessages({ model: "gpt", stream, max_tokens: 10, messages: [{ role: "user", content: "hi" }] }, mgr, config, signal, { id: "gpt", provider: "openai", upstreamModel: "gpt-5.2-codex" }, {}, ((_url, init) => fetch(server.url, init)) as typeof fetch)
    : proxyAnthropicMessages({ model: "claude-sonnet-5", stream, max_tokens: 10, messages: [{ role: "user", content: "hi" }] }, new Headers(), mgr, config, signal));
    responses.push(response);
    return response;
  };
  return { mgr, config, request, calls: () => calls,
    finish(i = 0) { bodies[i]!.enqueue(enc.encode(terminal(provider))); bodies[i]!.close(); },
    clean() { for (const r of responses) void r.body?.cancel().catch(() => {}); server.stop(true); rmSync(dir, { recursive: true, force: true }); },
  };
}

for (const provider of ["openai", "anthropic"] as const) {
  test(`${provider}: concurrent reservations spread before async auth and release on cancel`, async () => {
    const f = fixture(provider, ["one", "two"]);
    try {
      const [a, b] = await Promise.all([f.request(), f.request()]);
      expect(a.headers.get("X-Pool-Account")).not.toBe(b.headers.get("X-Pool-Account"));
      expect(f.mgr.listAccounts().map(a => a.inFlight)).toEqual([1, 1]);
      await a.body!.cancel(); await b.body!.cancel();
      expect(f.mgr.listAccounts().map(a => a.inFlight)).toEqual([0, 0]);
    } finally { f.clean(); }
  });

  test(`${provider}: a saturated account waits until the first stream releases`, async () => {
    const f = fixture(provider);
    try {
      const a = await f.request();
      const pending = f.request();
      await Bun.sleep(25);
      expect(f.calls()).toBe(1);
      await a.body!.cancel();
      const b = await pending;
      expect(b.status).toBe(200);
      expect(f.calls()).toBe(2);
      expect(f.mgr.inFlightOf("one")).toBe(1);
      await b.body!.cancel();
      expect(f.mgr.inFlightOf("one")).toBe(0);
    } finally { f.clean(); }
  });

  test(`${provider}: soft-cap overflow sends after bounded waiting without a capacity error`, async () => {
    const f = fixture(provider, ["one"], { inFlightWaitMs: 30 });
    try {
      const a = await f.request(); const start = Date.now(); const b = await f.request();
      expect(Date.now() - start).toBeGreaterThanOrEqual(20);
      expect(b.status).toBe(200);
      expect(f.mgr.inFlightOf("one")).toBe(2);
      await a.body!.cancel(); await b.body!.cancel();
      expect(f.mgr.inFlightOf("one")).toBe(0);
    } finally { f.clean(); }
  });

  test(`${provider}: abort while queued neither dispatches nor penalizes an account`, async () => {
    const f = fixture(provider);
    try {
      const a = await f.request(); const signal = new AbortController();
      const pending = f.request(signal.signal);
      await Bun.sleep(20); signal.abort();
      expect((await pending).status).toBe(499);
      expect(f.calls()).toBe(1);
      expect(f.mgr.getAccount("one").usage.lastError).toBeNull();
      await a.body!.cancel();
      expect(f.mgr.inFlightOf("one")).toBe(0);
      expect((await f.request(signal.signal)).status).toBe(499);
      expect(f.calls()).toBe(1);
    } finally { f.clean(); }
  });

  test(`${provider}: upstream completion releases the reservation`, async () => {
    const f = fixture(provider);
    try {
      const a = await f.request(); const text = a.text(); f.finish();
      expect(await text).toContain("message_stop");
      expect(f.mgr.inFlightOf("one")).toBe(0);
    } finally { f.clean(); }
  });

  test(`${provider}: configured body idle timeout cleans the live reservation`, async () => {
    const f = fixture(provider, ["one"], { anthropicIdleTimeoutMs: 50, codexIdleTimeoutMs: 50, requestTimeoutMs: 250 });
    try {
      const a = await f.request();
      await expect(a.text()).rejects.toThrow("idle");
      expect(f.mgr.inFlightOf("one")).toBe(0);
    } finally { f.clean(); }
  });
}


for (const provider of ["openai", "anthropic"] as const) {
  for (const kind of ["headers", "preamble", "json", "error"] as const) {
    test(`${provider}: abort during ${kind} releases without recording an account failure`, async () => {
      const f = fixture(provider, ["one", "two"], {}, kind);
      const abort = new AbortController();
      try {
        const pending = f.request(abort.signal, kind !== "json");
        await Bun.sleep(25);
        expect(f.calls()).toBe(1);
        expect(f.mgr.listAccounts().reduce((sum, a) => sum + a.inFlight, 0)).toBe(1);
        abort.abort();
        expect((await pending).status).toBe(499);
        expect(f.calls()).toBe(1);
        expect(f.mgr.listAccounts().map(a => a.inFlight)).toEqual([0, 0]);
        expect(f.mgr.listAccounts().map(a => a.usage.lastError)).toEqual([null, null]);
      } finally { abort.abort(); f.clean(); }
    });
  }
}


for (const provider of ["openai", "anthropic"] as const) {
  test(`${provider}: an unread downstream body releases on the attempt deadline`, async () => {
    const f = fixture(provider, ["one"], { requestTimeoutMs: 40 });
    try {
      const response = await f.request();
      expect(f.mgr.inFlightOf("one")).toBe(1);
      await Bun.sleep(100);
      expect(f.mgr.inFlightOf("one")).toBe(0);
      await expect(response.text()).rejects.toThrow();
    } finally { f.clean(); }
  });
}
