# Pool OpenAI (ChatGPT Subscription) Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route Anthropic-protocol requests for OpenAI model ids to OpenAI's Codex backend using pooled ChatGPT-subscription OAuth accounts, so Claude Code can `/model`-switch to GPT models mid-session with load balancing and failover.

**Architecture:** `POST /v1/messages` branches on `body.model` through a model table: OpenAI models go to a new `upstream/openai-codex.ts` proxy that translates Anthropic Messages ⇄ OpenAI Responses API (request and SSE), backed by provider-tagged accounts in the existing `AccountManager` (per-provider selection + per-provider session affinity). Rate-limit headroom parses Codex's `x-codex-*` headers into the existing `RateLimitSnapshot`.

**Tech Stack:** Bun + TypeScript (pool server, `bun test`), Node ESM JS (bro CLI). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-08-pool-openai-routing-design.md`

## Global Constraints

- TDD for every task: write the failing test first (RED), run it and see it fail, implement, run it and see it pass (GREEN), commit.
- Run tests from the `pool/` directory: `cd pool && bun test <file>`.
- OpenAI platform API keys are OUT OF SCOPE. Subscription OAuth only.
- Never log or print access/refresh tokens.
- Anthropic-path behavior must be byte-identical for Claude models (no regression: `bun test` full suite green after every task).
- All new pool code follows existing style: no classes unless stateful, `parseJson`/`stringProp`-style narrow helpers, `.ts` extension imports.
- Commit after every task with a conventional message.

---

### Task 1: Verify Codex protocol constants against the open-source Codex CLI

The Codex CLI is Apache-2.0 open source at `github.com/openai/codex`. Every constant below is used by later tasks; this task pins them to verified values so nothing downstream is built on a guess.

**Files:**
- Create: `pool/src/upstream/codex-constants.ts`
- Test: none (research task; the deliverable is a constants file with source citations)

**Interfaces:**
- Produces: `CODEX_AUTH_BASE_URL`, `CODEX_TOKEN_URL`, `CODEX_CLIENT_ID`, `CODEX_RESPONSES_URL`, `CODEX_OAUTH_REDIRECT_PORT`, `CODEX_OAUTH_SCOPES`, `CODEX_ORIGINATOR`, `CODEX_RATE_LIMIT_HEADERS` (all `const` strings/numbers).

- [ ] **Step 1: Clone the Codex CLI source shallowly and locate the constants**

```bash
git clone --depth 1 https://github.com/openai/codex /tmp/codex-src
grep -rn "auth.openai.com\|client_id\|chatgpt.com/backend-api\|x-codex" /tmp/codex-src/codex-rs --include="*.rs" | head -50
```

Files to read: `codex-rs/login/src/server.rs` (OAuth flow: client id, auth URL, token URL, redirect port, scopes), `codex-rs/core/src/auth.rs` (refresh flow, `auth.json` shape), `codex-rs/core/src/client.rs` or similar (backend URL, request headers like `chatgpt-account-id`, `originator`, `OpenAI-Beta`, and the `x-codex-*` rate-limit response headers / `rate_limits` SSE fields).

- [ ] **Step 2: Write the constants file with verified values**

Expected values (each MUST be confirmed or corrected from the source read in Step 1 — if a value differs, use the source's value and note the file:line in the comment):

```ts
/**
 * Protocol constants for OpenAI's Codex backend (ChatGPT-subscription traffic).
 * Every value verified against the open-source Codex CLI (github.com/openai/codex),
 * commit <sha>, on 2026-07-08. Cite the source file next to each constant.
 */

/** OAuth authorization endpoint (browser flow). — codex-rs/login/src/server.rs */
export const CODEX_AUTH_URL = "https://auth.openai.com/oauth/authorize";
/** OAuth token endpoint (code exchange + refresh). — codex-rs/login/src/server.rs */
export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
/** Public OAuth client id used by the Codex CLI. — codex-rs/login/src/server.rs */
export const CODEX_CLIENT_ID = "<verify: app_…>";
/** Localhost callback port the registered redirect URI expects. */
export const CODEX_OAUTH_REDIRECT_PORT = 1455;
export const CODEX_OAUTH_SCOPES = "openid profile email offline_access";
/** Responses-API endpoint subscription traffic posts to. — codex-rs/core/src/… */
export const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
/** `originator` header value identifying the client. */
export const CODEX_ORIGINATOR = "codex_cli_rs";

/** Response headers carrying rolling-window usage (verify exact names). */
export const CODEX_RATE_LIMIT_HEADERS = {
  primaryUsedPercent: "x-codex-primary-used-percent",
  primaryWindowMinutes: "x-codex-primary-window-minutes",
  primaryResetsInSeconds: "x-codex-primary-resets-in-seconds",
  secondaryUsedPercent: "x-codex-secondary-used-percent",
  secondaryWindowMinutes: "x-codex-secondary-window-minutes",
  secondaryResetsInSeconds: "x-codex-secondary-resets-in-seconds",
} as const;
```

Also record in the file's comment: the shape of `~/.codex/auth.json` (`{ tokens: { id_token, access_token, refresh_token, account_id }, last_refresh }` — verify field names), which header carries the ChatGPT account id (`chatgpt-account-id` — verify), and whether an `OpenAI-Beta: responses=experimental` header is required.

- [ ] **Step 3: Typecheck and commit**

```bash
cd pool && bunx tsc --noEmit
git add src/upstream/codex-constants.ts
git commit -m "feat(pool): add verified Codex protocol constants"
```

---

### Task 2: Provider-tagged account types

**Files:**
- Modify: `pool/src/accounts/types.ts`
- Test: `pool/src/accounts/manager.test.ts` (append)

**Interfaces:**
- Produces: `type Provider = "anthropic" | "openai"`, `interface OpenAIOauthCreds { accessToken?: string; refreshToken?: string; accountId?: string; expiresAt?: number }`, `Account.provider: Provider`, `OPENAI_CREDS_FILENAME = "openai-auth.json"`.

- [ ] **Step 1: Write the failing test (RED)**

Append to `pool/src/accounts/manager.test.ts` (it already builds a temp-pool-dir `Config`; reuse its helper — check its top for the existing `makeConfig()`/tmp-dir pattern and use the same one):

```ts
import { OPENAI_CREDS_FILENAME } from "./types.ts";

describe("provider tagging", () => {
  test("account with openai-auth.json is provider openai; default is anthropic", () => {
    const config = makeConfig(); // existing test helper
    const mgr = new AccountManager(config);
    mgr.create("claude1");
    writeFileSync(join(mgr.configDirFor("claude1"), ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "at", refreshToken: "rt" } }));
    mgr.create("gpt1");
    writeFileSync(join(mgr.configDirFor("gpt1"), OPENAI_CREDS_FILENAME),
      JSON.stringify({ accessToken: "at", refreshToken: "rt", accountId: "acc_1" }));

    expect(mgr.getAccount("claude1").provider).toBe("anthropic");
    expect(mgr.getAccount("gpt1").provider).toBe("openai");
    expect(mgr.getAccount("gpt1").authenticated).toBe(true);
  });
});
```

- [ ] **Step 2: Run it, confirm RED**

```bash
cd pool && bun test src/accounts/manager.test.ts
```
Expected: FAIL — `OPENAI_CREDS_FILENAME` not exported / `provider` undefined.

- [ ] **Step 3: Implement types**

In `pool/src/accounts/types.ts` add:

```ts
export type Provider = "anthropic" | "openai";

/** Filename inside an account dir that marks it as an OpenAI account. */
export const OPENAI_CREDS_FILENAME = "openai-auth.json";

/**
 * Normalized ChatGPT-subscription OAuth credential set (from the Codex OAuth
 * flow). Stored as JSON in <accountDir>/openai-auth.json.
 */
