import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyPoolEnv } from './settings.js';
import { waitForExit, reapplyPoolEnv, catalogSync, refreshPoolEnv, selfHealPoolEnv, runPoolModels, POOL_SUBCOMMANDS, runPoolCommand } from './pool.js';

test('waitForExit resolves true once the process exits', async () => {
  const child = spawn('sleep', ['0.3']);
  const exited = await waitForExit(child.pid, 5000, 50);
  assert.equal(exited, true);
});

test('waitForExit resolves false when the process outlives the timeout', async () => {
  const child = spawn('sleep', ['10']);
  try {
    const exited = await waitForExit(child.pid, 300, 50);
    assert.equal(exited, false);
  } finally {
    child.kill('SIGKILL');
  }
});

test('waitForExit resolves true immediately for a dead pid', async () => {
  const child = spawn('sleep', ['0.05']);
  await new Promise((r) => child.on('exit', r));
  const start = Date.now();
  assert.equal(await waitForExit(child.pid, 5000, 50), true);
  assert.ok(Date.now() - start < 1000);
});

// `bro pool up` and `bro pool restart` both go through reapplyPoolEnv, so a
// restart writes the same settings.json override as up. Guards against restart
// silently drifting from up again — and against model pins creeping back in
// (Claude Code owns its picker; bro only points it at the pool).
test('reapplyPoolEnv writes the pool env and nothing else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-pool-restart-'));
  const paths = {
    settings: path.join(dir, 'settings.json'),
    state: path.join(dir, 'pool-settings.json')
  };
  reapplyPoolEnv(4321, paths);
  const { env } = JSON.parse(fs.readFileSync(paths.settings, 'utf8'));
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4321');
  assert.ok(!Object.keys(env).some((k) => k.startsWith('ANTHROPIC_DEFAULT_')), Object.keys(env).join());
  assert.ok(!('CLAUDE_CODE_MAX_CONTEXT_TOKENS' in env));
});

// `start`/`stop` are the verbs people reach for once `restart` exists. They used
// to fall through to the usage line, so the settings.json override was never
// written and Claude Code kept using the normal login.
test('start and stop are aliases for up and down', () => {
  assert.equal(POOL_SUBCOMMANDS.start, POOL_SUBCOMMANDS.up);
  assert.equal(POOL_SUBCOMMANDS.stop, POOL_SUBCOMMANDS.down);
});

test('an unknown pool subcommand still fails instead of silently doing nothing', async () => {
  assert.equal(await runPoolCommand(['bogus']), 1);
});


// `up`/`restart` pass the catalog-derived pins through reapplyPoolEnv.
test('reapplyPoolEnv writes catalog-derived pins alongside the pool env', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-pool-pins-'));
  const paths = { settings: path.join(dir, 'settings.json'), state: path.join(dir, 'pool-settings.json') };
  reapplyPoolEnv(4321, paths, { pins: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5[1m]', ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'Sonnet' } });
  const { env } = JSON.parse(fs.readFileSync(paths.settings, 'utf8'));
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4321');
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-5[1m]');
});

test('reapplyPoolEnv writes the catalog-derived Codex fallback without auto-compact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-pool-context-'));
  const paths = {
    settings: path.join(dir, 'settings.json'),
    state: path.join(dir, 'pool-settings.json'),
  };
  reapplyPoolEnv(4321, paths, { maxContextTokens: 272000 });
  const { env } = JSON.parse(fs.readFileSync(paths.settings, 'utf8'));
  assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '272000');
  assert.ok(!('CLAUDE_CODE_AUTO_COMPACT_WINDOW' in env));
});

