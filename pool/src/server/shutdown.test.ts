import { describe, expect, test } from "bun:test";
import { drainAndStop } from "./shutdown.ts";

function slowServer(delayMs: number) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      await new Promise((r) => setTimeout(r, delayMs));
      return new Response("done");
    },
  });
}

describe("drainAndStop", () => {
  test("lets an in-flight request finish before resolving", async () => {
    const server = slowServer(300);
    const url = `http://127.0.0.1:${server.port}/`;

    // connection: close so the follow-up fetch below needs a fresh connection.
    const inflight = fetch(url, { headers: { connection: "close" } });
    // Give the request time to reach the server before draining.
    await new Promise((r) => setTimeout(r, 50));

    const drained = drainAndStop(server, 5_000);
    const res = await inflight;
    expect(await res.text()).toBe("done");
    expect(await drained).toBe("drained");

    // New connections are refused once draining has begun.
    await expect(fetch(url)).rejects.toThrow();
  });

  test("gives up waiting once the drain timeout elapses", async () => {
    const server = slowServer(3_000);
    const url = `http://127.0.0.1:${server.port}/`;

    const inflight = fetch(url).then((r) => r.text()).catch(() => "aborted");
    await new Promise((r) => setTimeout(r, 50));

    const start = Date.now();
    expect(await drainAndStop(server, 200)).toBe("timeout");
    expect(Date.now() - start).toBeLessThan(2_000);

    // In production the caller process.exit()s here; in the test just let the
    // straggler finish so nothing leaks.
    await inflight;
  });

  test("resolves immediately when idle", async () => {
    const server = slowServer(10);
    const start = Date.now();
    expect(await drainAndStop(server, 5_000)).toBe("drained");
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});