export interface OpenAIOauthCreds {
  accessToken?: string;
  refreshToken?: string;
  /** ChatGPT account id sent as the chatgpt-account-id request header. */
  accountId?: string;
  /** Epoch ms when accessToken expires. */
  expiresAt?: number;
  /** Plan name parsed from the id_token claims, for display (e.g. "plus", "pro"). */
  planType?: string;
}
```

And add `provider: Provider;` to the `Account` interface.

(Task 3 makes the manager populate it; the test also drives that, so Steps 3–4 of this task and Task 3 Step 3 may land together if you prefer one commit — acceptable, but keep RED before GREEN.)

- [ ] **Step 4: Implement provider detection in `getAccount`**

In `pool/src/accounts/manager.ts`:

```ts
import { OPENAI_CREDS_FILENAME, type OpenAIOauthCreds, type Provider } from "./types.ts";

// inside the class:
providerFor(name: string): Provider {
  return existsSync(join(this.configDirFor(name), OPENAI_CREDS_FILENAME)) ? "openai" : "anthropic";
}

private openaiCredsPath(name: string): string {
  return join(this.configDirFor(name), OPENAI_CREDS_FILENAME);
}

getOpenAICreds(name: string): OpenAIOauthCreds | null {
  try {
    return JSON.parse(readFileSync(this.openaiCredsPath(name), "utf8")) as OpenAIOauthCreds;
  } catch {
    return null;
  }
}

updateOpenAICreds(name: string, creds: OpenAIOauthCreds): void {
  writeFileSync(this.openaiCredsPath(name), JSON.stringify(creds, null, 2));
}
```

In `getAccount(name)`, branch on provider — OpenAI accounts derive `authenticated` from `getOpenAICreds`, and reuse the same availability logic:

```ts
getAccount(name: string): Account {
  const provider = this.providerFor(name);
  const oauth = provider === "anthropic" ? (this.readCreds(name)?.claudeAiOauth ?? null) : null;
  const openai = provider === "openai" ? this.getOpenAICreds(name) : null;
  const authenticated = provider === "openai" ? Boolean(openai?.accessToken) : Boolean(oauth?.accessToken);
  const tokenExpiresAt = (provider === "openai" ? openai?.expiresAt : oauth?.expiresAt) ?? null;
  // …rest of the existing body unchanged, plus in the returned object:
  //   provider,
  //   subscriptionType: provider === "openai" ? (openai?.planType ?? "chatgpt") : (oauth?.subscriptionType ?? null),
}
```

Keep every other line of `getAccount` exactly as it is today (cooldown, exhaustedReason, usage).

- [ ] **Step 5: Run tests, confirm GREEN (and full suite green)**

```bash
cd pool && bun test
```
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/accounts/types.ts src/accounts/manager.ts src/accounts/manager.test.ts
git commit -m "feat(pool): provider-tagged accounts (anthropic | openai)"
```

---

### Task 3: Provider-aware pick() with per-provider session affinity

**Files:**
- Modify: `pool/src/accounts/manager.ts`
- Test: `pool/src/accounts/manager.test.ts` (append)

**Interfaces:**
- Consumes: `Account.provider` from Task 2.
- Produces: `pick(sessionKey?: string, exclude?: ReadonlySet<string>, provider?: Provider): Account | null` (provider defaults to `"anthropic"`), `setAffinity(sessionKey, accountName, provider)`. Affinity map keyed by `` `${provider}:${sessionKey}` ``.

- [ ] **Step 1: Write the failing test (RED)**

```ts
describe("provider-aware pick", () => {
  test("pick filters by provider and keeps one affinity pin per provider", () => {
    const config = makeConfig();
    const mgr = new AccountManager(config);
    // one authenticated account per provider (same setup as Task 2's test)
    mgr.create("claude1");
    writeFileSync(join(mgr.configDirFor("claude1"), ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "at" } }));
    mgr.create("gpt1");
    writeFileSync(join(mgr.configDirFor("gpt1"), OPENAI_CREDS_FILENAME),
      JSON.stringify({ accessToken: "at" }));

    const a = mgr.pick("sess1");             // default: anthropic
    const o = mgr.pick("sess1", undefined, "openai");
    expect(a?.name).toBe("claude1");
    expect(o?.name).toBe("gpt1");
    // Pins are independent: re-picking either provider returns the same account.
    expect(mgr.pick("sess1")?.name).toBe("claude1");
    expect(mgr.pick("sess1", undefined, "openai")?.name).toBe("gpt1");
  });

  test("pick returns null when no account of the provider exists", () => {
    const config = makeConfig();
    const mgr = new AccountManager(config);
    mgr.create("claude1");
    writeFileSync(join(mgr.configDirFor("claude1"), ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "at" } }));
    expect(mgr.pick(undefined, undefined, "openai")).toBeNull();
  });
});
```

- [ ] **Step 2: Run, confirm RED** — `cd pool && bun test src/accounts/manager.test.ts`. Expected: FAIL (pick ignores the provider arg → both picks return `claude1` / non-null).

- [ ] **Step 3: Implement**

In `pick`, add the parameter and filter, and namespace the affinity key:

```ts
pick(sessionKey?: string, exclude?: ReadonlySet<string>, provider: Provider = "anthropic"): Account | null {
  const affinityKey = sessionKey ? `${provider}:${sessionKey}` : undefined;
  if (affinityKey) {
    const prior = this.sessionAffinity.get(affinityKey);
    if (prior && !exclude?.has(prior)) {
      const acct = this.getAccount(prior);
      if (acct.available && acct.provider === provider) return acct;
      this.sessionAffinity.delete(affinityKey);
    }
  }

  const available = this.listAccounts().filter(
    (a) => a.available && a.provider === provider && !exclude?.has(a.name),
  );
  // …headroom/round-robin selection body unchanged…
  if (affinityKey) this.sessionAffinity.set(affinityKey, best.name);
  return best;
}

setAffinity(sessionKey: string, accountName: string, provider: Provider = "anthropic"): void {
  this.sessionAffinity.set(`${provider}:${sessionKey}`, accountName);
}
```

`markRateLimited`'s affinity-drop loop already deletes by value (`v === name`), which works unchanged with namespaced keys. Update the two existing `setAffinity` call sites (`upstream/anthropic.ts:68` passes no provider → default is fine).

- [ ] **Step 4: Run full suite, confirm GREEN** — `cd pool && bun test`. Expected: all PASS (existing pick tests still pass because the default provider is anthropic).

- [ ] **Step 5: Commit** — `git add -A pool/src && git commit -m "feat(pool): provider-aware account selection with per-provider session affinity"`

---

### Task 4: Codex OAuth module — token refresh + auth.json import

Browser login lands in Task 8 (it needs a callback server and is verified manually); this task builds the pure/testable parts: credential normalization and refresh.

**Files:**
- Create: `pool/src/accounts/openai-oauth.ts`
- Test: `pool/src/accounts/openai-oauth.test.ts`

**Interfaces:**
- Consumes: constants from Task 1; `OpenAIOauthCreds` from Task 2.
- Produces:
  - `normalizeCodexAuthJson(raw: unknown): OpenAIOauthCreds | null` — converts a Codex-CLI `auth.json` object to our shape (also decodes `planType` from the id_token claims when present).
  - `refreshOpenAIToken(creds: OpenAIOauthCreds, fetchFn?: typeof fetch): Promise<OpenAIOauthCreds>` — POSTs `CODEX_TOKEN_URL` with `grant_type=refresh_token`, returns rotated creds; throws on failure. `fetchFn` injectable for tests.

- [ ] **Step 1: Write the failing test (RED)**

