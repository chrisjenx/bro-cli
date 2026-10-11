---
name: run-bro-cli
description: Build, run, and drive the `bro` CLI (bin/bro.js) and its nested Bun `pool` server. Use when asked to run bro, preview a pool launch, start/stop the pool server, or screenshot/inspect its dashboard or API.
---

`bro` is a Node ESM CLI (`bin/bro.js` → `src/cli.js`) that launches Claude
Code through a nested Bun HTTP service in `pool/`, which it can also
start/stop/query. Drive it via `.claude/skills/run-bro-cli/driver.sh` — it
wraps the non-interactive flag paths and an isolated instance of the pool
server you can hit with curl. All paths and commands
below are relative to the repo root.

**Never let the driver actually spawn `claude`** — a bare `bro` starts the
real pool and launches Claude, so every launch path goes through `--dry-run`. `bro` uses whatever OAuth/API-key state already
exists on the machine, so a real launch opens an actual interactive Claude
Code session (or a real proxy/browser) — outside what this driver is for.

## Prerequisites

```bash
node --version   # v18+ required (engines.node in package.json); this repo tested on v22
bun --version     # required for pool/ (Bun >=1.1)
```

No build step — both packages run directly from source (`node bin/bro.js`, `bun run src/index.ts`).

## Run (agent path)

```bash
chmod +x .claude/skills/run-bro-cli/driver.sh   # already executable in git, but harmless
.claude/skills/run-bro-cli/driver.sh help
```

### Direct invocation (covers `src/cli.js`)

```bash
.claude/skills/run-bro-cli/driver.sh bro-help                        # bro --help
.claude/skills/run-bro-cli/driver.sh dry-run --resume <id>          # bro --dry-run --resume <id>
.claude/skills/run-bro-cli/driver.sh pool-status                     # bro pool status
.claude/skills/run-bro-cli/driver.sh models-list                     # bro models list
```

`dry-run` prints the pool launch plan (server command, pool dir, accounts,
the settings.json env block, and the `claude` command/args) — the fast path
for testing permission-mode flags and claude-arg passthrough without ever
spawning a process. It does read the live pool's `/v1/models` if one is
running, but never starts or mutates anything.

### Standalone pool server (isolated — never touches a live pool)

```bash
.claude/skills/run-bro-cli/driver.sh pool-serve-start 3999   # bun serve on an isolated dir + port
.claude/skills/run-bro-cli/driver.sh pool-curl /health 3999
.claude/skills/run-bro-cli/driver.sh pool-curl /api/status 3999
.claude/skills/run-bro-cli/driver.sh pool-curl /v1/models 3999
.claude/skills/run-bro-cli/driver.sh pool-serve-stop 3999
```

Each `pool-serve-start` call creates a fresh `mktemp -d` as `CLAUDE_POOL_DIR`
(so it starts with 0 accounts — that's expected, `/v1/messages` will 503
with `"No Claude accounts configured"`) and binds to the port you pass
instead of the default 3456. All server state (pid file, sandbox dir
pointer, log) is keyed by port at `/tmp/bro-driver-pool-<port>.{pid,dir,log}`,
so servers on different ports coexist; `pool-serve-stop [port]` kills that
port's server and removes its sandbox dir, log, and pid file. **Check `bro pool status` or
`lsof -iTCP:3456` first** — a real pool may already be running on this
machine with the user's live Claude accounts; this driver's `pool-serve-*`
commands are a separate, disposable instance and must not be confused with
it. Never run `bro pool up`/`bro pool down` from automation — those mutate
the user's real `~/.claude/settings.json` backend override.

## Run (human path)

```bash
node bin/bro.js            # start the pool if needed, then launch claude through it
node bin/bro.js --dry-run  # preview the account-pool flow without starting anything
```

## Test

```bash
node --test src/*.test.js          # root Node test suite (node:test)
cd pool && bun test                # pool Bun test suite (bun:test)
```

## Gotchas

- **`( cd dir && cmd & )` under `set -e` captures the wrong PID.** With
  `errexit` active, bash can't tail-exec-optimize the last command of a
  backgrounded `&&` list, so it forks an extra supervisor shell and `$!`
  points at *that* shell, not the real process — `kill "$!"` then leaves
  the actual server running as an orphan. Fix: background the whole
  subshell as one unit and `exec` the final command inside it —
  `( cd dir && exec cmd >log 2>&1 ) & echo $!` — see `driver.sh`'s
  `cmd_pool_serve_start`. Verified by checking `ps -p "$(cat pidfile)"`
  actually shows the `bun` process, not a `bash driver.sh …` process.
- **A live pool server may already be running on :3456** with the
  operator's real Claude/Codex accounts (`bro pool status` shows it).
  `driver.sh`'s pool-serve commands default to an alternate port and an
  isolated `CLAUDE_POOL_DIR` specifically to avoid colliding with it —
  don't change them to port 3456 or the default pool dir.

## Troubleshooting

- **`pool server did not come up on :<port>`**: check
  `/tmp/bro-driver-pool-<port>.log` for the Bun startup error; usually
  means the port was already bound by a previous unstopped driver
  instance — run `pool-serve-stop` first, or pick a different port.
