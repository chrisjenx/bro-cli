# Pool-as-Default-Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `bro`'s account pool a persistent, global Claude Code backend so every session — foreground, new windows, and background agents — routes through it, until the user runs `bro pool down`.

**Architecture:** A new pure module (`src/settings.js`) surgically points Claude Code's `settings.json` `env` block at the pool and can restore it exactly. `src/pool.js` gains a detached (persistent) server + pidfile, `poolUp`/`poolDown`/`poolStatus` commands, and a `selfHealPoolEnv` guard; the `bro -p pool` menu path now leaves the pool running instead of killing it on exit. `src/cli.js` routes `bro pool <up|down|status>` and runs the self-heal guard on startup.

**Tech Stack:** Node.js ESM (v22), `node --test` for unit tests, existing Bun-based pool server in `pool/`.

---

## File Structure

- **Create** `src/settings.js` — read/merge/restore the pool `env` block in Claude Code's `settings.json`; snapshot-based reversibility. One responsibility: settings.json mutation.
- **Create** `src/settings.test.js` — unit tests for the above against a temp dir.
- **Modify** `src/pool.js` — detached server + pidfile, `poolUp`/`poolDown`/`poolStatus`/`runPoolCommand`/`selfHealPoolEnv`, `runPool` no longer tears down on exit.
- **Modify** `src/cli.js` — dispatch `bro pool <sub>`, call `selfHealPoolEnv()` on startup, HELP text.
- **Modify** `README.md` — document persistent/global behavior + new commands + safety notes.

---

### Task 1: `src/settings.js` — reversible pool env in settings.json

**Files:**
- Create: `src/settings.js`
- Test: `src/settings.test.js`

- [ ] **Step 1: Write the failing tests**

Create `src/settings.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyPoolEnv, clearPoolEnv, isPoolEnvActive } from './settings.js';

function tmpPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-settings-'));
  return { settings: path.join(dir, 'settings.json'), state: path.join(dir, 'pool-settings.json'), dir };
}
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const POOL = { baseUrl: 'http://127.0.0.1:3456', token: 'claude-max-pool' };

test('apply adds env keys and preserves other settings', () => {
  const p = tmpPaths();
  fs.writeFileSync(p.settings, JSON.stringify({ model: 'opus', permissions: { defaultMode: 'auto' } }));
  applyPoolEnv(POOL, p);
  const s = read(p.settings);
  assert.equal(s.env.ANTHROPIC_BASE_URL, POOL.baseUrl);
  assert.equal(s.env.ANTHROPIC_AUTH_TOKEN, POOL.token);
  assert.equal(s.model, 'opus');
  assert.deepEqual(s.permissions, { defaultMode: 'auto' });
  assert.equal(isPoolEnvActive(p), true);
});

test('clear restores a file that had no env block', () => {
  const p = tmpPaths();
  const original = { model: 'opus', permissions: { defaultMode: 'auto' } };
  fs.writeFileSync(p.settings, JSON.stringify(original));
  applyPoolEnv(POOL, p);
  const cleared = clearPoolEnv(p);
  assert.equal(cleared, true);
  assert.deepEqual(read(p.settings), original);
  assert.equal(isPoolEnvActive(p), false);
});

test('clear restores a pre-existing user ANTHROPIC_BASE_URL exactly', () => {
  const p = tmpPaths();
  fs.writeFileSync(p.settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://gw.example', FOO: 'bar' } }));
  applyPoolEnv(POOL, p);
  assert.equal(read(p.settings).env.ANTHROPIC_BASE_URL, POOL.baseUrl); // overridden while active
  clearPoolEnv(p);
  const s = read(p.settings);
  assert.equal(s.env.ANTHROPIC_BASE_URL, 'https://gw.example'); // restored
  assert.equal(s.env.FOO, 'bar');
  assert.ok(!('ANTHROPIC_AUTH_TOKEN' in s.env)); // was absent → stays absent
});

test('clear is a no-op when nothing is managed', () => {
  const p = tmpPaths();
  fs.writeFileSync(p.settings, JSON.stringify({ model: 'opus' }));
  assert.equal(clearPoolEnv(p), false);
  assert.deepEqual(read(p.settings), { model: 'opus' });
});

test('apply creates settings.json when absent, clear removes empty env', () => {
  const p = tmpPaths();
  applyPoolEnv(POOL, p);
  assert.equal(read(p.settings).env.ANTHROPIC_BASE_URL, POOL.baseUrl);
  clearPoolEnv(p);
  const s = read(p.settings);
  assert.ok(!('env' in s)); // empty env removed
});

test('apply twice keeps the original snapshot', () => {
  const p = tmpPaths();
  fs.writeFileSync(p.settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://gw.example' } }));
  applyPoolEnv(POOL, p);
  applyPoolEnv({ baseUrl: 'http://127.0.0.1:9999', token: 'x' }, p);
  clearPoolEnv(p);
  assert.equal(read(p.settings).env.ANTHROPIC_BASE_URL, 'https://gw.example');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/settings.test.js`