```ts
import { describe, expect, test } from "bun:test";
import { normalizeCodexAuthJson, refreshOpenAIToken } from "./openai-oauth.ts";

describe("normalizeCodexAuthJson", () => {
  test("maps the Codex CLI auth.json token block", () => {
    const creds = normalizeCodexAuthJson({
      tokens: { access_token: "at1", refresh_token: "rt1", account_id: "acc_1" },
      last_refresh: "2026-07-08T00:00:00Z",
    });
    expect(creds).toEqual(
      expect.objectContaining({ accessToken: "at1", refreshToken: "rt1", accountId: "acc_1" }),
    );
  });

  test("returns null when there is no access token", () => {
    expect(normalizeCodexAuthJson({})).toBeNull();
    expect(normalizeCodexAuthJson(null)).toBeNull();
  });
});

describe("refreshOpenAIToken", () => {
  test("posts refresh_token grant and returns rotated creds", async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    const fakeFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(url), body: JSON.parse(String(init?.body)) };
      return new Response(
        JSON.stringify({ access_token: "at2", refresh_token: "rt2", expires_in: 3600 }),
        { status: 200 },
      );
    }) as typeof fetch;

    const next = await refreshOpenAIToken(
      { accessToken: "at1", refreshToken: "rt1", accountId: "acc_1" },
      fakeFetch,
    );
    expect(captured!.body.grant_type).toBe("refresh_token");
    expect(captured!.body.refresh_token).toBe("rt1");
    expect(next.accessToken).toBe("at2");
    expect(next.refreshToken).toBe("rt2");
    expect(next.accountId).toBe("acc_1");           // preserved
    expect(next.expiresAt).toBeGreaterThan(Date.now());
  });

  test("throws on non-2xx", async () => {
    const fakeFetch = (async () => new Response("nope", { status: 400 })) as typeof fetch;
    await expect(refreshOpenAIToken({ refreshToken: "rt1" }, fakeFetch)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run, confirm RED** — `cd pool && bun test src/accounts/openai-oauth.test.ts`. Expected: FAIL (module doesn't exist).

- [ ] **Step 3: Implement**

```ts
/**
 * ChatGPT-subscription OAuth for the Codex backend: credential normalization
 * and refresh. The interactive browser login lives in the CLI layer.
 */
import type { OpenAIOauthCreds } from "./types.ts";
import { CODEX_TOKEN_URL, CODEX_CLIENT_ID } from "../upstream/codex-constants.ts";

export function normalizeCodexAuthJson(raw: unknown): OpenAIOauthCreds | null {
  if (raw == null || typeof raw !== "object") return null;
  const root = raw as Record<string, unknown>;
  const tokens = (root.tokens ?? {}) as Record<string, unknown>;
  const accessToken = str(tokens.access_token) ?? str(root.access_token);
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: str(tokens.refresh_token) ?? str(root.refresh_token),
    accountId: str(tokens.account_id) ?? str(root.account_id),
    planType: planFromIdToken(str(tokens.id_token)),
  };
}

export async function refreshOpenAIToken(
  creds: OpenAIOauthCreds,
  fetchFn: typeof fetch = fetch,
): Promise<OpenAIOauthCreds> {
  if (!creds.refreshToken) throw new Error("OpenAI account has no refresh token; re-run accounts login");
  const response = await fetchFn(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: creds.refreshToken,
      client_id: CODEX_CLIENT_ID,
      scope: "openid profile email",
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`OpenAI token refresh failed (${response.status}): ${text.slice(0, 200)}`);
  const json = JSON.parse(text) as Record<string, unknown>;
  const accessToken = str(json.access_token);
  if (!accessToken) throw new Error("OpenAI token refresh returned no access token");
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
  return {
    ...creds,
    accessToken,
    refreshToken: str(json.refresh_token) ?? creds.refreshToken,
    expiresAt: Date.now() + Math.max(1, expiresIn) * 1000,
  };
}

/** Best-effort plan name from the id_token JWT's claims; null on any problem. */
function planFromIdToken(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString());
    const auth = (payload["https://api.openai.com/auth"] ?? {}) as Record<string, unknown>;
    return typeof auth.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : undefined;
  } catch {
    return undefined;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}
```

Note: verify at Task 1 whether the token endpoint expects JSON or `application/x-www-form-urlencoded` (codex-rs source is authoritative) and match it; the test asserts on parsed body fields either way (adjust the test's parse if form-encoded).

- [ ] **Step 4: Run, confirm GREEN** — `cd pool && bun test src/accounts/openai-oauth.test.ts`, then full `bun test`. Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(pool): OpenAI Codex OAuth refresh + auth.json normalization"`

---

### Task 5: Model routing table + `/v1/models` from it

**Files:**
- Create: `pool/src/models.ts`, `pool/src/models.test.ts`
- Modify: `pool/src/config.ts` (add `modelsFile: string` — `join(poolDir, "models.json")`, same pattern as `usageFile`)
- Modify: `pool/src/server/server.ts` (replace hardcoded `MODELS` array in `/v1/models` with the table)

**Interfaces:**
- Produces:
  - `interface ModelRoute { id: string; provider: Provider; upstreamModel: string }`
  - `loadModelTable(modelsFile: string): ModelRoute[]` — reads `models.json`, falls back to `DEFAULT_MODEL_TABLE` when missing/invalid, and merges defaults for ids the file doesn't override.
  - `resolveModel(table: ModelRoute[], modelId: string): ModelRoute` — exact-id match; unknown ids return `{ id: modelId, provider: "anthropic", upstreamModel: modelId }` (today's pass-through behavior).
  - `DEFAULT_MODEL_TABLE: ModelRoute[]` — the six current Claude entries plus OpenAI seeds: `{ id: "gpt-5.2-codex", provider: "openai", upstreamModel: "gpt-5.2-codex" }`, `{ id: "gpt-5.1-codex-max", provider: "openai", upstreamModel: "gpt-5.1-codex-max" }` (Task 9's `models update` refreshes these from the live backend).

- [ ] **Step 1: Write the failing test (RED)**

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadModelTable, resolveModel, DEFAULT_MODEL_TABLE } from "./models.ts";

describe("model table", () => {
  test("unknown model id falls through to anthropic pass-through", () => {
    const r = resolveModel(DEFAULT_MODEL_TABLE, "claude-sonnet-5");
    expect(r.provider).toBe("anthropic");
    expect(r.upstreamModel).toBe("claude-sonnet-5");
    expect(resolveModel(DEFAULT_MODEL_TABLE, "some-future-model").provider).toBe("anthropic");
  });

  test("openai models route to openai with the mapped upstream id", () => {
    const table = [...DEFAULT_MODEL_TABLE, { id: "gpt", provider: "openai" as const, upstreamModel: "gpt-5.2-codex" }];
    const r = resolveModel(table, "gpt");
    expect(r.provider).toBe("openai");
    expect(r.upstreamModel).toBe("gpt-5.2-codex");
  });

  test("loadModelTable merges file entries over defaults and survives a missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-models-"));
    const file = join(dir, "models.json");
    expect(loadModelTable(file)).toEqual(DEFAULT_MODEL_TABLE);
    writeFileSync(file, JSON.stringify({ models: [{ id: "gpt-x", provider: "openai", upstreamModel: "gpt-x" }] }));
    const table = loadModelTable(file);
    expect(table.find((m) => m.id === "gpt-x")?.provider).toBe("openai");
    expect(table.find((m) => m.id === "opus")).toBeDefined(); // defaults kept
  });
});
```

- [ ] **Step 2: Run, confirm RED** — `cd pool && bun test src/models.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement `pool/src/models.ts`**

```ts
/** Model-id → provider routing table, persisted at <poolDir>/models.json. */
import { existsSync, readFileSync, writeFileSync } from "fs";
import type { Provider } from "./accounts/types.ts";

export interface ModelRoute {
  id: string;
  provider: Provider;
  upstreamModel: string;
}

const claude = (id: string): ModelRoute => ({ id, provider: "anthropic", upstreamModel: id });
const openai = (id: string): ModelRoute => ({ id, provider: "openai", upstreamModel: id });

export const DEFAULT_MODEL_TABLE: ModelRoute[] = [
  claude("opus"), claude("sonnet"), claude("haiku"),
  claude("claude-opus-4-8"), claude("claude-sonnet-5"), claude("claude-haiku-4-5"),
  openai("gpt-5.2-codex"), openai("gpt-5.1-codex-max"),
];

export function loadModelTable(modelsFile: string): ModelRoute[] {
  let fromFile: ModelRoute[] = [];
  if (existsSync(modelsFile)) {
    try {
      const parsed = JSON.parse(readFileSync(modelsFile, "utf8")) as { models?: unknown };
      if (Array.isArray(parsed.models)) {
        fromFile = parsed.models.filter(isModelRoute);
      }
    } catch {
      // fall through to defaults
    }
  }
  const ids = new Set(fromFile.map((m) => m.id));
  return [...DEFAULT_MODEL_TABLE.filter((m) => !ids.has(m.id)), ...fromFile];
}

export function saveModelTable(modelsFile: string, models: ModelRoute[]): void {
  writeFileSync(modelsFile, JSON.stringify({ models }, null, 2));
}

export function resolveModel(table: ModelRoute[], modelId: string): ModelRoute {
  return (
    table.find((m) => m.id === modelId) ??
    { id: modelId, provider: "anthropic", upstreamModel: modelId }
  );
}

function isModelRoute(v: unknown): v is ModelRoute {
  const o = v as Record<string, unknown>;
  return (
    v != null && typeof o.id === "string" && typeof o.upstreamModel === "string" &&
    (o.provider === "anthropic" || o.provider === "openai")
  );
}
```

