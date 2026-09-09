import { test, expect } from "bun:test";
import * as shared from "./shared.ts";
import { loadConfig } from "../config.ts";

const enc = new TextEncoder();

test("makeAbort respects signals aborted before registration", () => {
  const controller = new AbortController(); controller.abort();
  const wired = shared.makeAbort(loadConfig(), controller.signal);
  try { expect(wired.signal.aborted).toBe(true); } finally { wired.cleanup(); }
});

test("inference idle watchdog cuts a silent real HTTP body", async () => {
  expect(typeof shared.fetchWithIdleTimeout).toBe("function");
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch() {
    return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode("prefix")); } }));
  } });
  const start = Date.now();
  try {
    const { response, cleanup } = await shared.fetchWithIdleTimeout(server.url, {}, 100);
    try { await expect(response.text()).rejects.toThrow("idle"); }
    finally { cleanup(); }
    expect(Date.now() - start).toBeLessThan(2000);
  } finally { server.stop(true); }
});

test("inference idle watchdog permits progress longer than a single idle window", async () => {
  expect(typeof shared.fetchWithIdleTimeout).toBe("function");
  const timers: ReturnType<typeof setTimeout>[] = [];
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch() {
    return new Response(new ReadableStream({ start(c) {
      c.enqueue(enc.encode("a"));
      timers.push(setTimeout(() => c.enqueue(enc.encode("b")), 100));
      timers.push(setTimeout(() => { c.enqueue(enc.encode("c")); c.close(); }, 200));
    } }));
  } });
  try {
    const { response, cleanup } = await shared.fetchWithIdleTimeout(server.url, {}, 150);
    try { expect(await response.text()).toBe("abc"); } finally { cleanup(); }
  } finally { timers.forEach(clearTimeout); server.stop(true); }
});

test("inference idle watchdog also bounds header waiting", async () => {
  expect(typeof shared.fetchWithIdleTimeout).toBe("function");
  const server = Bun.serve({ port: 0, idleTimeout: 0, async fetch() { await Bun.sleep(200); return new Response("late"); } });
  try { await expect(shared.fetchWithIdleTimeout(server.url, {}, 30)).rejects.toThrow("idle"); }
  finally { server.stop(true); }
});


test("zero-length chunks cannot postpone the demanded-read idle deadline", async () => {
  let interval: ReturnType<typeof setInterval>;
  const upstream = new Response(new ReadableStream<Uint8Array>({
    start(c) { interval = setInterval(() => c.enqueue(new Uint8Array()), 5); },
    cancel() { clearInterval(interval); },
  }));
  const { response, cleanup } = await shared.fetchWithIdleTimeout("https://example.invalid", { signal: AbortSignal.timeout(200) }, 30, Object.assign(async () => upstream, { preconnect() {} }));
  try { await expect(response.text()).rejects.toThrow("idle"); }
  finally { cleanup(); clearInterval(interval!); }
});

test("downstream backpressure does not consume upstream idle budget and bytes stay unchanged", async () => {
  let timer: ReturnType<typeof setTimeout>;
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch() {
    return new Response(new ReadableStream<Uint8Array>({ start(c) {
      c.enqueue(new Uint8Array([0, 1, 255]));
      timer = setTimeout(() => { c.enqueue(new Uint8Array([7, 8])); c.close(); }, 30);
    } }), { status: 201, statusText: "Created", headers: { "x-test": "preserved" } });
  } });
  try {
    const { response, cleanup } = await shared.fetchWithIdleTimeout(server.url, {}, 50);
    try {
      expect(response.status).toBe(201); expect(response.statusText).toBe("Created");
      expect(response.headers.get("x-test")).toBe("preserved");
      const reader = response.body!.getReader();
      expect(Array.from((await reader.read()).value!)).toEqual([0, 1, 255]);
      await Bun.sleep(120);
      expect(Array.from((await reader.read()).value!)).toEqual([7, 8]);
      expect((await reader.read()).done).toBe(true);
    } finally { cleanup(); }
  } finally { clearTimeout(timer!); server.stop(true); }
});

test("cancelling a wrapped HTTP body cancels the upstream connection", async () => {
  let cancelled!: () => void;
  const disconnected = new Promise<void>(resolve => { cancelled = resolve; });
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch(req) {
    req.signal.addEventListener("abort", cancelled, { once: true });
    return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode("x")); } }));
  } });
  try {
    const { response, cleanup } = await shared.fetchWithIdleTimeout(server.url, {}, 1000);
    const reader = response.body!.getReader(); await reader.read(); await reader.cancel(); cleanup();
    const result = await Promise.race([disconnected.then(() => true), Bun.sleep(500).then(() => false)]);
    expect(result).toBe(true);
  } finally { server.stop(true); }
});

test("the attempt deadline still wins while upstream sends continuous progress", async () => {
  let interval: ReturnType<typeof setInterval>;
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch() {
    return new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc.encode(".")); interval = setInterval(() => c.enqueue(enc.encode(".")), 10); },
      cancel() { clearInterval(interval); },
    }));
  } });
  const attempt = shared.makeAbort(loadConfig({ requestTimeoutMs: 100 }), new AbortController().signal);
  try {
    const { response, cleanup } = await shared.fetchWithIdleTimeout(server.url, { signal: attempt.signal }, 50);
    try { await expect(response.text()).rejects.toThrow(); expect(attempt.signal.aborted).toBe(true); }
    finally { cleanup(); }
  } finally { attempt.cleanup(); clearInterval(interval!); server.stop(true); }
});
