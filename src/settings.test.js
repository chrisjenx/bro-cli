import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyPoolEnv,
  clearPoolEnv,
  isPoolEnvActive,
  defaultPaths,
  poolEnvBlock,
  RETIRED_POOL_ENV_KEYS
} from './settings.js';

function tmpPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-settings-'));
  return { settings: path.join(dir, 'settings.json'), state: path.join(dir, 'pool-settings.json'), dir };
}
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const POOL = { baseUrl: 'http://127.0.0.1:3456', token: 'claude-max-pool' };

// Run `fn` with CLAUDE_CONFIG_DIR set to `dir` (or unset when null).
function withConfigDir(dir, fn) {
  const prior = process.env.CLAUDE_CONFIG_DIR;
  if (dir === null) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prior;
  }
}

test('defaultPaths follows CLAUDE_CONFIG_DIR to the active profile', () => {
  const dir = path.join(os.homedir(), '.claude-personal');
  const p = withConfigDir(dir, defaultPaths);
  assert.equal(p.settings, path.join(dir, 'settings.json'));
});

// The default profile keeps the original filename so a state file written by an
// earlier bro — which only ever managed ~/.claude — still round-trips.
test('defaultPaths keeps the legacy state filename for the default profile', () => {
  const expected = path.join(os.homedir(), '.bro', 'pool-settings.json');
  assert.equal(withConfigDir(null, defaultPaths).state, expected);
  assert.equal(withConfigDir(path.join(os.homedir(), '.claude'), defaultPaths).state, expected);
});

// One fixed state path meant `bro pool up` under ~/.claude-personal and a later
// `bro pool down` under ~/.claude shared a snapshot: down cleaned the wrong file
// and left the other profile with an override bro could never find again.
test('defaultPaths gives each profile its own state file', () => {
  const a = withConfigDir(path.join(os.homedir(), '.claude-personal'), defaultPaths).state;
  const b = withConfigDir(path.join(os.homedir(), '.claude-work'), defaultPaths).state;
  const dflt = withConfigDir(null, defaultPaths).state;
  assert.notEqual(a, b);
  assert.notEqual(a, dflt);
  assert.notEqual(b, dflt);
  // Stable across calls, and inside ~/.bro.
  assert.equal(a, withConfigDir(path.join(os.homedir(), '.claude-personal'), defaultPaths).state);
  assert.equal(path.dirname(a), path.join(os.homedir(), '.bro'));
});

// Profile dirs are dot-prefixed (~/.claude-personal), so a naive basename gave
// `pool-settings..claude-personal.<hash>.json`.
test('the per-profile state filename is not dot-mangled', () => {
  const f = path.basename(withConfigDir(path.join(os.homedir(), '.claude-personal'), defaultPaths).state);
  assert.ok(!f.includes('..'), `double dot in ${f}`);
  assert.match(f, /^pool-settings\.claude-personal\.[0-9a-f]{8}\.json$/);
});

// Two profiles pointed at the pool must unwind independently.
test('clearing one profile leaves another profile’s override intact', () => {
  const a = tmpPaths();
  const b = tmpPaths();
  fs.writeFileSync(a.settings, JSON.stringify({ model: 'opus' }));
  fs.writeFileSync(b.settings, JSON.stringify({ model: 'opus' }));
  applyPoolEnv(POOL, a);
  applyPoolEnv(POOL, b);
  assert.equal(clearPoolEnv(a), true);
  assert.deepEqual(read(a.settings), { model: 'opus' });
  assert.equal(isPoolEnvActive(a), false);
  assert.equal(isPoolEnvActive(b), true);
  assert.equal(read(b.settings).env.ANTHROPIC_BASE_URL, POOL.baseUrl);
});

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