Add to `pool/src/config.ts` (next to `usageFile`): `modelsFile: string;` in the interface and `modelsFile: join(poolDir, "models.json"),` in `loadConfig`.

In `server.ts`: delete the `MODELS` const; at server start `const modelTable = loadModelTable(config.modelsFile);` and serve `/v1/models` from `modelTable.map((m) => ({ id: m.id, object: "model", created: 0, owned_by: m.provider === "openai" ? "openai-chatgpt-pool" : "anthropic-claude-max-pool" }))`.

- [ ] **Step 4: Run, confirm GREEN** — `cd pool && bun test`. Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(pool): model routing table with models.json persistence"`

---

### Task 6: Protocol translation — Anthropic Messages ⇄ Codex Responses (pure functions)

The heart of the feature. Pure module, no I/O — everything fixture-tested.

**Files:**
- Create: `pool/src/upstream/codex-translate.ts`, `pool/src/upstream/codex-translate.test.ts`

**Interfaces:**
- Produces:
  - `anthropicToCodexRequest(body: Record<string, unknown>, upstreamModel: string): Record<string, unknown>` — full request mapping; always sets `stream: true` and `store: false`.
  - `class CodexToAnthropicStream` — stateful translator: `handleEvent(event: { event: string; data: string }): string[]` returns zero-or-more fully-formatted Anthropic SSE frames (`"event: X\ndata: {...}\n\n"`); `finish(): string[]` flushes `message_delta`/`message_stop`; `usage: { input_tokens: number; output_tokens: number }`; `stopReason: string | null`; `sawError: { type: string; message: string } | null`.
  - `collectAnthropicMessage(frames: string[]): Record<string, unknown>` — folds the emitted SSE frames into a single non-stream Anthropic message JSON (used when the caller didn't ask for streaming).

**Mapping table (implement exactly):**

| Anthropic request | Codex Responses request |
|---|---|
| `system` (string or `[{type:"text",text}]`) | `instructions` (joined text) |
| `messages[role=user].content` string / `[{type:"text"}]` | `input[] {type:"message", role:"user", content:[{type:"input_text", text}]}` |
| `messages[role=assistant]` text blocks | `{type:"message", role:"assistant", content:[{type:"output_text", text}]}` |
| assistant `{type:"tool_use", id, name, input}` | `{type:"function_call", call_id: id, name, arguments: JSON.stringify(input)}` |
| user `{type:"tool_result", tool_use_id, content}` | `{type:"function_call_output", call_id: tool_use_id, output: <content folded to string>}` |
| `tools[] {name, description, input_schema}` | `tools[] {type:"function", name, description, strict: false, parameters: input_schema}` |
| `tool_choice {type:"auto"/"any"/"tool",name}` | `tool_choice: "auto"` / `"required"` / `{type:"function", name}` |
| `max_tokens`, `temperature`, `top_p` | omit `max_tokens` (Codex backend rejects it — verify at Task 1; if accepted, map to `max_output_tokens`); pass `temperature`/`top_p` through if present |
| image blocks, `thinking` config | drop silently (spec: degrade gracefully) |

| Codex SSE event | Anthropic SSE frames emitted |
|---|---|
| `response.created` | `message_start` (empty usage skeleton, model id echoed) |
| `response.output_item.added` item.type=`message` | `content_block_start` `{type:"text"}` |
| `response.output_text.delta` | `content_block_delta` `{type:"text_delta", text: delta}` |
| `response.output_item.added` item.type=`function_call` | `content_block_start` `{type:"tool_use", id: item.call_id, name: item.name}` |
| `response.function_call_arguments.delta` | `content_block_delta` `{type:"input_json_delta", partial_json: delta}` |
| `response.output_item.done` | `content_block_stop` |
| `response.output_item.added` item.type=`reasoning` (and its deltas) | nothing (dropped) |
| `response.completed` | capture `response.usage` (`input_tokens`,`output_tokens`) + stop reason (`tool_use` if any function_call item was seen, else `end_turn`); frames flushed by `finish()` |
| `response.failed` / `error` | record in `sawError`; emit Anthropic `error` frame |

Content-block `index` is a counter the class tracks (increment per `content_block_start`).

- [ ] **Step 1: Write the failing tests (RED)** — the four core fixtures:

```ts
import { describe, expect, test } from "bun:test";
import { anthropicToCodexRequest, CodexToAnthropicStream, collectAnthropicMessage } from "./codex-translate.ts";

const parse = (frame: string) => JSON.parse(frame.split("\ndata: ")[1]!.trim());

describe("anthropicToCodexRequest", () => {
  test("maps system, text turns, tools, and forces stream", () => {
    const out = anthropicToCodexRequest({
      model: "gpt", system: "be brief", max_tokens: 100,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
        { role: "user", content: [{ type: "text", text: "use the tool" }] },
      ],
      tools: [{ name: "read_file", description: "reads", input_schema: { type: "object" } }],
    }, "gpt-5.2-codex");
    expect(out.model).toBe("gpt-5.2-codex");
    expect(out.instructions).toBe("be brief");
    expect(out.stream).toBe(true);
    expect(out.store).toBe(false);
    const input = out.input as Array<Record<string, unknown>>;
    expect(input).toHaveLength(3);
    expect(input[0]).toMatchObject({ type: "message", role: "user" });
    const tools = out.tools as Array<Record<string, unknown>>;
    expect(tools[0]).toMatchObject({ type: "function", name: "read_file" });
  });

  test("maps tool_use/tool_result round-trip", () => {
    const out = anthropicToCodexRequest({
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "read_file", input: { path: "a" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "file contents" }] },
      ],
    }, "gpt-5.2-codex");
    const input = out.input as Array<Record<string, unknown>>;
    expect(input[0]).toMatchObject({ type: "function_call", call_id: "tu_1", name: "read_file", arguments: '{"path":"a"}' });
    expect(input[1]).toMatchObject({ type: "function_call_output", call_id: "tu_1", output: "file contents" });
  });
});

describe("CodexToAnthropicStream", () => {
  const ev = (event: string, data: unknown) => ({ event, data: JSON.stringify(data) });

  test("text turn produces well-formed Anthropic SSE sequence", () => {
    const s = new CodexToAnthropicStream("gpt");
    const frames = [
      ...s.handleEvent(ev("response.created", { response: { id: "r1" } })),
      ...s.handleEvent(ev("response.output_item.added", { item: { type: "message" } })),
      ...s.handleEvent(ev("response.output_text.delta", { delta: "Hel" })),
      ...s.handleEvent(ev("response.output_text.delta", { delta: "lo" })),
      ...s.handleEvent(ev("response.output_item.done", { item: { type: "message" } })),
      ...s.handleEvent(ev("response.completed", { response: { usage: { input_tokens: 10, output_tokens: 5 } } })),
      ...s.finish(),
    ];
    const types = frames.map((f) => parse(f).type);
    expect(types).toEqual([
      "message_start", "content_block_start", "content_block_delta",
      "content_block_delta", "content_block_stop", "message_delta", "message_stop",
    ]);
    expect(s.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    expect(s.stopReason).toBe("end_turn");
    const delta = frames.filter((f) => parse(f).type === "message_delta")[0]!;
    expect(parse(delta).delta.stop_reason).toBe("end_turn");
  });

  test("function call maps to tool_use block and stop_reason tool_use", () => {
    const s = new CodexToAnthropicStream("gpt");
    const frames = [
      ...s.handleEvent(ev("response.created", { response: { id: "r1" } })),
      ...s.handleEvent(ev("response.output_item.added", { item: { type: "function_call", call_id: "c1", name: "read_file" } })),
      ...s.handleEvent(ev("response.function_call_arguments.delta", { delta: '{"path":' })),
      ...s.handleEvent(ev("response.function_call_arguments.delta", { delta: '"a"}' })),
      ...s.handleEvent(ev("response.output_item.done", { item: { type: "function_call" } })),
      ...s.handleEvent(ev("response.completed", { response: { usage: { input_tokens: 1, output_tokens: 2 } } })),
      ...s.finish(),
    ];
    const start = frames.map(parse).find((d) => d.type === "content_block_start")!;
    expect(start.content_block).toMatchObject({ type: "tool_use", id: "c1", name: "read_file" });
    const deltas = frames.map(parse).filter((d) => d.type === "content_block_delta");
    expect(deltas.map((d) => d.delta.partial_json).join("")).toBe('{"path":"a"}');
    expect(s.stopReason).toBe("tool_use");
  });

  test("collectAnthropicMessage folds frames into a non-stream message", () => {
    const s = new CodexToAnthropicStream("gpt");
    const frames = [
      ...s.handleEvent(ev("response.created", { response: { id: "r1" } })),
      ...s.handleEvent(ev("response.output_item.added", { item: { type: "message" } })),
      ...s.handleEvent(ev("response.output_text.delta", { delta: "Hi" })),
      ...s.handleEvent(ev("response.output_item.done", { item: { type: "message" } })),
      ...s.handleEvent(ev("response.completed", { response: { usage: { input_tokens: 3, output_tokens: 1 } } })),
      ...s.finish(),
    ];
    const msg = collectAnthropicMessage(frames);
    expect(msg).toMatchObject({
      type: "message", role: "assistant",
      content: [{ type: "text", text: "Hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 1 },
    });
  });
});
```

- [ ] **Step 2: Run, confirm RED** — `cd pool && bun test src/upstream/codex-translate.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement `codex-translate.ts`**

Request side:

```ts
export function anthropicToCodexRequest(
  body: Record<string, unknown>,
  upstreamModel: string,
): Record<string, unknown> {
  const input: Array<Record<string, unknown>> = [];
  for (const m of (body.messages as Array<Record<string, unknown>> | undefined) ?? []) {
    const role = m.role === "assistant" ? "assistant" : "user";
    const content = m.content;
    if (typeof content === "string") {
      input.push(textMessage(role, content));
      continue;
    }
    if (!Array.isArray(content)) continue;
    const textBlocks: string[] = [];
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === "text" && typeof block.text === "string") {
        textBlocks.push(block.text);
      } else if (block.type === "tool_use") {
        if (textBlocks.length) input.push(textMessage(role, textBlocks.splice(0).join("\n")));
        input.push({
          type: "function_call",
          call_id: String(block.id ?? ""),
          name: String(block.name ?? ""),
          arguments: JSON.stringify(block.input ?? {}),
        });
      } else if (block.type === "tool_result") {
        if (textBlocks.length) input.push(textMessage(role, textBlocks.splice(0).join("\n")));
        input.push({
          type: "function_call_output",
          call_id: String(block.tool_use_id ?? ""),
          output: foldToolResultContent(block.content),
        });
      }
      // image / thinking / anything else: dropped (spec: degrade gracefully)
    }
    if (textBlocks.length) input.push(textMessage(role, textBlocks.join("\n")));
  }

  const out: Record<string, unknown> = {
    model: upstreamModel,
    instructions: foldSystem(body.system),
    input,
    stream: true,
    store: false,
  };
  const tools = (body.tools as Array<Record<string, unknown>> | undefined) ?? [];
  if (tools.length) {
    out.tools = tools
      .filter((t) => typeof t.name === "string")
      .map((t) => ({
        type: "function",
        name: t.name,
        description: t.description ?? "",
        strict: false,
        parameters: t.input_schema ?? { type: "object" },
      }));
    out.tool_choice = mapToolChoice(body.tool_choice);
    out.parallel_tool_calls = false;
  }
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  return out;
}

