# Claude Max Pool

**Pool any number of Claude Max / Team plans behind one endpoint that speaks both the OpenAI and Anthropic APIs — with a live dashboard showing which accounts are authenticated and how much of each plan's usage window is left.**

Built on [Bun](https://bun.sh). The default Anthropic `/v1/messages` path forwards directly to `https://api.anthropic.com/v1/messages` with the selected account's Claude Code OAuth bearer token, so Claude Code requests are not nested through another `claude --print` subprocess. The legacy CLI subprocess backend is still available with `CLAUDE_POOL_BACKEND=cli`.

```
  ┌──────────────────────────────────────────────────────────────┐
  │  Your apps (Continue.dev, Cursor, OpenAI/Anthropic SDKs, …)    │
  └───────────────┬──────────────────────────┬───────────────────┘
       OpenAI  /v1/chat/completions   Anthropic  /v1/messages
                  └───────────┬──────────────┘
                     Claude Max Pool  (Bun HTTP server)
                              │  pick least-loaded, authenticated,
                              │  non-rate-limited account
             ┌────────────────┼────────────────┐
   CLAUDE_CONFIG_DIR   CLAUDE_CONFIG_DIR   CLAUDE_CONFIG_DIR
      accounts/work      accounts/personal   accounts/team2
             │                │                │
        OAuth token      OAuth token      OAuth token      (each its own Max/Team plan)
             │                │                │
             └──────── direct Anthropic Messages API ──────┘
```

## Why

A single Claude Max plan has a rolling usage limit (~every 5 hours). If you have more than one plan — a personal Max, a Team seat, a second subscription — there's no built-in way to use them together from your tools. This proxy gives every plan its own isolated login directory, exposes them all as one endpoint, and routes each request to the least-loaded plan that isn't rate-limited. When one plan's window fills up, traffic flows to the others.

| Approach | Cost | Limit |
|---|---|---|
| Claude API keys | pay per token | none, but expensive |
| One Claude Max plan | flat monthly | one usage window |
| **This proxy (N plans)** | flat monthly × N | **N usage windows, pooled** |

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.1
- [Claude Code CLI](https://docs.claude.com/en/docs/claude-code): `npm install -g @anthropic-ai/claude-code`
- One or more Claude Max / Team subscriptions to log into

## Install

```bash
git clone <this-repo> claude-max-pool && cd claude-max-pool
bun install
```

## Add accounts

Each account is an isolated Claude login stored under `~/.claude-max-pool/accounts/<name>/` (used as that account's `CLAUDE_CONFIG_DIR`).

```bash
# Interactive login for a new account (runs the Claude CLI; do /login, then /exit)
bro accounts login work
bro accounts login personal

# Or copy the machine's existing `claude` login into the pool as one account
bro accounts import primary

# See status of every account
bro accounts list

# Remove one
bro accounts remove work
```

If you are running the pool standalone from this directory, the equivalent
direct form is `bun run src/index.ts accounts <command> [name]`.

`accounts list` shows plan type, rate-limit tier, token validity, and rolling usage per account.

### OpenAI / Codex (ChatGPT subscription) accounts

The pool can also route to a **ChatGPT subscription** (Codex) alongside Claude plans. Add one with the same `accounts` commands plus `--provider openai`:

```bash
# Browser OAuth login for a new ChatGPT-subscription account
bro accounts login codex1 --provider openai
# → opens a browser to sign in to ChatGPT; token is stored in the pool

# Or import a login you already did with the Codex CLI (`codex login`)
bro accounts import codex1 --provider openai
# → reads ~/.codex/auth.json and copies its credentials into the pool
```

Notes:
- `login --provider openai` uses ChatGPT subscription OAuth (not an API key).
- `import --provider openai` requires an existing `codex login` — it reads `~/.codex/auth.json`. Run `codex login` first if it reports no login found.
- Omit `--provider` (or pass `--provider anthropic`) for the default Claude login.
- Standalone form: `bun run src/index.ts accounts login <name> --provider openai`.

Once added, OpenAI accounts appear in `bro accounts list` and on the dashboard with a provider badge, and requests for OpenAI models route to them (see below).

## Model strings

The pool maps each **model id** you send to an upstream `provider:model`. See the current routing table with:

```bash
bro models list
# opus                 → anthropic:opus
# sonnet               → anthropic:sonnet
# fable                → anthropic:fable
# claude-opus-4-8      → anthropic:claude-opus-4-8
# claude-fable-5       → anthropic:claude-fable-5
# gpt-5.2-codex        → openai:gpt-5.2-codex
# gpt-5.1-codex-max    → openai:gpt-5.1-codex-max
```

- **Left column = the `"model"` string you put in your request.** Send `gpt-5.2-codex` (or any id in the table) to route to a Codex account; send `sonnet`/`opus`/`fable`/etc. for Claude.
- Built-in Codex ids ship in the default table: **`gpt-5.2-codex`** and **`gpt-5.1-codex-max`**. Claude ids include the aliases `opus`/`sonnet`/`haiku`/`fable` and the full `claude-opus-4-8` / `claude-sonnet-5` / `claude-haiku-4-5` / `claude-fable-5`.
- **Fable has its own scoped usage window** — routing sidelines an account for Fable requests only once *its* Fable-specific window is spent, even if the account has plenty of headroom left on everything else (see [Routing & usage](#routing--usage) below). This is matched by family (any model id containing `fable`, `opus`, `sonnet`, or `haiku`), not by the table entry, so it applies even to a custom `claude-fable-*` id you add yourself.
- An unknown model id falls back to routing verbatim to Anthropic, so a Codex model **must** be present in the table (as an `openai` entry) to reach a Codex account. New OpenAI ids (e.g. a future `gpt-5.6-codex`) aren't picked up automatically — Codex has no model-list endpoint (see below) — so add them to `models.json` yourself once you know the exact id string.

### Adding / changing model ids

Codex has no documented model-list endpoint, so `bro models update` can't auto-discover Codex model names — it only refreshes what's there and leaves your OpenAI entries untouched. To add or rename a Codex model, edit the pool's `models.json` (at `<poolDir>/models.json`, e.g. `~/.claude-max-pool/models.json`) and add an entry:

```json
{
  "models": [
    { "id": "gpt-5.2-codex", "provider": "openai", "upstreamModel": "gpt-5.2-codex" }
  ]
}
```

`id` is what you send to the pool; `upstreamModel` is what the pool sends to OpenAI/Codex (usually identical). Entries in `models.json` are merged over the built-in defaults, so you only list ids you're adding or overriding. Run `bro models list` again to confirm.

## Run the server

```bash
bun start                      # http://127.0.0.1:3456
# or: bun run src/index.ts serve --port 8080
```

Open **http://127.0.0.1:3456/** for the live dashboard — one card per account with auth state, plan, rate tier, token expiry, rolling-window usage bars, and rate-limit cooldowns. It refreshes every few seconds.

## Use it

### OpenAI-compatible

```bash
curl http://127.0.0.1:3456/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"Hello!"}]}'
```

Point any OpenAI client at `http://127.0.0.1:3456/v1` with any (or no) API key — unless you set `PROXY_API_KEY`, in which case send it as the bearer token.

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:3456/v1", api_key="unused")
client.chat.completions.create(model="sonnet", messages=[{"role":"user","content":"hi"}])
```

### Anthropic-compatible

```bash
curl http://127.0.0.1:3456/v1/messages \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-5","max_tokens":1024,"messages":[{"role":"user","content":"Hello!"}]}'
```

Both endpoints support streaming (`"stream": true`). The default `/v1/messages` backend forwards the Anthropic request body verbatim, including `system`, `tools`, `thinking`, beta features, and `stream`. It also preserves the caller/harness Anthropic headers instead of inventing defaults; the only upstream header substitution is `Authorization: Bearer <selected account token>`, with hop-by-hop headers and local `x-api-key` proxy auth stripped. Use `CLAUDE_POOL_BACKEND=cli` if you need the old CLI alias-mapping behavior.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Live status dashboard |
| GET | `/health` | Liveness + pool summary |
| GET | `/api/status` | JSON status of all accounts (the dashboard polls this) |
| GET | `/v1/models` | OpenAI-style model list |
| POST | `/v1/chat/completions` | OpenAI Chat Completions (stream + non-stream) |
| POST | `/v1/messages` | Anthropic Messages (stream + non-stream) |

## Routing & usage

- **Selection:** each request goes to the authenticated, available account with the most headroom left. On the direct OAuth backend (default), headroom comes straight from Anthropic's own `anthropic-ratelimit-unified-*` response headers — Claude subscription plans report a `utilization` fraction (0–1) for a rolling 5-hour window and a 7-day window, refreshed on every call; the account whose tightest window is least utilized wins. Accounts with no live snapshot yet (freshly added, or served via the `cli` backend) fall back to fewest requests in the current local window; round-robin on ties. Pass an OpenAI `user` field or Anthropic `metadata.user_id` to keep a conversation pinned to one account.
- **Model-scoped windows (Fable):** unified windows are parsed generically from the header names, so if Anthropic reports a model-scoped allowance (e.g. a separate, lower Fable weekly window such as `anthropic-ratelimit-unified-7d-fable-*`), it's captured, shown on the dashboard as its own bar, and used for routing — a request for that model skips accounts whose scoped window is spent and prefers the one with the most scoped headroom, while the account keeps serving every other model normally. Whether Anthropic actually exposes such headers on subscription traffic is undocumented; the parser picks them up automatically if and when they appear.
- **Proactive sidelining:** if Anthropic reports an account-wide unified window fully consumed (`utilization` ≥ 1 or a `rejected` status) and that window hasn't reset yet, the proxy marks the account unavailable immediately — before it ever sends a request that would 429 — and routes to another account instead. A spent model-scoped window sidelines the account only for requests targeting that model.
- **Graceful failover:** if the account serving a request has its usage/rate limit run out **before any output has streamed** (e.g. a Claude plan hits its cap), the proxy transparently sidelines that account and retries the same request on the next available one. For direct Anthropic streaming, the proxy buffers only the first SSE event long enough to detect an initial rate-limit error; once real SSE output starts, bytes are passed through unchanged and the proxy is committed to that account. Failovers are logged (disable with `LOG_FAILOVER=0`).
- **Rate limits:** a sidelined account stays out for a cooldown (`RATE_LIMIT_COOLDOWN_MS`, default 1h); the proxy tries to recover a reset time from the error and reroutes traffic in the meantime.
- **Usage tracking:** requests, tokens, and cost are counted per account over a rolling window (`USAGE_WINDOW_MS`, default 5h) and persisted to `<pool>/usage.json`, alongside Anthropic's unified 5h/7d utilization snapshot when the direct backend has seen one. The dashboard shows those real windows (percent used + reset countdown) when available; the `cli` backend has no HTTP access to Anthropic's headers, so it falls back to observed usage plus the plan's `rateLimitTier` label only. Note: these `anthropic-ratelimit-unified-*` headers are also passed through to the caller unchanged, so an agent talking to the pool sees the same live limits it would get straight from Anthropic.
- **OAuth refresh:** the direct backend refreshes expired account access tokens with each account's stored `refreshToken` and writes rotated tokens back to `.credentials.json`.

## Configuration

All optional — see [`.env.example`](./.env.example). Key vars: `CLAUDE_POOL_DIR`, `CLAUDE_POOL_BACKEND` (`oauth` default, `cli` fallback), `ANTHROPIC_API_BASE_URL`, `CLAUDE_BIN`, `HOST`, `PORT`, `PROXY_API_KEY`, `REQUEST_TIMEOUT_MS`, `USAGE_WINDOW_MS`, `RATE_LIMIT_COOLDOWN_MS`.

## Notes & limitations

- The default `/v1/messages` backend is a direct reverse proxy. It preserves Anthropic request fields and harness headers, swaps only upstream authorization to the selected account token, and streams upstream SSE bytes back unchanged after the initial failover check.
- The OpenAI compatibility endpoint and `CLAUDE_POOL_BACKEND=cli` fallback use the older adapter path, which flattens chat history into one CLI prompt and supports text responses only.
- This uses Claude Code OAuth credentials from your subscription login. Review Anthropic's terms for your plan before pooling multiple accounts for shared/automated use.

## Layout

```
src/
  index.ts            entry — dispatches `serve` vs `accounts`
  config.ts           env-resolved configuration
  cli.ts              account-management commands
  accounts/           AccountManager: discovery, auth status, usage, routing
  upstream/           direct Anthropic OAuth reverse proxy
  subprocess/         spawns the Claude CLI, normalizes its JSON stream
  adapters/           OpenAI + Anthropic request/response translation
  server/             Bun.serve HTTP routing + status dashboard
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the request lifecycle.

## License

MIT
