import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const fixture = join(import.meta.dir, "fixtures", "ingress-timeout-child.ts");
const proxyKey = "ingress-test-key";
const delayMs = 5_500;

interface Child {
  dir: string;
  origin: string;
  proc: Bun.Subprocess;
}

const children: Child[] = [];

function timeoutAfter<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function testTempDir(): string {
  const base = process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, "tmp") : tmpdir();
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, "ingress-timeout-"));
}

function writeFixtureState(dir: string): string {
  const accountDir = join(dir, "accounts", "test");
  mkdirSync(accountDir, { recursive: true });
  writeFileSync(
    join(accountDir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "test-token", expiresAt: Date.now() + 86_400_000 } }),
  );

  const claudeBin = join(dir, "fake-claude");
  writeFileSync(
    claudeBin,
    "#!/bin/sh\nsleep 5.5\nprintf '%s\\n' '{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"ok\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1},\"total_cost_usd\":0}'\n",
  );
  chmodSync(claudeBin, 0o755);
  return claudeBin;
}

async function startChild(requestTimeoutMs = 10_000): Promise<Child> {
  const dir = testTempDir();
  const claudeBin = writeFixtureState(dir);
  const proc = Bun.spawn([process.execPath, fixture], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      CLAUDE_POOL_DIR: dir,
      CLAUDE_BIN: claudeBin,
      ANTHROPIC_API_BASE_URL: "https://ingress-test.invalid",
      PROXY_API_KEY: proxyKey,
      CLAUDE_USAGE_REFRESH: "0",
      REQUEST_TIMEOUT_MS: String(requestTimeoutMs),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const child = { dir, origin: "", proc };
  children.push(child);

  try {
    const ready = (async () => {
      let output = "";
      for await (const chunk of proc.stdout) {
        output += new TextDecoder().decode(chunk);
        const origin = output.match(/INGRESS_TEST_READY (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
        if (origin) return origin;
      }
      throw new Error(`Ingress fixture exited before becoming ready: ${output}`);
    })();
    child.origin = await timeoutAfter(ready, 5_000, "Ingress fixture startup");
    return child;
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

async function stopChild(child: Child): Promise<void> {
  const index = children.indexOf(child);
  if (index >= 0) children.splice(index, 1);
  try {
    child.proc.kill();
    await timeoutAfter(child.proc.exited, 3_000, "Ingress fixture shutdown");
  } catch {
    try {
      child.proc.kill("SIGKILL");
      await timeoutAfter(child.proc.exited, 3_000, "Forced ingress fixture shutdown");
    } catch {}
  } finally {
    rmSync(child.dir, { recursive: true, force: true });
  }
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(stopChild));
});

function authHeaders() {
  return { authorization: `Bearer ${proxyKey}`, "content-type": "application/json" };
}

function messagesBody(stream: boolean): string {
  return JSON.stringify({
    model: "claude-sonnet-4-5",
    max_tokens: 16,
    stream,
    messages: [{ role: "user", content: "hello" }],
  });
}

function chatBody(stream: boolean): string {
  return JSON.stringify({
    model: "sonnet",
    stream,
    messages: [{ role: "user", content: "hello" }],
  });
}

describe("inference ingress timeout ownership", () => {
  test("keeps authenticated inference alive while uploads and ordinary routes retain their bounds", async () => {
    const child = await startChild();
    const started = Date.now();
    const [messagesJson, messagesStream, chatJson, chatStream] = await Promise.all([
      fetch(`${child.origin}/v1/messages`, { method: "POST", headers: authHeaders(), body: messagesBody(false) }),
      fetch(`${child.origin}/v1/messages`, { method: "POST", headers: authHeaders(), body: messagesBody(true) }),
      fetch(`${child.origin}/v1/chat/completions`, { method: "POST", headers: authHeaders(), body: chatBody(false) }),
      fetch(`${child.origin}/v1/chat/completions`, { method: "POST", headers: authHeaders(), body: chatBody(true) }),
    ]);

    expect(Date.now() - started).toBeGreaterThanOrEqual(delayMs - 500);
    expect(messagesJson.status).toBe(200);
    expect(await messagesJson.json()).toMatchObject({ type: "message", content: [{ text: "ok" }] });
    expect(messagesStream.status).toBe(200);
    expect(await messagesStream.text()).toContain("message_stop");
    expect(chatJson.status).toBe(200);
    expect(await chatJson.json()).toMatchObject({ choices: [{ message: { content: "ok" } }] });
    expect(chatStream.status).toBe(200);
    expect(await chatStream.text()).toContain("[DONE]");

    const invalidJson = await fetch(`${child.origin}/v1/messages`, {
      method: "POST",
      headers: authHeaders(),
      body: "{",
    });
    expect(invalidJson.status).toBe(400);
    const unauthorized = await fetch(`${child.origin}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: messagesBody(false),
    });
    expect(unauthorized.status).toBe(401);
    expect((await fetch(`${child.origin}/health`)).status).toBe(200);

    const timeouts = await (await fetch(`${child.origin}/__ingress-timeouts`)).json() as { path: string; seconds: number }[];
    expect(timeouts).toHaveLength(4);
    expect(timeouts).toEqual(expect.arrayContaining([
      { path: "/v1/messages", seconds: 0 },
      { path: "/v1/chat/completions", seconds: 0 },
    ]));
    expect(timeouts.every((entry) => entry.seconds === 0)).toBe(true);
  }, 20_000);

  test("keeps the pool deadline structured and survives an original-client cancellation", async () => {
    const deadlineChild = await startChild(500);
    const expired = await fetch(`${deadlineChild.origin}/v1/messages`, {
      method: "POST",
      headers: authHeaders(),
      body: messagesBody(false),
    });
    expect(expired.status).toBe(502);
    expect(expired.status).not.toBe(401);
    expect(await expired.json()).toMatchObject({ type: "error", error: { type: "api_error" } });

    const cancellationChild = await startChild();
    const controller = new AbortController();
    const canceled = fetch(`${cancellationChild.origin}/v1/messages`, {
      method: "POST",
      headers: authHeaders(),
      body: messagesBody(false),
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    await expect(canceled).rejects.toThrow();
    expect((await fetch(`${cancellationChild.origin}/health`)).status).toBe(200);
  }, 20_000);
});