function textMessage(role: string, text: string): Record<string, unknown> {
  const kind = role === "assistant" ? "output_text" : "input_text";
  return { type: "message", role, content: [{ type: kind, text }] };
}

function foldSystem(system: unknown): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((b) => (typeof (b as Record<string, unknown>).text === "string" ? (b as Record<string, unknown>).text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function foldToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof (b as Record<string, unknown>).text === "string" ? (b as Record<string, unknown>).text : ""))
      .join("\n");
  }
  return "";
}

function mapToolChoice(choice: unknown): unknown {
  const c = choice as Record<string, unknown> | undefined;
  if (c?.type === "any") return "required";
  if (c?.type === "tool" && typeof c.name === "string") return { type: "function", name: c.name };
  return "auto";
}
```

Stream side — a class holding `blockIndex`, `blockOpen`, `sawToolUse`, `usage`, `stopReason`, `sawError`, `messageId`, emitting `frame(type, payload)` strings shaped `event: <type>\ndata: <json>\n\n`:

```ts
export class CodexToAnthropicStream {
  usage = { input_tokens: 0, output_tokens: 0 };
  stopReason: string | null = null;
  sawError: { type: string; message: string } | null = null;

  private index = -1;
  private blockOpen = false;
  private sawToolUse = false;
  private started = false;
  private finished = false;

  constructor(private modelId: string) {}

  handleEvent(event: { event: string; data: string }): string[] {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      return [];
    }
    const type = (data.type as string | undefined) ?? event.event;
    switch (type) {
      case "response.created":
        if (this.started) return [];
        this.started = true;
        return [frame("message_start", {
          type: "message_start",
          message: {
            id: msgId(data), type: "message", role: "assistant", model: this.modelId,
            content: [], stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        })];
      case "response.output_item.added": {
        const item = (data.item ?? {}) as Record<string, unknown>;
        if (item.type === "message") return [this.openBlock({ type: "text", text: "" })];
        if (item.type === "function_call") {
          this.sawToolUse = true;
          return [this.openBlock({
            type: "tool_use",
            id: String(item.call_id ?? item.id ?? `tu_${this.index + 1}`),
            name: String(item.name ?? ""),
            input: {},
          })];
        }
        return []; // reasoning etc.
      }
      case "response.output_text.delta":
        return this.blockOpen
          ? [frame("content_block_delta", {
              type: "content_block_delta", index: this.index,
              delta: { type: "text_delta", text: String(data.delta ?? "") },
            })]
          : [];
      case "response.function_call_arguments.delta":
        return this.blockOpen
          ? [frame("content_block_delta", {
              type: "content_block_delta", index: this.index,
              delta: { type: "input_json_delta", partial_json: String(data.delta ?? "") },
            })]
          : [];
      case "response.output_item.done":
        return this.closeBlock();
      case "response.completed": {
        const usage = ((data.response as Record<string, unknown>)?.usage ?? {}) as Record<string, unknown>;
        if (typeof usage.input_tokens === "number") this.usage.input_tokens = usage.input_tokens;
        if (typeof usage.output_tokens === "number") this.usage.output_tokens = usage.output_tokens;
        this.stopReason = this.sawToolUse ? "tool_use" : "end_turn";
        return [];
      }
      case "response.failed":
      case "error": {
        const err = ((data.response as Record<string, unknown>)?.error ?? data.error ?? data) as Record<string, unknown>;
        this.sawError = {
          type: String(err.code ?? err.type ?? "api_error"),
          message: String(err.message ?? "Codex backend error"),
        };
        return [frame("error", { type: "error", error: this.sawError })];
      }
      default:
        return [];
    }
  }