Expected: FAIL — `Cannot find module './settings.js'` / functions undefined.

- [ ] **Step 3: Implement `src/settings.js`**

```js
// Point Claude Code's settings.json `env` block at the account pool so *every*
// Claude Code session (foreground, new windows, background agents) routes through
// it. Reversible: applyPoolEnv snapshots whatever was there before, clearPoolEnv
// restores it exactly. All fs paths are injectable so the logic is unit-testable.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const POOL_ENV_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'];

// Where Claude Code actually reads settings from (honor CLAUDE_CONFIG_DIR), and
// where bro records the pre-pool snapshot.
export function defaultPaths() {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return {
    settings: path.join(claudeDir, 'settings.json'),
    state: path.join(os.homedir(), '.bro', 'pool-settings.json')
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

// Point settings.json's env at the pool. Snapshots prior values once (so repeat
// calls don't clobber the original snapshot) and preserves all other settings.
export function applyPoolEnv({ baseUrl, token }, paths = defaultPaths()) {
  const settings = readJson(paths.settings) || {};
  const env = { ...(settings.env || {}) };

  if (!fs.existsSync(paths.state)) {
    const prior = {};
    for (const k of POOL_ENV_KEYS) prior[k] = k in env ? env[k] : null;
    writeJson(paths.state, { managed: true, prior });
  }

  env.ANTHROPIC_BASE_URL = baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = token;
  settings.env = env;
  writeJson(paths.settings, settings);
}

// Undo applyPoolEnv: restore prior values (or delete keys that were absent).
// Idempotent — returns false when nothing is managed.
export function clearPoolEnv(paths = defaultPaths()) {
  const state = readJson(paths.state);
  if (!state || !state.managed) return false;

  const settings = readJson(paths.settings) || {};
  const env = { ...(settings.env || {}) };
  const prior = state.prior || {};
  for (const k of POOL_ENV_KEYS) {
    if (prior[k] === null || prior[k] === undefined) delete env[k];
    else env[k] = prior[k];
  }
  if (Object.keys(env).length === 0) delete settings.env;
  else settings.env = env;
  writeJson(paths.settings, settings);

  try {
    fs.rmSync(paths.state);
  } catch {}
  return true;
}

export function isPoolEnvActive(paths = defaultPaths()) {
  return fs.existsSync(paths.state);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/settings.test.js`
Expected: PASS — 6 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/settings.js src/settings.test.js
git commit -m "Add reversible pool env writer for Claude Code settings.json"
```

---

### Task 2: `src/pool.js` — persistent server + pool lifecycle commands

**Files:**
- Modify: `src/pool.js`

- [ ] **Step 1: Add imports and constants**

At the top import block, change `import { spawn } from 'node:child_process';` to:

```js
import { spawn, execSync } from 'node:child_process';
```

Add after the existing `import { permissionArgs } from './launch.js';` line:

```js
import { applyPoolEnv, clearPoolEnv, isPoolEnvActive } from './settings.js';
```

Add next to the `PROXY_LOG` constant:

```js
const PROXY_PID = path.join(os.homedir(), '.bro', 'pool-proxy.pid');
```

- [ ] **Step 2: Add port/env helpers (near the top of the "entry point" section)**

```js
function poolPort() {
  return Number.parseInt(process.env.PORT || '', 10) || DEFAULT_PORT;
}

