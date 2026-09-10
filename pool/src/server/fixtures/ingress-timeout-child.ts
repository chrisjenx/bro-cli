import { startServer } from "../server.ts";
import { loadConfig } from "../../config.ts";

const delayMs = 5_500;
const fakeBase = "https://ingress-test.invalid";
const timeoutEvents: { path: string; seconds: number }[] = [];
const nativeFetch = globalThis.fetch;

function waitForDelay(signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, delayMs);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

const fakeFetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.startsWith(fakeBase)) return nativeFetch(input, init);

  await waitForDelay(init?.signal);
  const body = JSON.parse(String(init?.body ?? "{}")) as { stream?: boolean };
  if (body.stream) {
    return new Response(
      "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_test\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"claude-test\",\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  }
  return new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      model: "claude-test",
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { headers: { "content-type": "application/json" } },
  );
};
globalThis.fetch = fakeFetch as typeof fetch;

const originalServe = Bun.serve;
const mutableBun = Bun as unknown as { serve: (options: Record<string, unknown>) => Bun.Server<unknown> };
let server: Bun.Server<unknown> | undefined;
mutableBun.serve = (options) => {
  const handler = options.fetch as ((request: Request, srv: Bun.Server<unknown>) => Response | Promise<Response>) | undefined;
  if (!handler) throw new Error("Expected startServer to provide a fetch handler");
  server = originalServe({
    ...options,
    idleTimeout: 1,
    fetch(request, srv) {
      if (request.method === "GET" && new URL(request.url).pathname === "/__ingress-timeouts") {
        return Response.json(timeoutEvents);
      }
      const observed = new Proxy(srv, {
        get(target, property, receiver) {
          if (property === "timeout") {
            return (timedRequest: Request, seconds: number) => {
              timeoutEvents.push({ path: new URL(timedRequest.url).pathname, seconds });
              return target.timeout(timedRequest, seconds);
            };
          }
          return Reflect.get(target, property, target);
        },
      });
      return handler(request, observed);
    },
  } as Parameters<typeof Bun.serve>[0]);
  return server;
};

startServer(loadConfig({
  host: "127.0.0.1",
  port: 0,
  backend: "oauth",
  usageRefreshEnabled: false,
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS ?? 10_000),
  overloadRetryMax: 0,
}));

if (!server) throw new Error("Bun.serve did not return a server");
console.log(`INGRESS_TEST_READY http://127.0.0.1:${server.port}`);