  finish(): string[] {
    if (this.finished || !this.started) return [];
    this.finished = true;
    const frames = this.closeBlock();
    frames.push(frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: this.stopReason ?? "end_turn", stop_sequence: null },
      usage: { input_tokens: this.usage.input_tokens, output_tokens: this.usage.output_tokens },
    }));
    frames.push(frame("message_stop", { type: "message_stop" }));
    return frames;
  }

  private openBlock(contentBlock: Record<string, unknown>): string {
    this.index += 1;
    this.blockOpen = true;
    return frame("content_block_start", {
      type: "content_block_start", index: this.index, content_block: contentBlock,
    });
  }

  private closeBlock(): string[] {
    if (!this.blockOpen) return [];
    this.blockOpen = false;
    return [frame("content_block_stop", { type: "content_block_stop", index: this.index })];
  }
}

function frame(eventName: string, payload: Record<string, unknown>): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function msgId(data: Record<string, unknown>): string {
  const r = data.response as Record<string, unknown> | undefined;
  return typeof r?.id === "string" ? r.id : `msg_${Date.now().toString(36)}`;
}
```

`collectAnthropicMessage(frames)`: parse each frame's JSON, replay it into `{ id, type:"message", role:"assistant", model, content: [], stop_reason, stop_sequence: null, usage }` — `content_block_start` appends a block (deep-copy `content_block`), `text_delta` appends to `.text`, `input_json_delta` accumulates a JSON string per tool_use block and `JSON.parse`s it at `content_block_stop` (leaving `{}` on parse failure), `message_delta` sets `stop_reason` + `usage`.

- [ ] **Step 4: Run, confirm GREEN** — `cd pool && bun test src/upstream/codex-translate.test.ts`, then full suite.

- [ ] **Step 5: Commit** — `git commit -am "feat(pool): Anthropic <-> Codex Responses protocol translation"`

---

### Task 7: Codex upstream proxy with failover + rate-limit snapshots

**Files:**
- Create: `pool/src/upstream/openai-codex.ts`, `pool/src/upstream/openai-codex.test.ts`

**Interfaces:**
- Consumes: `anthropicToCodexRequest`, `CodexToAnthropicStream`, `collectAnthropicMessage` (Task 6); `refreshOpenAIToken` (Task 4); `mgr.pick(sessionKey, tried, "openai")`, `mgr.getOpenAICreds`, `mgr.updateOpenAICreds`, `mgr.recordRateLimitSnapshot`, `mgr.markRateLimited`, `mgr.recordSuccess`, `mgr.recordError`; constants (Task 1); `SseParser` — **export the existing `SseParser` class from `upstream/anthropic.ts`** (change `class SseParser` to `export class SseParser`; it's private today).
- Produces: `proxyCodexMessages(body, mgr, config, signal, route: ModelRoute, hooks): Promise<Response>` — same outer contract as `proxyAnthropicMessages` (returns an Anthropic-protocol `Response`, streaming or not, with `X-Pool-Account`).
- Also produces: `parseCodexRateLimitSnapshot(headers: Headers): RateLimitSnapshot` (exported for tests) — primary window → `fiveHour*` fields, secondary → `sevenDay*`; `utilization = usedPercent / 100`; `reset = Date.now() + resetsInSeconds * 1000`; `status` = `"allowed"` when usedPercent < 100 else `"rejected"`; all-null snapshot fields when no headers present.

- [ ] **Step 1: Write the failing tests (RED)**

```ts
import { describe, expect, test } from "bun:test";
import { parseCodexRateLimitSnapshot } from "./openai-codex.ts";

describe("parseCodexRateLimitSnapshot", () => {
  test("maps primary/secondary windows onto the unified snapshot", () => {
    const h = new Headers({
      "x-codex-primary-used-percent": "42.5",
      "x-codex-primary-resets-in-seconds": "3600",
      "x-codex-secondary-used-percent": "10",
      "x-codex-secondary-resets-in-seconds": "86400",
    });
    const before = Date.now();
    const s = parseCodexRateLimitSnapshot(h);
    expect(s.fiveHourUtilization).toBeCloseTo(0.425);
    expect(s.fiveHourStatus).toBe("allowed");
    expect(s.fiveHourReset!).toBeGreaterThanOrEqual(before + 3600_000);
    expect(s.sevenDayUtilization).toBeCloseTo(0.1);
    expect(s.unifiedStatus).toBe("allowed");
  });

  test("exhausted primary window reads as rejected", () => {
    const h = new Headers({ "x-codex-primary-used-percent": "100" });
    const s = parseCodexRateLimitSnapshot(h);
    expect(s.fiveHourStatus).toBe("rejected");
    expect(s.unifiedStatus).toBe("rejected");
  });

  test("no headers → all-null snapshot", () => {
    const s = parseCodexRateLimitSnapshot(new Headers());
    expect(s.fiveHourUtilization).toBeNull();
    expect(s.unifiedStatus).toBeNull();
  });
});
```

Plus one end-to-end proxy test using an injected fetch (add a `fetchFn: typeof fetch = fetch` parameter to `proxyCodexMessages` for this):

```ts
import { proxyCodexMessages } from "./openai-codex.ts";
// build mgr with one authenticated openai account (same tmp-dir setup as manager.test.ts),
// fake fetch returning a canned Codex SSE body:
const sse = [
  'data: {"type":"response.created","response":{"id":"r1"}}',
  'data: {"type":"response.output_item.added","item":{"type":"message"}}',
  'data: {"type":"response.output_text.delta","delta":"Hi"}',
  'data: {"type":"response.output_item.done","item":{"type":"message"}}',
  'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":1}}}',
  "", ""].join("\n");

test("non-stream request returns a folded Anthropic message and records usage", async () => {
  const fakeFetch = (async () =>
    new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream", "x-codex-primary-used-percent": "5" },
    })) as typeof fetch;
  const res = await proxyCodexMessages(
    { model: "gpt", messages: [{ role: "user", content: "hi" }] },
    mgr, config, new AbortController().signal,
    { id: "gpt", provider: "openai", upstreamModel: "gpt-5.2-codex" },
    {}, fakeFetch,
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("X-Pool-Account")).toBe("gpt1");
  const msg = await res.json();
  expect(msg.content).toEqual([{ type: "text", text: "Hi" }]);
  expect(mgr.getAccount("gpt1").usage.windowRequests).toBe(1);
  expect(mgr.getAccount("gpt1").usage.rateLimitStatus?.fiveHourUtilization).toBeCloseTo(0.05);
});

