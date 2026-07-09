---
name: run-bro-cli
description: Build, run, and drive the `bro` CLI (bin/bro.js) and its nested Bun `pool` server. Use when asked to run bro, test the provider/model picker, drive bro's interactive menu, start/stop the pool server, or screenshot/inspect its dashboard or API.
---

`bro` is a Node ESM CLI (`bin/bro.js` → `src/cli.js`) with an interactive
arrow-key menu (`src/ui.js`) for picking a provider/model, plus a nested Bun
HTTP service in `pool/` that it can start/stop/query. Drive it via
`.claude/skills/run-bro-cli/driver.sh` — it wraps the non-interactive flag
paths, a tmux-based TUI driver for the arrow-key menu, and an isolated
instance of the pool server you can hit with curl. All paths and commands
below are relative to the repo root.

**Never let the driver actually spawn `claude`** — every non-interactive
path uses `--dry-run`, and every TUI session is cancelled with Escape before
reaching the final launch. `bro` uses whatever OAuth/API-key state already
exists on the machine, so a real launch opens an actual interactive Claude
Code session (or a real proxy/browser) — outside what this driver is for.

## Prerequisites

```bash
node --version   # v18+ required (engines.node in package.json); this repo tested on v22
bun --version     # required for pool/ (Bun >=1.1)
brew install tmux # only needed for the interactive-TUI path; not preinstalled on macOS
```

No build step — both packages run directly from source (`node bin/bro.js`, `bun run src/index.ts`).

## Run (agent path)

```bash
chmod +x .claude/skills/run-bro-cli/driver.sh   # already executable in git, but harmless
.claude/skills/run-bro-cli/driver.sh help
```

### Non-interactive (direct invocation — covers most of `src/cli.js`)

```bash
.claude/skills/run-bro-cli/driver.sh bro-help                        # bro --help
.claude/skills/run-bro-cli/driver.sh list                            # bro --list
.claude/skills/run-bro-cli/driver.sh dry-run anthropic claude-sonnet-4-6  # bro --dry-run -p ... -m ...
.claude/skills/run-bro-cli/driver.sh pool-status                     # bro pool status
.claude/skills/run-bro-cli/driver.sh models-list                     # bro models list
```

`dry-run` prints the exact `{via, cmd, args, baseUrl}` bro would launch —
this is the fast path for testing provider/model resolution, permission-mode
flags, and the `claude-code-router` config write logic in `src/launch.js`
without ever spawning a process.

### Interactive TUI (tmux-driven — exercises `src/ui.js`'s `select()`)

```bash
.claude/skills/run-bro-cli/driver.sh tui-start                 # launches `bro`, waits for the provider menu
.claude/skills/run-bro-cli/driver.sh tui-send Down Down Enter   # move to "Claude (Anthropic)", pick it
.claude/skills/run-bro-cli/driver.sh tui-wait "Choose a model"  # poll until the model menu renders
.claude/skills/run-bro-cli/driver.sh tui-send Tab               # flip the "Skip permissions" toggle
.claude/skills/run-bro-cli/driver.sh tui-capture                # print the current pane
.claude/skills/run-bro-cli/driver.sh tui-cancel                 # Escape — cancels, never launches claude
.claude/skills/run-bro-cli/driver.sh tui-stop                   # kill the tmux session if still alive
```

`tui-send` forwards its args straight to `tmux send-keys` (key names like
`Down`, `Up`, `Enter`, `Tab`, `Escape`, or literal characters). Cancelling
(Escape) at any menu exits the `bro` process cleanly and the tmux session
ends on its own — `tui-stop` is just a safety net for a session left
mid-menu.

`tui-start` runs bro under an isolated scratch HOME
(`$TMPDIR/bro-driver-home`), so the provider menu always opens at index 0
(bro otherwise seeds the cursor from `lastProvider()` in the operator's
`~/.bro/state.json`, which would make fixed keystroke sequences like
`Down Down Enter` land on the wrong provider) and the driver never writes
selection state into the operator's real `~/.bro`. First `tui-start` on a
machine fetches the remote models list (a few seconds); later runs hit the
scratch HOME's cache.

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
node bin/bro.js        # interactive: pick a provider, then a model, then launches claude
node bin/bro.js -p pool --dry-run   # preview the account-pool flow without starting anything
```

## Test

```bash
node --test src/settings.test.js   # root Node test suite (node:test) — 6 pass
cd pool && bun test                # pool Bun test suite (bun:test) — 87 pass across 14 files
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
- **macOS has no `timeout`.** GNU `timeout`/`gtimeout` isn't installed by
  default; `driver.sh`'s `wait_for()` polls in a bounded loop instead
  (`sleep 0.2` × N) rather than relying on it.
- **A live pool server may already be running on :3456** with the
  operator's real Claude/Codex accounts (`bro pool status` shows it).
  `driver.sh`'s pool-serve commands default to an alternate port and an
  isolated `CLAUDE_POOL_DIR` specifically to avoid colliding with it —
  don't change them to port 3456 or the default pool dir.
- **`bro image` opens a real OS browser window** (`open`/`xdg-open` in
  `src/imagegen.js`) — it is not covered by this driver and shouldn't be
  invoked from automation; it would pop a browser on the operator's
  live desktop.
- **The interactive select menu requires a real TTY** (`src/ui.js`'s
  `isInteractive` check) — driving it needs tmux (or another pty), a
  plain piped/`echo`'d stdin will just get "A terminal (TTY) is
  required...".

## Troubleshooting

- **`tmux: command not found`**: not preinstalled on macOS. `brew install
  tmux` (Linux: `apt-get install -y tmux`).
- **`pool server did not come up on :<port>`**: check
  `/tmp/bro-driver-pool-<port>.log` for the Bun startup error; usually
  means the port was already bound by a previous unstopped driver
  instance — run `pool-serve-stop` first, or pick a different port.