test('catalogSync derives pins and the unsuffixed Codex baseline from one listing', async () => {
  const priorFetch = globalThis.fetch;
  const priorConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-pool-catalog-'));
  process.env.CLAUDE_CONFIG_DIR = dir;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [
    { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', created: 2, owned_by: 'anthropic-claude-max-pool' },
    { id: 'gpt-5.6-sol[1m]', owned_by: 'openai-chatgpt-pool', context_window: 272000, max_context_window: 872000 },
    { id: 'gpt-5.5', owned_by: 'openai-chatgpt-pool', context_window: 272000, max_context_window: 272000 },
  ] }));
  try {
    const derived = await catalogSync(4321);
    assert.equal(derived.maxContextTokens, 272000);
    assert.equal(derived.pins.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-5[1m]');
  } finally {
    globalThis.fetch = priorFetch;
    if (priorConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = priorConfigDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A new Claude model ships while the pool keeps running: the Sonnet pin written
// at `pool up` must follow the live catalog without a pool restart.
const SONNET_5 = { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', created: 1, owned_by: 'anthropic-claude-max-pool' };
const SONNET_5_5 = { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', created: 2, owned_by: 'anthropic-claude-max-pool' };
const APPLIED_URL = 'http://127.0.0.1:4321';

// Runs `fn(paths, fetched)` against a temp profile already pointed at the pool
// on APPLIED_URL with `token` and a Sonnet 5 pin. fetch answers /health and
// /v1/models from `catalog` (null = the catalog request fails) unless `fetch`
// replaces it; `fetched` collects the requested URLs.
async function withStalePool({ catalog = [SONNET_5, SONNET_5_5], token = 'claude-max-pool', fetch } = {}, fn) {
  const priorFetch = globalThis.fetch;
  const priorConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-pool-refresh-'));
  process.env.CLAUDE_CONFIG_DIR = dir;
  const paths = { settings: path.join(dir, 'settings.json'), state: path.join(dir, 'pool-settings.json') };
  applyPoolEnv({ baseUrl: APPLIED_URL, token, pins: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5[1m]' } }, paths);
  const fetched = [];
  globalThis.fetch = fetch ?? (async (url) => {
    fetched.push(String(url));
    if (String(url).endsWith('/health')) return new Response('ok');
    if (catalog === null) return new Response('nope', { status: 502 });
    return new Response(JSON.stringify({ data: catalog }));
  });
  try {
    return await fn(paths, fetched);
  } finally {
    globalThis.fetch = priorFetch;
    if (priorConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = priorConfigDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const appliedEnv = (paths) => JSON.parse(fs.readFileSync(paths.settings, 'utf8')).env;

test('refreshPoolEnv moves a stale Sonnet pin to the newest catalog Sonnet', async () => {
  await withStalePool({}, async (paths) => {
    assert.equal(await refreshPoolEnv({ paths }), true);
    assert.equal(appliedEnv(paths).ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-5-5[1m]');
  });
});

// Without a catalog there is nothing to derive from; dropping the pin would put
// the duplicate 200K Sonnet row back in the picker.
test('refreshPoolEnv keeps the existing pin when the catalog is unreachable', async () => {
  await withStalePool({ catalog: null }, async (paths) => {
    assert.equal(await refreshPoolEnv({ paths }), false);
    assert.equal(appliedEnv(paths).ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-5[1m]');
  });
});

// Anthropic's catalog fetch failing inside the pool yields its alias-only table
// listing, not an error: nothing derivable, so the existing pins must stay.
test('refreshPoolEnv keeps the existing pin when the pool serves its alias-only fallback', async () => {
  const fallback = ['opus', 'sonnet', 'haiku', 'fable'].map((id) => ({ id, object: 'model', created: 0, owned_by: 'anthropic-claude-max-pool' }));
  await withStalePool({ catalog: fallback }, async (paths) => {
    assert.equal(await refreshPoolEnv({ paths }), false);
    assert.equal(appliedEnv(paths).ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-5[1m]');
  });
});

test('refreshPoolEnv pins the newest catalog Haiku', async () => {
  const HAIKU_5_5 = { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', created: 3, owned_by: 'anthropic-claude-max-pool' };
  await withStalePool({ catalog: [SONNET_5_5, HAIKU_5_5] }, async (paths) => {
    assert.equal(await refreshPoolEnv({ paths }), true);
    assert.equal(appliedEnv(paths).ANTHROPIC_DEFAULT_HAIKU_MODEL, 'claude-haiku-5-5');
  });
});

// The pool may have been brought up with PROXY_API_KEY/PORT that the shell
// running a later `bro` doesn't have; the refresh must use and keep the URL and
// token the override was applied with, or every session starts getting 401s.
test('refreshPoolEnv reads from and keeps the applied base URL and token', async () => {
  await withStalePool({ token: 'secret' }, async (paths, fetched) => {
    await refreshPoolEnv({ paths });
    assert.deepEqual(fetched, [`${APPLIED_URL}/v1/models`]);
    const env = appliedEnv(paths);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'secret');
    assert.equal(env.ANTHROPIC_BASE_URL, APPLIED_URL);
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-5-5[1m]');
  });
});

// The launch-time bound must cover the body too: headers then a stalled body
// would otherwise hold every `bro` launch.
test('refreshPoolEnv gives up on a catalog body that stalls', { timeout: 3000 }, async () => {
  const fetch = async (_url, { signal }) =>
    new Response(new ReadableStream({ start(c) { signal.addEventListener('abort', () => c.error(signal.reason)); } }));
  // A real stalled socket keeps the event loop alive; the mock stream doesn't,
  // and AbortSignal.timeout's timer is unref'd.
  const socket = setInterval(() => {}, 1000);
  try {
    await withStalePool({ fetch }, async (paths) => {
      assert.equal(await refreshPoolEnv({ paths, timeoutMs: 100 }), false);
      assert.equal(appliedEnv(paths).ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-5[1m]');
    });
  } finally {
    clearInterval(socket);
  }
});

test('every bro launch refreshes the pins of a running pool', async () => {
  await withStalePool({}, async (paths) => {
    await selfHealPoolEnv({ paths });
    assert.equal(appliedEnv(paths).ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-5-5[1m]');
  });
});

test('bro models update refreshes the pins after a successful update', async () => {
  await withStalePool({}, async (paths) => {
    assert.equal(await runPoolModels(['update'], { run: async () => 0, paths }), 0);
    assert.equal(appliedEnv(paths).ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-5-5[1m]');
  });
});

test('bro models list leaves the pins alone', async () => {
  await withStalePool({}, async (paths) => {
    await runPoolModels(['list'], { run: async () => 0, paths });
    assert.equal(appliedEnv(paths).ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-5[1m]');
  });
});