test("429 sidelines the account and fails over to the next one", async () => {
  // two openai accounts; first fetch → 429, second → sse success
  let call = 0;
  const fakeFetch = (async () => {
    call += 1;
    return call === 1
      ? new Response(JSON.stringify({ detail: "rate limited" }), { status: 429 })
      : new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const res = await proxyCodexMessages({ model: "gpt", messages: [{ role: "user", content: "hi" }] },
    mgr2, config, new AbortController().signal,
    { id: "gpt", provider: "openai", upstreamModel: "gpt-5.2-codex" }, {}, fakeFetch);
  expect(res.status).toBe(200);
  expect(call).toBe(2);
  const sidelined = mgr2.listAccounts().find((a) => !a.available);
  expect(sidelined).toBeDefined();
});
```

- [ ] **Step 2: Run, confirm RED** — module missing.

- [ ] **Step 3: Implement `openai-codex.ts`**

Structure mirrors `proxyAnthropicMessages`' account loop exactly (tried-set, `mgr.pick(sessionKey, tried, "openai")`, `hooks.onFailover`), but the attempt function:

```ts
export async function proxyCodexMessages(
  body: unknown,
  mgr: AccountManager,
  config: Config,
  signal: AbortSignal,
  route: ModelRoute,
  hooks: { onFailover?: (from: string, to: string) => void } = {},
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  const anthropicBody = (body ?? {}) as Record<string, unknown>;
  const sessionKey = stringProp(objectProp(anthropicBody, "metadata"), "user_id") || undefined;
  const streamRequested = anthropicBody.stream === true;
  const codexBody = anthropicToCodexRequest(anthropicBody, route.upstreamModel);

  const tried = new Set<string>();
  let account = mgr.pick(sessionKey, undefined, "openai");
  if (!account) return anthropicError(503, "overloaded_error", noOpenAIAccountMessage(mgr));
  let lastError: { status: number; type: string; message: string } | null = null;

  while (account) {
    tried.add(account.name);
    const attempt = await tryCodexAccount(account, codexBody, route, mgr, config, signal, streamRequested, fetchFn);
    if (attempt.kind === "response") {
      if (sessionKey) mgr.setAffinity(sessionKey, account.name, "openai");
      return attempt.response;
    }
    if (attempt.kind === "terminal") return attempt.response;
    lastError = attempt.reason;
    const next = mgr.pick(sessionKey, tried, "openai");
    if (!next) break;
    hooks.onFailover?.(account.name, next.name);
    account = next;
  }
  return anthropicError(lastError?.status ?? 503, lastError?.type ?? "overloaded_error",
    lastError?.message ?? noOpenAIAccountMessage(mgr));
}
```

`tryCodexAccount`:
1. Token: `let creds = mgr.getOpenAICreds(account.name)`; if `!creds?.accessToken` → retry-reason. If `expiresAt` within `config.tokenRefreshSkewMs` → `creds = await refreshOpenAIToken(creds, fetchFn); mgr.updateOpenAICreds(account.name, creds)` (wrap in try → retry-reason on failure; use a module-level `refreshLocks` map like `upstream/anthropic.ts:44` to dedupe concurrent refreshes).
2. Fetch `CODEX_RESPONSES_URL` with `makeAbort`-style timeout (copy the helper), headers:
   ```ts
   {
     "content-type": "application/json",
     authorization: `Bearer ${creds.accessToken}`,
     "chatgpt-account-id": creds.accountId ?? "",
     "OpenAI-Beta": "responses=experimental",
     originator: CODEX_ORIGINATOR,
     accept: "text/event-stream",
   }
   ```
   (Header set verified in Task 1 — adjust to match the source.)
3. On any response: `mgr.recordRateLimitSnapshot(account.name, parseCodexRateLimitSnapshot(res.headers))`.
4. `401/403` → one forced refresh + single retry on this account, then retry-reason (mark `recordError`). `429` → `mgr.markRateLimited(account.name, resetAt from x-codex-primary-resets-in-seconds or retry-after)` → retry-reason. Other non-2xx → terminal `anthropicError(status, "api_error", bodyText.slice(0,500))`.
5. 2xx: pump `res.body` through `SseParser` feeding `CodexToAnthropicStream`:
   - **streamRequested:** return a `ReadableStream` that, per upstream chunk, pushes the chunk into the parser and enqueues every translated frame (encoded); on upstream end, enqueues `finish()` frames, records `mgr.recordSuccess(account.name, translator.usage, 0)` (or `recordError` if `translator.sawError`), closes. Headers: `content-type: text/event-stream; charset=utf-8`, `X-Pool-Account`.
   - **non-stream:** read the whole upstream body, collect all frames, `collectAnthropicMessage(frames)`, record usage, return JSON `Response` with `X-Pool-Account`.
   - Early-error window: like `prepareStreamingResponse` (`upstream/anthropic.ts:252`), buffer translated frames until the first content frame arrives; if `translator.sawError` with a rate-limit-looking message before any content, `markRateLimited` + retry-reason instead of committing bytes to the client.

Reuse by import (do not copy): `anthropicError`-equivalent — export the existing private helpers `anthropicError`, `makeAbort` from `upstream/anthropic.ts` or move them to a new `upstream/shared.ts` (preferred: create `upstream/shared.ts` exporting `anthropicError`, `makeAbort`, `SseParser`, and the `parseJson/objectProp/stringProp/numberProp` narrow helpers; update `upstream/anthropic.ts` to import from it — mechanical move, run the full suite after).

- [ ] **Step 4: Run, confirm GREEN** — `cd pool && bun test`. Expected: all PASS including untouched anthropic tests.

- [ ] **Step 5: Commit** — `git commit -am "feat(pool): Codex upstream proxy with failover and rate-limit snapshots"`

---

### Task 8: Server routing branch + `models update` + login/import CLI

**Files:**
- Modify: `pool/src/server/server.ts` (branch `handleAnthropic` by model table)
- Modify: `pool/src/cli.ts` (`--provider openai` on login/import; new `models` command handler)
- Modify: `pool/src/index.ts` (dispatch `models` command; help text)
- Create: `pool/src/accounts/openai-login.ts` (browser PKCE flow)
- Test: `pool/src/server/routing.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `runModelsCommand(config: Config, args: string[]): Promise<number>` (in `cli.ts`); `loginOpenAI(mgr: AccountManager, name: string): Promise<boolean>` (in `openai-login.ts`).

- [ ] **Step 1: Write the failing routing test (RED)**

Extract the branch decision into a pure function so it's testable without a server. In `server.ts` export:

```ts
export function routeForRequest(table: ModelRoute[], body: unknown): ModelRoute {
  const model = typeof (body as Record<string, unknown>)?.model === "string"
    ? String((body as Record<string, unknown>).model) : "";
  return resolveModel(table, model);
}
```

Test (`pool/src/server/routing.test.ts`):

```ts
import { describe, expect, test } from "bun:test";
import { routeForRequest } from "./server.ts";
import { DEFAULT_MODEL_TABLE } from "../models.ts";

describe("routeForRequest", () => {
  test("claude and unknown models route anthropic; gpt models route openai", () => {
    expect(routeForRequest(DEFAULT_MODEL_TABLE, { model: "claude-sonnet-5" }).provider).toBe("anthropic");
    expect(routeForRequest(DEFAULT_MODEL_TABLE, { model: "whatever-new" }).provider).toBe("anthropic");
    expect(routeForRequest(DEFAULT_MODEL_TABLE, {}).provider).toBe("anthropic");
    expect(routeForRequest(DEFAULT_MODEL_TABLE, { model: "gpt-5.2-codex" }).provider).toBe("openai");
  });
});
```

- [ ] **Step 2: Run, confirm RED** — export missing.

- [ ] **Step 3: Implement server branch**

In `startServer`, load the table once: `const modelTable = loadModelTable(config.modelsFile);`. In `handleAnthropic` (only the oauth-backend path), branch first:

```ts
if (config.backend === "oauth") {
  const route = routeForRequest(modelTable, body);
  if (route.provider === "openai") {
    return proxyCodexMessages(body, mgr, config, signal, route, failoverHooks(config));
  }
  return proxyAnthropicMessages(body, headers, mgr, config, signal, failoverHooks(config));
}
```

(CLI legacy backend ignores the table — OpenAI models on the CLI backend return the anthropic 503 path naturally since no CLI account can serve them; acceptable and out of scope.)

- [ ] **Step 4: Implement `openai-login.ts` (browser PKCE flow — verified manually, not unit-tested)**

```ts
/**
 * Interactive ChatGPT OAuth login (PKCE + localhost callback), mirroring the
 * open-source Codex CLI flow. Opens the browser, waits for the callback,
 * exchanges the code, and stores normalized creds in the account dir.
 */
import { randomBytes, createHash } from "crypto";
import type { AccountManager } from "./manager.ts";
import { normalizeCodexAuthJson } from "./openai-oauth.ts";
import {
  CODEX_AUTH_URL, CODEX_TOKEN_URL, CODEX_CLIENT_ID,
  CODEX_OAUTH_REDIRECT_PORT, CODEX_OAUTH_SCOPES,
} from "../upstream/codex-constants.ts";

export async function loginOpenAI(mgr: AccountManager, name: string): Promise<boolean> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");
  const redirectUri = `http://localhost:${CODEX_OAUTH_REDIRECT_PORT}/auth/callback`;

  const authUrl = new URL(CODEX_AUTH_URL);
  authUrl.search = new URLSearchParams({
    response_type: "code", client_id: CODEX_CLIENT_ID, redirect_uri: redirectUri,
    scope: CODEX_OAUTH_SCOPES, state,
    code_challenge: challenge, code_challenge_method: "S256",
    id_token_add_organizations: "true",
  }).toString();

  const code = await new Promise<string | null>((resolve) => {
    const server = Bun.serve({
      port: CODEX_OAUTH_REDIRECT_PORT,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/auth/callback") return new Response("not found", { status: 404 });
        const ok = url.searchParams.get("state") === state && url.searchParams.get("code");
        setTimeout(() => { server.stop(); resolve(ok ? url.searchParams.get("code") : null); }, 50);
        return new Response(ok ? "Login complete — you can close this tab." : "Login failed (state mismatch).",
          { headers: { "content-type": "text/plain" } });
      },
    });
    console.log(`\nOpen this URL to sign in with ChatGPT:\n\n  ${authUrl}\n`);
    Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", authUrl.toString()], { stderr: "ignore" }).exited.catch(() => {});
    setTimeout(() => { server.stop(); resolve(null); }, 5 * 60_000); // 5-min timeout
  });
  if (!code) { console.error("Login timed out or was rejected."); return false; }

  const res = await fetch(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code, redirect_uri: redirectUri,
      client_id: CODEX_CLIENT_ID, code_verifier: verifier,
    }),
  });
  if (!res.ok) { console.error(`Token exchange failed (${res.status}).`); return false; }
  const tokens = (await res.json()) as Record<string, unknown>;
  const creds = normalizeCodexAuthJson({ tokens });
  if (!creds) { console.error("Token exchange returned no usable credentials."); return false; }
  if (typeof tokens.expires_in === "number") creds.expiresAt = Date.now() + tokens.expires_in * 1000;
  mgr.updateOpenAICreds(name, creds);
  return true;
}
```

(Exact request/param details — form vs JSON, `id_token_add_organizations`, callback path — verified in Task 1; adjust to the codex-rs source.)

- [ ] **Step 5: Wire the CLI**

In `cli.ts`, parse a `--provider` flag out of `args` before the `switch` (`const provider = args.includes("--provider") ? args[args.indexOf("--provider") + 1] : "anthropic"; const positional = args.filter((a, i) => a !== "--provider" && args[i - 1] !== "--provider"); const [sub, name] = positional;`).

- `login` with `provider === "openai"`: `if (!mgr.listNames().includes(name)) mgr.create(name);` then `const ok = await loginOpenAI(mgr, name);` print success/failure like the Claude path (plan from `mgr.getAccount(name).subscriptionType`).
- `import` with `provider === "openai"`: read `~/.codex/auth.json`, `normalizeCodexAuthJson`, `mgr.updateOpenAICreds` (error message pointing at `codex login` when missing).
- `list`: prefix each account line with its provider, e.g. `● gpt1  [openai] [READY]`.

New `models` command in `cli.ts`:

```ts
export async function runModelsCommand(config: Config, args: string[]): Promise<number> {
  const [sub] = args;
  const table = loadModelTable(config.modelsFile);
  if (sub === undefined || sub === "list") {
    for (const m of table) console.log(`${m.id.padEnd(24)} → ${m.provider}:${m.upstreamModel}`);
    return 0;
  }
  if (sub === "update") {
    const mgr = new AccountManager(config);
    const updated = await updateOpenAIModels(mgr, table);   // in models.ts, next step
    saveModelTable(config.modelsFile, updated);
    console.log(`Saved ${updated.length} models to ${config.modelsFile}`);
    return 0;
  }
  console.error(`Unknown models sub-command: ${sub}`);
  return 1;
}
```

`updateOpenAIModels(mgr, table)` in `models.ts`: pick any authenticated openai account's creds, GET the Codex backend's models listing with the same auth headers as Task 7 (endpoint verified in Task 1 — the Codex CLI fetches its model list from the backend; if no such endpoint exists, keep the current openai entries and print "model list endpoint unavailable — edit models.json manually"), merge results as `openai` routes keyed by id (preserving anthropic entries untouched). If no openai account exists, skip with a notice and return the table unchanged.

Dispatch in `index.ts`: `if (command === "models") { const config = loadConfig(); return runModelsCommand(config, rest); }` + help-text lines for `models list|update` and `accounts login <name> --provider openai`.

- [ ] **Step 6: Run full suite, confirm GREEN** — `cd pool && bun test && bunx tsc --noEmit`.

- [ ] **Step 7: Commit** — `git commit -am "feat(pool): model-based routing branch, OpenAI login/import, models update command"`

---

### Task 9: Dashboard + bro CLI passthrough

**Files:**
- Modify: `pool/src/server/dashboard.ts` (provider badge per account row; read `a.provider` from `/api/status` which already serializes full `Account` objects)
- Modify: `src/cli.js` (help text + pass `--provider` through `bro accounts …`; add `bro models …` passthrough)
- Modify: `src/pool.js` (add `runPoolModels(args)` mirroring `runPoolAccounts` at `src/pool.js:105-112`: `runPoolCli(findBun(), ['models', ...args])`; include provider in the `bro accounts list` table)
- Test: `src/settings.test.js` pattern — bro has minimal tests; dashboard/CLI wiring here is verified by hand (Step 3), no new unit test files.

- [ ] **Step 1: Dashboard badge**

In `dashboard.ts`, where each account card renders the plan/tier line, add the provider: find the template chunk that prints `subscriptionType` and prepend a small badge span, e.g. `` `<span class="badge">${esc(a.provider)}</span>` `` with a `.badge` style matching the existing card CSS. (Read the file first; follow its existing HTML-template style exactly.)

- [ ] **Step 2: bro passthrough**

`src/cli.js:86` already forwards `bro accounts …` verbatim to the pool CLI — `--provider openai` flows through with zero changes; just update the help text at `src/cli.js:18-21` to mention it. Add:

```js
if (argv[0] === 'models') {
  return runPoolModels(argv.slice(1));
}
```

and in `src/pool.js`:

```js
// Run a pool `models` sub-command (list/update) with inherited stdio.
export function runPoolModels(args) {
  return runPoolCli(findBun(), ['models', ...args]);
}
```

- [ ] **Step 3: Manual verification (the /verify pass for the whole feature)**

```bash
cd pool && bun start   # with at least one Claude account and one OpenAI account logged in
```

1. `bro accounts login gpt1 --provider openai` → browser flow completes, `bro accounts list` shows `[openai] [READY]` with plan.
2. `bro models update && bro models list` → gpt entries present.
3. `curl -s localhost:3456/v1/messages -H content-type:application/json -d '{"model":"gpt-5.2-codex","max_tokens":100,"messages":[{"role":"user","content":"say hi"}]}'` → Anthropic-shaped message JSON, `X-Pool-Account: gpt1`.
4. Same with `"stream": true` → well-ordered Anthropic SSE.
5. Launch Claude Code via `bro -p pool`, run `/model gpt-5.2-codex`, send a prompt that uses a tool (e.g. "read package.json and tell me the version") → tool round-trip works.
6. `/model claude-sonnet-5` mid-session → routes back to a Claude account (check dashboard).
7. Dashboard shows both providers with utilization bars.

Record what was checked in the commit message.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: dashboard provider badges + bro models/accounts passthrough

Manually verified: OpenAI login flow, models update, non-stream + stream
/v1/messages to gpt model, mid-session /model switch both directions,
tool-use round-trip through Claude Code."
```

---

## Task order & dependencies

1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9. Strictly sequential except: Task 5 (models) and Task 4 (oauth) are independent of each other and can swap; Task 6 only needs Task 1.

## Risks the implementer must watch

- **Task 1 is load-bearing.** If any constant differs from the plan's expected value, later code snippets referencing it are still correct (they import the constant), but header names in Task 7's fixtures must be updated to match.
- The Codex backend may require `session_id`/`conversation_id` headers or reject unknown fields — if a live request 400s in Task 9 Step 3, diff the request against what the codex-rs client sends (it's all in `/tmp/codex-src`).
- Claude Code sends large system prompts + many tools; if the Codex backend caps `instructions` size or tool count, surface the upstream 400 body verbatim to the client (already the terminal-error path in Task 7).
