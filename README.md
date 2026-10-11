# bro

Pool any number of Claude Max / Team and ChatGPT (Codex) subscriptions behind one local endpoint, and run [Claude Code](https://claude.com/claude-code) across all of them — with automatic failover when one runs out of usage.

## Install

```sh
npm install -g bro-claude
# or: bun install -g bro-claude
```

You also need the `claude` CLI installed (that's the thing `bro` launches) and [Bun](https://bun.sh) (the pool server runs on it).

## Use

```sh
bro
```

## How it works

`bro` pools any number of Claude Max / Team logins behind one local endpoint and launches Claude Code across all of them — so a single session draws from several plans and **fails over automatically** the moment one runs out of usage.

Run `bro` and it handles everything:

1. **Setup** — if you have no pooled accounts yet, it offers to log in a new one (opens Claude to sign in) or import the login already on this machine. Add as many as you like; each is stored in its own isolated config dir under `~/.claude-max-pool/`.
2. **Start the proxy** — launches the pool server (in `pool/`, runs on [Bun](https://bun.sh)) in the background and waits for it to go healthy. A live dashboard shows each account's auth state, plan, rate tier, and rolling usage at `http://127.0.0.1:3456/`.
3. **Launch Claude** — starts Claude Code pointed at the pool (`ANTHROPIC_BASE_URL`). The pool forwards Claude's Anthropic `/v1/messages` calls directly to Anthropic with the least-loaded account's OAuth token by default, without nesting another `claude --print` subprocess. The pool server keeps running after Claude exits (see below).

### Pool as your Claude backend (agents included)

Launching through the pool (`bro`) makes it the backend for **every** Claude Code
session on the machine — foreground windows *and* background agents started from
the agents view — by writing `ANTHROPIC_BASE_URL` into your `~/.claude/settings.json`
and leaving the pool server running (detached) after Claude exits.

```sh
bro pool up       # start the pool as the global Claude backend
bro pool status   # show server health + whether the override is active
bro pool down     # stop the pool and restore your normal Claude login
```

The override stays active until you run `bro pool down`. Claude Code has no
fallback for an unreachable base URL, so if the pool server stops while the
override is set, run `bro` or `bro pool up` to restart it (or `bro pool down` to
go back to your normal login). Note: pointing Claude at a local proxy disables MCP tool
search and Remote Control for those sessions.

Manage pool accounts directly through `bro`:

```sh
bro accounts login work       # add/log in a new pooled Claude account
bro accounts import primary   # copy this machine's current Claude login
bro accounts list             # show account status and usage
bro accounts remove work      # delete a pooled account
```

**Add a ChatGPT subscription (Codex) account** with `--provider openai`:

```sh
bro accounts login codex1 --provider openai    # browser OAuth sign-in to ChatGPT
bro accounts import codex1 --provider openai   # import an existing `codex login` (~/.codex/auth.json)
```

Then requests for a Codex **model id** route to those accounts. See the routing table and add/rename model strings with:

```sh
bro models list     # id → provider:model (e.g. gpt-6-astra → openai:gpt-6-astra)
bro models update   # add newly listed Codex models from authenticated accounts
```

Built-in Codex ids include the `gpt-6` Astra/Sol/Luna family, the `gpt-5.6` Sol/Terra/Luna family, `gpt-5.5`, `gpt-5.4`, and `gpt-5.4-mini`. Extended-context models appear once in Claude Code's picker with a `[1m]` selector. When cross-provider mapping is enabled, the defaults are Fable → GPT-6 Astra, Opus and Sonnet → GPT-6 Sol (GPT-6 has no Terra), and Haiku → GPT-6 Luna; dashboard overrides still win. Run `bro pool restart` after an update to load new routes into a running pool; edit the pool's `models.json` for custom aliases or overrides. Full details in [`pool/README.md`](./pool/README.md#openai--codex-chatgpt-subscription-accounts).

**Failover:** when the serving account's usage/rate limit runs out before any output has streamed, the pool transparently sidelines it and retries the turn on the next account — you just keep going. Set `CLAUDE_POOL_BACKEND=cli` to use the older subprocess backend. Requires Bun (`bro` finds it automatically; install from [bun.sh](https://bun.sh)). See [`pool/README.md`](./pool/README.md) for the pool's own docs, endpoints, and configuration.

## Permission mode

By default `bro` starts Claude Code in **auto mode** (`--permission-mode auto`) —
Claude's intelligent auto-mode approves safe actions and only prompts when it
needs to. Set `permissionMode` in `~/.bro/config.json` to change the default:

- `"auto"` — auto-mode (the default)
- `"manual"` — prompt for everything (same as `bro --safe`)
- `"bypass"` — skip every permission check (`--dangerously-skip-permissions`)

(The older `dangerouslySkipPermissions: true/false` config key still works when
`permissionMode` is unset.)

## Flags

```sh
bro                       # start the pool if needed, launch Claude through it
bro pool up               # make the pool the backend for all Claude sessions
bro pool down             # stop the pool, restore your normal Claude login
bro pool status           # pool server + backend-override status
bro --dry-run             # show what would run, launch nothing
bro --safe                # start in manual mode (prompt for everything)
bro --resume <session-id> # resume a Claude session through the pool
bro -- --help             # force a bro flag name through to claude
```

Put `bro`'s own flags first. The first unrecognized argument, and everything
after it, is passed verbatim to the Claude session.

---

Made by [JustGains](https://justgains.com) · MIT