// Claude Code renders its own picker rows behind the gateway (current Opus,
// Sonnet, Fable, Haiku, with the 1M variants). Pinning ANTHROPIC_DEFAULT_*_MODEL
// meant a bro release for every model release, so bro no longer touches them.
test('apply sets only the base URL and token — no model pins', () => {
  const p = tmpPaths();
  applyPoolEnv(POOL, p);
  const { env } = read(p.settings);
  assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']);
  assert.deepEqual(poolEnvBlock(POOL), { ANTHROPIC_BASE_URL: POOL.baseUrl, ANTHROPIC_AUTH_TOKEN: POOL.token });
  for (const k of RETIRED_POOL_ENV_KEYS) assert.match(k, /^ANTHROPIC_DEFAULT_/);
});

// An earlier bro wrote the pins into settings.json; re-applying must scrub them
// (back to the user's snapshotted value) rather than leave them behind.
test('apply scrubs model pins written by an earlier bro', () => {
  const p = tmpPaths();
  fs.writeFileSync(p.settings, JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: POOL.baseUrl,
      ANTHROPIC_AUTH_TOKEN: POOL.token,
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5[1m]',
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'Opus',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5-1[1m]'
    }
  }));
  fs.writeFileSync(p.state, JSON.stringify({
    managed: true,
    prior: {
      ANTHROPIC_BASE_URL: null,
      ANTHROPIC_AUTH_TOKEN: null,
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-8',
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: null,
      ANTHROPIC_DEFAULT_FABLE_MODEL: null
    }
  }));
  applyPoolEnv(POOL, p);
  const { env } = read(p.settings);
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-4-8');
  assert.ok(!('ANTHROPIC_DEFAULT_OPUS_MODEL_NAME' in env));
  assert.ok(!('ANTHROPIC_DEFAULT_FABLE_MODEL' in env));
  assert.equal(env.ANTHROPIC_BASE_URL, POOL.baseUrl);
});

// No state file (say ~/.bro was wiped) but an earlier bro's pins are still in
// settings.json: they must not be snapshotted as the user's baseline.
test('apply scrubs old bro pins even when no state file survived', () => {
  const p = tmpPaths();
  fs.writeFileSync(p.settings, JSON.stringify({
    env: {
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5[1m]',
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'Sonnet',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'my-haiku' // not bro's: untouched
    }
  }));
  applyPoolEnv(POOL, p);
  const { env } = read(p.settings);
  assert.ok(!('ANTHROPIC_DEFAULT_SONNET_MODEL' in env));
  assert.ok(!('ANTHROPIC_DEFAULT_SONNET_MODEL_NAME' in env));
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'my-haiku');
  clearPoolEnv(p);
  assert.deepEqual(read(p.settings), { env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'my-haiku' } });
});

// A user's own pin is theirs: apply leaves it alone and clear keeps it.
test('apply and clear leave a user-set ANTHROPIC_DEFAULT_FABLE_MODEL alone', () => {
  const p = tmpPaths();
  fs.writeFileSync(p.settings, JSON.stringify({ env: { ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5' } }));
  applyPoolEnv(POOL, p);
  assert.equal(read(p.settings).env.ANTHROPIC_DEFAULT_FABLE_MODEL, 'claude-fable-5');
  clearPoolEnv(p);
  assert.deepEqual(read(p.settings), { env: { ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5' } });
});

// `bro pool down` after an older bro's `pool up`: the pins it wrote are gone.
test('clear removes pins an earlier bro wrote and the user never set', () => {
  const p = tmpPaths();
  fs.writeFileSync(p.settings, JSON.stringify({
    model: 'opus',
    env: { ANTHROPIC_BASE_URL: POOL.baseUrl, ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5[1m]' }
  }));
  fs.writeFileSync(p.state, JSON.stringify({
    managed: true, prior: { ANTHROPIC_BASE_URL: null, ANTHROPIC_DEFAULT_SONNET_MODEL: null }
  }));
  clearPoolEnv(p);
  assert.deepEqual(read(p.settings), { model: 'opus' });
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
