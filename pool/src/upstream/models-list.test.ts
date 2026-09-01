import { beforeEach, expect, test } from "bun:test";
import {
  ANTHROPIC_OWNER,
  MODELS_CACHE_TTL_MS,
  OPENAI_OWNER,
  buildModelListing,
  fetchAnthropicModels,
  resetModelsCache,
  type LiveModelsDeps,
} from "./models-list.ts";
import type { ModelRoute } from "../models.ts";

const upstream = {
  data: [
    { type: "model", id: "claude-fable-5-1", display_name: "Claude Fable 5.1", created_at: "2026-08-28T00:00:00Z", max_input_tokens: 1000000 },
    { type: "model", id: "claude-opus-5", display_name: "Claude Opus 5", created_at: "2026-07-01T00:00:00Z", max_input_tokens: 1000000 },
    { id: "" }, // malformed rows are dropped, not fatal
  ],
};

function deps(over: Partial<LiveModelsDeps> & { calls?: { n: number; headers?: Record<string, string>; url?: string } } = {}): LiveModelsDeps {
  const calls = over.calls ?? { n: 0 };
  return {
    baseUrl: "https://api.example",
    token: async () => "tok-1",
    userAgent: "claude-code/test",
    timeoutMs: 1000,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.n++;
      calls.url = String(url);
      calls.headers = init?.headers as Record<string, string>;
      return new Response(JSON.stringify(upstream), { status: 200 });
    }) as unknown as typeof fetch,
    ...over,
  };
}

const TABLE: ModelRoute[] = [
  { id: "opus", provider: "anthropic", upstreamModel: "opus" },
  { id: "claude-opus-5", provider: "anthropic", upstreamModel: "claude-opus-5" },
  { id: "gpt-5.6-sol", provider: "openai", upstreamModel: "gpt-5.6-sol" },
];

beforeEach(resetModelsCache);

test("lists Anthropic's live catalog using the account's OAuth token", async () => {
  const calls = { n: 0 } as { n: number; headers?: Record<string, string>; url?: string };
  const models = await fetchAnthropicModels(deps({ calls }));
  expect(calls.url).toBe("https://api.example/v1/models?limit=1000");
  expect(calls.headers?.authorization).toBe("Bearer tok-1");
  expect(calls.headers?.["anthropic-beta"]).toBe("oauth-2025-04-20");
  expect(models?.map((m) => m.id)).toEqual(["claude-fable-5-1", "claude-opus-5"]);
  expect(models?.[0]).toMatchObject({
    object: "model",
    owned_by: ANTHROPIC_OWNER,
    display_name: "Claude Fable 5.1",
    max_input_tokens: 1000000,
    created: Math.floor(Date.parse("2026-08-28T00:00:00Z") / 1000),
  });
});

test("caches for the TTL and refetches after it", async () => {
  let t = 1_000_000;
  const calls = { n: 0 };
  const d = deps({ calls, now: () => t });
  await fetchAnthropicModels(d);
  await fetchAnthropicModels(d);
  expect(calls.n).toBe(1);
  t += MODELS_CACHE_TTL_MS + 1;
  await fetchAnthropicModels(d);
  expect(calls.n).toBe(2);
});

test("serves the last good list when upstream fails or no account is available", async () => {
  let t = 1_000_000;
  let ok = true;
  const d = deps({
    now: () => t,
    fetch: (async () => (ok ? new Response(JSON.stringify(upstream)) : new Response("nope", { status: 500 }))) as unknown as typeof fetch,
  });
  expect((await fetchAnthropicModels(d))?.length).toBe(2);
  t += MODELS_CACHE_TTL_MS + 1;
  ok = false;
  expect((await fetchAnthropicModels(d))?.length).toBe(2);
  expect((await fetchAnthropicModels({ ...d, token: async () => null }))?.length).toBe(2);
});

test("returns null with nothing cached when there is no token or upstream is down", async () => {
  expect(await fetchAnthropicModels(deps({ token: async () => null }))).toBeNull();
  expect(await fetchAnthropicModels(deps({ fetch: (async () => { throw new Error("down"); }) as unknown as typeof fetch }))).toBeNull();
  expect(await fetchAnthropicModels(deps({ fetch: (async () => new Response("{}")) as unknown as typeof fetch }))).toBeNull();
});

test("buildModelListing lists live Claude entries, then unlisted table routes, then OpenAI", () => {
  const live = [{ id: "claude-opus-5", object: "model" as const, created: 0, owned_by: ANTHROPIC_OWNER }];
  // `opus` (alias) still routes so it stays listed; `claude-opus-5` is not duplicated.
  expect(buildModelListing(live, TABLE).map((m) => m.id)).toEqual(["claude-opus-5", "opus", "gpt-5.6-sol"]);
  expect(buildModelListing(live, TABLE)[2]?.owned_by).toBe(OPENAI_OWNER);
});

test("fetch keeps a path prefix on the base URL, including a /v1 suffix", async () => {
  const calls = { n: 0 } as { n: number; url?: string };
  await fetchAnthropicModels(deps({ calls, baseUrl: "https://gw.example/anthropic/" }));
  expect(calls.url).toBe("https://gw.example/anthropic/v1/models?limit=1000");
  resetModelsCache();
  await fetchAnthropicModels(deps({ calls, baseUrl: "https://gw.example/anthropic/v1" }));
  expect(calls.url).toBe("https://gw.example/anthropic/v1/models?limit=1000");
});

test("concurrent cold-cache requests share one upstream call", async () => {
  const calls = { n: 0 };
  const d = deps({ calls });
  const [a, b, c] = await Promise.all([fetchAnthropicModels(d), fetchAnthropicModels(d), fetchAnthropicModels(d)]);
  expect(calls.n).toBe(1);
  expect(a).toBe(b);
  expect(b).toBe(c);
});

test("buildModelListing falls back to the table's Claude entries without a live list", () => {
  expect(buildModelListing(null, TABLE).map((m) => m.id)).toEqual(["opus", "claude-opus-5", "gpt-5.6-sol"]);
});
