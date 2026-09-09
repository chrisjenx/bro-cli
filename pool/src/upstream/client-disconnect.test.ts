/**
 * A client that hangs up mid-stream must not take the pool process with it.
 *
 * When Claude Code disconnects, the request signal's abort propagates to the
 * upstream fetch, which fires the stream's failure signal. If the proxy then
 * errors the client-facing response stream, Bun rejects a promise nobody can
 * handle — an unhandled rejection, which is fatal by default. The pool died
 * this way in production: three `AbortError: The connection was closed.`
 * fatals in a row, each followed by a cold start and ConnectionRefused for
 * every in-flight session.
 *
 * These tests drive the real proxies behind a real Bun.serve and disconnect a
 * raw socket, because the fault only appears with a genuine HTTP client going
 * away — an in-process `fetch` client would attribute the rejection to itself.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Server } from "bun";
import { loadConfig, type Config } from "../config.ts";
import { AccountManager } from "../accounts/manager.ts";
import { OPENAI_CREDS_FILENAME } from "../accounts/types.ts";
import { proxyCodexMessages } from "./openai-codex.ts";
import { proxyAnthropicMessages } from "./anthropic.ts";

const enc = new TextEncoder();

function tempPool(): { poolDir: string; mgr: AccountManager; config: Config } {
  const poolDir = mkdtempSync(join(tmpdir(), "cmp-disconnect-"));
  const accountsDir = join(poolDir, "accounts");
  // Separate directories: one account dir holding both credential files
  // resolves to a single provider, leaving the other pool empty.
  const dir = join(accountsDir, "claude-a");
  const codexDir = join(accountsDir, "codex-a");
  mkdirSync(dir, { recursive: true });
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(
    join(dir, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "tok-a",
        refreshToken: "refresh-a",
        expiresAt: Date.now() + 3_600_000,
        scopes: ["user:inference", "user:sessions:claude_code"],
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_5x",
      },
    }),
  );
  writeFileSync(
    join(codexDir, OPENAI_CREDS_FILENAME),
    JSON.stringify({
      accessToken: "tok-openai",
      refreshToken: "refresh-openai",
      accountId: "acct-a",
      expiresAt: Date.now() + 3_600_000,
      planType: "pro",
    }),
  );
  const config = loadConfig({
    poolDir,
    accountsDir,
    usageFile: join(poolDir, "usage.json"),
    sessionsFile: join(poolDir, "sessions.json"),
  });
  return { poolDir, mgr: new AccountManager(config), config };
}

/** An upstream that commits some content and then stalls, like a model thinking. */
function stallingUpstream(frames: string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const f of frames) c.enqueue(enc.encode(f + "\n\n"));
      },
      pull() {
        return new Promise<void>(() => {});
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

const CODEX_FRAMES = [
  'data: {"type":"response.created","response":{"id":"r1"}}',
  'data: {"type":"response.output_item.added","item":{"type":"message"}}',
  'data: {"type":"response.output_text.delta","delta":"Hi"}',
];

const ANTHROPIC_FRAMES = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"claude","content":[],"usage":{"input_tokens":1,"output_tokens":1}}}',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
];

/**
 * Opens a raw socket, sends the request, waits for the first response bytes,
 * then destroys the connection the way a killed client does.
 */
async function disconnectMidStream(port: number, model: string): Promise<string> {
  let sawBytes: () => void;
  const received: string[] = [];
  const committed = new Promise<void>((resolve) => (sawBytes = resolve));
  const body = JSON.stringify({
    model,
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });
  const request =
    `POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n` +
    `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`;

  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      open(s) {
        s.write(request);
      },
      data(_s, chunk) {
        received.push(new TextDecoder().decode(chunk));
        sawBytes();
      },
      error() {},
      close() {},
    },
  });
  await committed;
  // Abrupt teardown: no FIN handshake, exactly like a killed client.
  socket.terminate();
  return received.join("");
}

/** Fails the assertion if any unhandled rejection lands while `run` executes. */
async function withRejectionWatch(
  run: () => Promise<string>,
): Promise<{ seen: unknown[]; response: string }> {
  const seen: unknown[] = [];
  const onRejection = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", onRejection);
  let response = "";
  try {
    response = await run();
    // Unhandled rejections are reported a turn later; give them time to land.
    await Bun.sleep(600);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  return { seen, response };
}

describe("a client disconnecting mid-stream", () => {
  let poolDir: string;
  let mgr: AccountManager;
  let config: Config;
  let server: Server<unknown> | undefined;

  beforeEach(() => {
    ({ poolDir, mgr, config } = tempPool());
  });

  afterEach(() => {
    server?.stop(true);
    server = undefined;
    rmSync(poolDir, { recursive: true, force: true });
  });

  test("does not leave an unhandled rejection on the Codex path", async () => {
    const upstream = (async () => stallingUpstream(CODEX_FRAMES)) as unknown as typeof fetch;
    const srv = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 255,
      async fetch(req) {
        const body = await req.json();
        return proxyCodexMessages(
          body,
          mgr,
          config,
          req.signal,
          { id: "gpt", provider: "openai", upstreamModel: "gpt-5.2-codex" } as never,
          {},
          upstream,
        );
      },
    });

    server = srv;
    const port = srv.port!;
    const { seen, response } = await withRejectionWatch(() => disconnectMidStream(port, "gpt"));
    // Guard against a vacuous pass: the stream must really have opened.
    expect(response).toContain("message_start");
    expect(seen).toEqual([]);
  });

  test("does not leave an unhandled rejection on the Anthropic path", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => stallingUpstream(ANTHROPIC_FRAMES)) as unknown as typeof fetch;
    try {
      const srv = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: 255,
        async fetch(req) {
          const body = await req.json();
          return proxyAnthropicMessages(body, req.headers, mgr, config, req.signal, {});
        },
      });

      server = srv;
      const port = srv.port!;
      const { seen, response } = await withRejectionWatch(() => disconnectMidStream(port, "claude-sonnet-5"));
      expect(response).toContain("message_start");
      expect(seen).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