function poolEnvValues(port) {
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    token: process.env.PROXY_API_KEY || 'claude-max-pool'
  };
}
```

- [ ] **Step 3: Make `startProxy` detached and pidfile-tracked**

Replace the existing `startProxy` function body with:

```js
function startProxy(bun, port) {
  fs.mkdirSync(path.dirname(PROXY_LOG), { recursive: true });
  const out = fs.openSync(PROXY_LOG, 'a');
  const child = spawn(bun, ['run', POOL_ENTRY, 'serve'], {
    env: { ...process.env, CLAUDE_POOL_DIR: POOL_DIR, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', out, out],
    detached: true, // survive the launching terminal so agents can keep using it
    windowsHide: true
  });
  try {
    fs.writeFileSync(PROXY_PID, String(child.pid));
  } catch {}
  child.unref?.();
  return child;
}
```

- [ ] **Step 4: Add `ensureServer` and `killProxy` helpers**

```js
async function ensureServer(bun, port, baseUrl) {
  if (await healthy(port)) return;
  console.log(`\nStarting the pool server on ${baseUrl} …`);
  const child = startProxy(bun, port);
  child.on('error', (e) => console.error(`Pool server error: ${e.message}`));
  const ok = await waitHealthy(port);
  if (!ok) {
    await killProxy(port);
    throw new Error(`The pool server did not become healthy on ${baseUrl}.\n  Check the log: ${PROXY_LOG}`);
  }
}

async function killProxy(port) {
  let killed = false;
  let pid = 0;
  try {
    pid = Number.parseInt(fs.readFileSync(PROXY_PID, 'utf8'), 10);
  } catch {}
  if (pid) {
    try {
      process.kill(pid);
      killed = true;
    } catch {}
  }
  if (!killed) {
    // Fallback: whatever is bound to the port (macOS/Linux).
    try {
      const out = execSync(`lsof -ti tcp:${port}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      for (const p of out.split(/\s+/).filter(Boolean)) {
        try {
          process.kill(Number.parseInt(p, 10));
          killed = true;
        } catch {}
      }
    } catch {}
  }
  try {
    fs.rmSync(PROXY_PID);
  } catch {}
  return killed;
}
```

- [ ] **Step 5: Add `poolUp`, `poolDown`, `poolStatus`, `runPoolCommand`, `selfHealPoolEnv`**

```js
// `bro pool up` — start the pool as the backend for ALL Claude Code sessions.
export async function poolUp() {
  const port = poolPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const bun = findBun();
  const authed = await ensureAccount(bun);
  if (authed.length === 0) {
    console.log('No accounts configured — nothing to start.');
    return 0;
  }
  await ensureServer(bun, port, baseUrl);
  const { baseUrl: b, token } = poolEnvValues(port);
  applyPoolEnv({ baseUrl: b, token });
  printStatus(await fetchStatus(port), baseUrl);
  console.log('  ' + C.green('Pool is now the backend for all Claude Code sessions') + C.dim(' (agents included).'));
  console.log('  ' + C.dim('Stop it with ') + 'bro pool down');
  console.log('');
  return 0;
}

// `bro pool down` — stop the server and restore the normal Claude login.
export async function poolDown() {
  const port = poolPort();
  const restored = clearPoolEnv();
  const killed = await killProxy(port);
  if (killed || restored) {
    console.log('Pool backend stopped. Claude Code sessions use your normal login again.');
  } else {
    console.log('Pool was not running.');
  }
  return 0;
}

// `bro pool status` — server health + whether the global override is active.
export async function poolStatus() {
  const port = poolPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const up = await healthy(port);
  const active = isPoolEnvActive();
  if (up) {
    printStatus(await fetchStatus(port), baseUrl);
  } else {
    console.log('\n  ' + C.red('●') + ' Pool server not running on ' + baseUrl + '\n');
  }
  console.log('  ' + C.dim('Claude backend override: ') + (active ? C.green('active (all sessions → pool)') : C.dim('off')));
  console.log('');
  if (active && !up) {
    console.log('  ' + C.amber('settings.json points at the pool but the server is down — run `bro pool up` or `bro pool down`.') + '\n');
  }
  return 0;
}

export async function runPoolCommand(args = []) {
  const sub = args[0];
  if (sub === 'up') return poolUp();
  if (sub === 'down') return poolDown();
  if (sub === 'status') return poolStatus();
  console.log('Usage: bro pool <up|down|status>');
  return sub ? 1 : 0;
}

// If the pool is set as the backend but its server is gone, strip the override so
// Claude Code isn't bricked (there is no automatic fallback to Anthropic).
export async function selfHealPoolEnv() {
  if (!isPoolEnvActive()) return;
  if (await healthy(poolPort())) return;
  clearPoolEnv();
  console.error(
    'bro: the account pool was set as your Claude backend but its server isn’t running —\n' +
      '     removed the override from settings.json so Claude works normally. (`bro pool up` to restart.)'
  );
}
```

- [ ] **Step 6: Rewrite `runPool` so it applies the global override and never tears down on exit**

Replace the entire existing `runPool` function with:

```js
export async function runPool({ extraArgs = [], permissionMode = 'auto', dryRun = false } = {}) {
  const port = poolPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const { baseUrl: b, token } = poolEnvValues(port);

  if (dryRun) {
    return {
      via: 'multiple-account pool',
      poolServer: `bun run ${POOL_ENTRY} serve`,
      poolDir: POOL_DIR,
      backend: process.env.CLAUDE_POOL_BACKEND || 'oauth',
      baseUrl,
      accounts: listAccounts(),
      settingsEnv: { ANTHROPIC_BASE_URL: b, ANTHROPIC_AUTH_TOKEN: token },
      claude: {
        cmd: which('claude') || 'claude',
        args: [...permissionArgs(permissionMode), ...extraArgs],
        env: { ANTHROPIC_BASE_URL: baseUrl }
      }
    };
  }

  const bun = findBun();

  // 1) At least one authenticated account.
  const authed = await ensureAccount(bun);
  if (authed.length === 0) {
    console.log('No accounts configured — nothing to launch.');
    return 0;
  }

  // 2) Bring the (persistent) server up and make the pool the backend for every
  //    Claude Code session, including agents started from the agents view.
  await ensureServer(bun, port, baseUrl);
  applyPoolEnv({ baseUrl: b, token });

  // 3) Flash live status, then launch. enter = now, any key = pause, esc = cancel.
  printStatus(await fetchStatus(port), baseUrl);
  process.stdout.write('  ' + C.dim('Launching Claude…  ') + C.dim('enter = now · any key = pause · esc = cancel'));
  const go = await holdOrContinue({ ms: 1500 });
  process.stdout.write('\n');
  if (!go) {
    console.log('Cancelled. ' + C.dim('(Pool is still running — `bro pool down` to stop it.)'));
    return 0;
  }

  // 4) Launch Claude Code pointed at the pool. The env is also set on this process
  //    (highest precedence) as belt-and-suspenders on top of the settings.json env.
  const claude = which('claude');
  if (!claude) {
    throw new Error('The `claude` CLI was not found. Install Claude Code: https://claude.com/claude-code');
  }

  const env = { ...process.env };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
  env.ANTHROPIC_BASE_URL = b;
  env.ANTHROPIC_AUTH_TOKEN = token;
  env.NODE_NO_WARNINGS = '1';

  const claudeArgs = [...permissionArgs(permissionMode), ...extraArgs];

  console.log('Launching Claude Code through the account pool…\n');
  try {
    return await runInherit(claude, claudeArgs, env);
  } finally {
    console.log('\n' + C.dim('Pool is still your Claude backend (agents included). Stop it with `bro pool down`.'));
  }
}
```

- [ ] **Step 7: Syntax check**

Run: `node --check src/pool.js`
Expected: no output (exit 0).

- [ ] **Step 8: Verify the existing pool Bun test still passes (no regression)**

Run: `cd pool && bun test src/accounts/keychain.test.ts; cd ..`
Expected: PASS (2 pass, 0 fail) — unchanged.

- [ ] **Step 9: Commit**

```bash
git add src/pool.js
git commit -m "Pool: persistent server + up/down/status + global settings override"
```

---

### Task 3: `src/cli.js` — route `bro pool <sub>`, self-heal on startup, HELP

**Files:**
- Modify: `src/cli.js`

- [ ] **Step 1: Extend the pool import**

Change:

```js
import { runPool, runPoolAccounts, POOL_PROVIDER } from './pool.js';
```

to:

```js
import { runPool, runPoolAccounts, runPoolCommand, selfHealPoolEnv, POOL_PROVIDER } from './pool.js';
```

- [ ] **Step 2: Dispatch `bro pool <sub>` and run self-heal early**

Just after the existing accounts dispatch block:

```js
  if (argv[0] === 'accounts') {
    return runPoolAccounts(argv.slice(1));
  }
```

add:

```js
  if (argv[0] === 'pool') {
    return runPoolCommand(argv.slice(1));
  }
```

Then, immediately after `const config = loadConfig();`, add (guarded so it doesn't warn right before we intentionally bring the pool up via `-p pool`):

```js
  // Safety net: if a previous pool session left the global override in place but
  // the server is gone, strip it so Claude Code still works.
  if (!(args.provider && args.provider.toLowerCase() === 'pool')) {
    await selfHealPoolEnv();
  }
```

- [ ] **Step 3: Update HELP text**

In the `HELP` template, after the `bro image -p <api>` line and before `bro -p <provider>`, add:

```
  bro pool up            Make the account pool the backend for ALL Claude
                         Code sessions (agents included)
  bro pool down          Stop the pool and restore your normal Claude login
  bro pool status        Show pool server + backend-override status
```

- [ ] **Step 4: Syntax check**

Run: `node --check src/cli.js`
Expected: no output (exit 0).

- [ ] **Step 5: Commit**

```bash
git add src/cli.js
git commit -m "CLI: bro pool up/down/status + self-heal stale pool backend"
```

---

### Task 4: `README.md` — document the persistent/global behavior

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the pool section**

In the "Multiple Claude Account Proxy" section, replace the "Manage pool accounts directly through `bro`" list's surrounding text by adding this subsection immediately before that list:

```markdown
### Pool as your Claude backend (agents included)

Launching the pool (`bro -p pool`) now makes it the backend for **every** Claude
Code session on the machine — foreground windows *and* background agents started
from the agents view — by writing `ANTHROPIC_BASE_URL` into your
`~/.claude/settings.json` and leaving the pool server running after Claude exits.

```sh
bro pool up       # start the pool as the global Claude backend
bro pool status   # show server health + whether the override is active
bro pool down     # stop the pool and restore your normal Claude login
```

The override stays active until you run `bro pool down`. If the pool server ever
stops while the override is still set, the next `bro` command strips it
automatically (Claude Code has no fallback for an unreachable base URL, so this
keeps `claude` working). Note: pointing Claude at a local proxy disables MCP tool
search and Remote Control for those sessions.
```

- [ ] **Step 2: Update the `### Flags` block**

Add these lines to the fenced flags list:

```sh
bro pool up               # make the pool the backend for all Claude sessions
bro pool down             # stop the pool, restore your normal Claude login
bro pool status           # pool server + backend-override status
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Docs: pool-as-global-backend behavior and bro pool up/down/status"
```

---

### Task 5: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Full unit test run**

Run: `node --test src/settings.test.js`
Expected: PASS, 6/6.

- [ ] **Step 2: Syntax check everything touched**

Run: `node --check src/settings.js && node --check src/pool.js && node --check src/cli.js && echo OK`
Expected: `OK`.

- [ ] **Step 3: HELP shows the new commands**

Run: `node bin/bro.js --help`
Expected: output contains `bro pool up`, `bro pool down`, `bro pool status`.

- [ ] **Step 4: `bro pool status` with the server down (in a throwaway HOME so nothing real is touched)**

Run:
```bash
tmp=$(mktemp -d); HOME="$tmp" CLAUDE_CONFIG_DIR="$tmp/.claude" node bin/bro.js pool status; rm -rf "$tmp"
```
Expected: reports the server is not running and the override is `off`; exit 0.

- [ ] **Step 5: dry-run still describes the launch and now includes the settings override**

Run: `node bin/bro.js -p pool --dry-run`
Expected: JSON includes `"settingsEnv"` with `ANTHROPIC_BASE_URL` and the `claude.args` still show `--permission-mode auto`.

- [ ] **Step 6: self-heal strips a stale override (throwaway HOME)**

Run:
```bash
tmp=$(mktemp -d)
mkdir -p "$tmp/.claude" "$tmp/.bro"
printf '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:3456","ANTHROPIC_AUTH_TOKEN":"claude-max-pool"},"model":"opus"}' > "$tmp/.claude/settings.json"
printf '{"managed":true,"prior":{"ANTHROPIC_BASE_URL":null,"ANTHROPIC_AUTH_TOKEN":null}}' > "$tmp/.bro/pool-settings.json"
HOME="$tmp" CLAUDE_CONFIG_DIR="$tmp/.claude" node bin/bro.js --help >/dev/null
echo '--- settings after self-heal ---'; cat "$tmp/.claude/settings.json"
rm -rf "$tmp"
```
Expected: a stderr warning about removing the override; `settings.json` afterward has no `env` block but still has `"model":"opus"`.

- [ ] **Step 7: Final commit if anything was adjusted during verification (otherwise skip)**

```bash
git add -A && git commit -m "Fixups from pool-backend verification" || echo "nothing to commit"
```

---

## Notes for the implementer

- `ensureAccount`, `findBun`, `healthy`, `waitHealthy`, `fetchStatus`, `printStatus`, `C`, `which`, `runInherit`, `holdOrContinue`, `DEFAULT_PORT`, `POOL_DIR`, `POOL_ENTRY`, `PROXY_LOG` already exist in `src/pool.js` — reuse them, don't redefine.
- Do **not** reintroduce the old `stopProxy()`-in-`finally` teardown; leaving the server up is the whole point.
- `applyPoolEnv`/`clearPoolEnv` default to the real paths (`CLAUDE_CONFIG_DIR || ~/.claude` and `~/.bro/pool-settings.json`); only the tests pass explicit paths.
