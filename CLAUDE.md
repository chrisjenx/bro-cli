# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Root package (Node ESM CLI):

```sh
npm start                 # run bro via node bin/bro.js
node bin/bro.js --help    # inspect CLI commands and flags
node bin/bro.js --dry-run # preview the pool launch; starts nothing, writes no settings
node --test src/*.test.js # run root Node tests
node --test src/settings.test.js # run one root test file
```

Pool package (Bun/TypeScript server):

```sh
cd pool && bun install          # install pool dependencies
cd pool && bun start            # serve the pool on 127.0.0.1:3456
cd pool && bun run dev          # serve with Bun watch mode
cd pool && bun test             # run all pool tests
cd pool && bun test src/models.test.ts # run one pool test file
cd pool && bun run typecheck    # TypeScript check for the pool
```

The root `package.json` has no lint/build scripts. The pool `package.json` only defines `start`, `serve`, `dev`, `accounts`, and `typecheck`; use Bun's built-in test runner for `pool/src/*.test.ts`.

## Big-picture architecture

This repo ships the `bro` CLI (`bin/bro.js` -> `src/cli.js`) plus a nested Bun service in `pool/`.

### Root CLI

The root CLI is a thin launcher/manager for the pool; it has no other providers.

- `src/cli.js` is the top-level command dispatcher. It handles `bro accounts`, `bro models`, `bro pool`, and otherwise launches Claude Code through the pool (`--dry-run`, `--safe`, and passthrough claude args). `-p pool` is still accepted as a no-op alias; other removed flags/commands (`-p <x>`, `-m`, `-l`, `update`, `image`) are rejected so they never reach `claude` after the global override is written.
- `src/config.js` reads the optional `~/.bro/config.json` (only `permissionMode` / legacy `dangerouslySkipPermissions` are used) and maps the posture to claude flags.
- `src/pool.js` bridges root commands to the nested pool service: account/model management, starting/stopping the detached pool, health checks, launching `claude` against it, and managing the global Claude Code backend override in `~/.claude/settings.json`. A failed or cancelled bring-up releases a dead override (`withOverrideGuard`). The pool port comes from `BRO_POOL_PORT` (not `PORT`), and `/health` must look like the pool's before it is trusted or its listener killed.
- `src/settings.js` owns applying/clearing the pool backend override while preserving pre-existing Claude settings, plus catalog-derived model pins.
- `src/proc.js` (cross-platform `which`/spawn) and `src/ui.js` (arrow-key select, prompts) are shared helpers.

### Pool service

The pool is a Bun TypeScript package that exposes Anthropic-compatible `/v1/messages`, OpenAI-compatible `/v1/chat/completions`, status endpoints, and account/model CLIs.

- `pool/src/index.ts` dispatches `serve`, `accounts`, and `models` commands.
- `pool/src/config.ts` resolves environment configuration such as `CLAUDE_POOL_DIR`, `CLAUDE_POOL_BACKEND`, `HOST`, `PORT`, timeouts, and proxy auth.
- `pool/src/accounts/manager.ts` discovers isolated account directories under `~/.claude-max-pool/accounts/<name>/`, reads auth/usage state, selects an available account, tracks sticky sessions, persists usage to `usage.json`, and sidelines rate-limited accounts.
- `pool/src/upstream/anthropic.ts` is the default direct Anthropic OAuth reverse proxy for `/v1/messages`: it refreshes account OAuth tokens when needed, preserves caller Anthropic headers/body, swaps only authorization, taps usage/rate-limit metadata, and supports initial streaming failover before bytes are committed.
- `pool/src/upstream/openai-codex.ts` and `pool/src/upstream/codex-translate.ts` handle ChatGPT-subscription/Codex account routing and Anthropic/OpenAI protocol translation for OpenAI-backed models.
- `pool/src/server/server.ts` wires Bun HTTP routes, proxy auth, model routing, status JSON, and the dashboard. `pool/src/server/failover.ts` contains retry/failover helpers used around initial rate-limit failures.
- `pool/src/adapters/*` and `pool/src/subprocess/*` are the legacy compatibility path: `CLAUDE_POOL_BACKEND=cli` or OpenAI compatibility can flatten requests into `claude --print --output-format stream-json`, normalize CLI JSON into `TurnEvent`s, then serialize Anthropic/OpenAI-style responses.
- `pool/src/models.ts` owns the pool model routing table: request model id -> upstream provider/model, with built-in Claude aliases and Codex ids plus user overrides.

See `pool/ARCHITECTURE.md` for the detailed pool request lifecycle and failure modes.

## Repository-specific notes

- This working copy is a personal fork. Do not create PRs against upstream `JustSuperHuman/bro-cli`; if asked to open a PR, use the user's fork/repo target.
- Root tests use Node's built-in `node:test`; pool tests use `bun:test`. Keep new tests on the runner used by the package they live in.
- Be careful with pool streaming behavior: direct Anthropic streaming intentionally forwards SSE bytes unchanged after the initial failover check, and keep-alives must be driven by Bun/server timers rather than by pulling the upstream stream.
