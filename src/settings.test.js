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
  newestFable,
  sonnetPinFromCatalog,
  refreshCachedFableRow,
  refreshCachedFableRowFile,
  RETIRED_POOL_ENV_KEYS,
  codexDefaultContextFromCatalog,
  scrubManagedContext
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

test('codexDefaultContextFromCatalog takes the safest valid unsuffixed default', () => {
  const models = [
    { id: 'claude-sonnet-5', owned_by: 'anthropic-claude-max-pool', context_window: 1000000 },
    { id: 'gpt-5.6-sol[1m]', owned_by: 'openai-chatgpt-pool', context_window: 272000, max_context_window: 872000 },
    { id: 'gpt-5.5', owned_by: 'openai-chatgpt-pool', context_window: 272000, max_context_window: 272000 },
    { id: 'broken', owned_by: 'openai-chatgpt-pool', context_window: -1 },
  ];
  assert.equal(codexDefaultContextFromCatalog(models), 272000);
  assert.equal(codexDefaultContextFromCatalog([{ id: 'claude', owned_by: 'anthropic-claude-max-pool', context_window: 200000 }]), null);
  assert.equal(codexDefaultContextFromCatalog(null), null);
});

test('poolEnvBlock writes only the max-context fallback, never global auto-compact', () => {
  const env = poolEnvBlock({ ...POOL, maxContextTokens: 272000 });
  assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '272000');
  assert.equal(env.BRO_POOL_MANAGED_MAX_CONTEXT_TOKENS, '272000');
  assert.ok(!('CLAUDE_CODE_AUTO_COMPACT_WINDOW' in env));
  assert.deepEqual(poolEnvBlock(POOL), {
    ANTHROPIC_BASE_URL: POOL.baseUrl,
    ANTHROPIC_AUTH_TOKEN: POOL.token,
  });
});

test('scrubManagedContext removes only an inherited value proven to be bro-managed', () => {
  const managed = {
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '272000',
    BRO_POOL_MANAGED_MAX_CONTEXT_TOKENS: '272000',
  };
  assert.deepEqual(scrubManagedContext(managed), {});

  const overridden = {
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '333000',
    BRO_POOL_MANAGED_MAX_CONTEXT_TOKENS: '272000',
  };
  assert.deepEqual(scrubManagedContext(overridden), { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '333000' });
});

// Claude Code renders its own picker rows behind the gateway (current Opus,
// Sonnet, Fable, Haiku, with the 1M variants). Pinning ANTHROPIC_DEFAULT_*_MODEL
// meant a bro release for every model release, so bro no longer touches them.
test('apply sets only the base URL and token unless catalog-derived context or pins are given', () => {
  const p = tmpPaths();
  applyPoolEnv(POOL, p);
  const { env } = read(p.settings);
  assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']);
  assert.deepEqual(poolEnvBlock(POOL), { ANTHROPIC_BASE_URL: POOL.baseUrl, ANTHROPIC_AUTH_TOKEN: POOL.token });
  assert.ok(RETIRED_POOL_ENV_KEYS.includes('CLAUDE_CODE_AUTO_COMPACT_WINDOW'));
});

test('apply and clear restore user context settings exactly', () => {
  const p = tmpPaths();
  fs.writeFileSync(p.settings, JSON.stringify({ env: {
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '333000',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '222000',
  } }));
  applyPoolEnv({ ...POOL, maxContextTokens: 272000 }, p);
  const active = read(p.settings).env;
  assert.equal(active.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '272000');
  assert.equal(active.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '222000');
  clearPoolEnv(p);
  assert.deepEqual(read(p.settings).env, {
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '333000',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '222000',
  });
});

test('an apply without catalog context removes bro fallback but preserves the user snapshot', () => {
  const p = tmpPaths();
  fs.writeFileSync(p.settings, JSON.stringify({ env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '333000' } }));
  applyPoolEnv({ ...POOL, maxContextTokens: 272000 }, p);
  applyPoolEnv(POOL, p);
  assert.equal(read(p.settings).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '333000');
  clearPoolEnv(p);
  assert.equal(read(p.settings).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '333000');
});

test('apply retires an old pool auto-compact value using its existing snapshot', () => {
  const p = tmpPaths();
  fs.writeFileSync(p.settings, JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: POOL.baseUrl,
    ANTHROPIC_AUTH_TOKEN: POOL.token,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '272000',
  } }));
  fs.writeFileSync(p.state, JSON.stringify({ managed: true, prior: {
    ANTHROPIC_BASE_URL: null,
    ANTHROPIC_AUTH_TOKEN: null,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: null,
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: null,
  } }));
  applyPoolEnv({ ...POOL, maxContextTokens: 272000 }, p);
  assert.ok(!('CLAUDE_CODE_AUTO_COMPACT_WINDOW' in read(p.settings).env));
});

test('an older snapshot backfills the new max-context key before overwrite', () => {
  const p = tmpPaths();
  fs.writeFileSync(p.settings, JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: POOL.baseUrl,
    ANTHROPIC_AUTH_TOKEN: POOL.token,
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '333000',
  } }));
  fs.writeFileSync(p.state, JSON.stringify({ managed: true, prior: {
    ANTHROPIC_BASE_URL: null,
    ANTHROPIC_AUTH_TOKEN: null,
  } }));
  applyPoolEnv({ ...POOL, maxContextTokens: 272000 }, p);
  assert.equal(read(p.state).prior.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '333000');
  clearPoolEnv(p);
  assert.equal(read(p.settings).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '333000');
});

test('clear preserves user max context absent from a legacy managed snapshot', () => {
  const p = tmpPaths();
  fs.writeFileSync(p.settings, JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: POOL.baseUrl,
    ANTHROPIC_AUTH_TOKEN: POOL.token,
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '333000',
  } }));
  fs.writeFileSync(p.state, JSON.stringify({ managed: true, prior: {
    ANTHROPIC_BASE_URL: null,
    ANTHROPIC_AUTH_TOKEN: null,
  } }));
  clearPoolEnv(p);
  assert.deepEqual(read(p.settings).env, { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '333000' });
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
  applyPoolEnv({ ...POOL, maxContextTokens: 272000 }, p);
  assert.equal(read(p.settings).env.ANTHROPIC_BASE_URL, POOL.baseUrl);
  assert.equal(read(p.settings).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '272000');
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

// Claude Code's Fable picker row is a cached bootstrap answer that never
// refreshes behind the pool; bro refreshes it from the live catalog instead.
test('newestFable picks the newest claude-fable-* id from the catalog', () => {
  const models = [
    { id: 'claude-fable-5', display_name: 'Claude Fable 5', created: 100 },
    { id: 'claude-opus-5', display_name: 'Claude Opus 5', created: 300 },
    { id: 'claude-fable-5-1', display_name: 'Claude Fable 5.1', created: 200 },
    { id: 'gpt-5.6-sol' }
  ];
  assert.deepEqual(newestFable(models), { id: 'claude-fable-5-1', name: 'Fable 5.1' });
  assert.equal(newestFable([{ id: 'claude-fable-5' }, { id: 'claude-fable-5-2' }]).id, 'claude-fable-5-2');
  assert.equal(newestFable([{ id: 'claude-opus-5' }]), null);
  assert.equal(newestFable(null), null);
});

test('refreshCachedFableRow rewrites only the version-bearing parts of a stale row', () => {
  const json = { additionalModelOptionsCache: [
    { value: 'claude-fable-5[1m]', label: 'Fable', description: 'Fable 5 · Most capable for your hardest and longest-running tasks · $10/$50 per Mtok' },
    { value: 'claude-opus-5', label: 'Opus', description: 'Opus 5 · x' }
  ], additionalModelOptionsAnsweredAt: 123 };
  assert.equal(refreshCachedFableRow(json, { id: 'claude-fable-5-1', name: 'Fable 5.1' }), true);
  assert.deepEqual(json.additionalModelOptionsCache[0], {
    value: 'claude-fable-5-1[1m]', label: 'Fable',
    description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks · $10/$50 per Mtok'
  });
  assert.deepEqual(json.additionalModelOptionsCache[1], { value: 'claude-opus-5', label: 'Opus', description: 'Opus 5 · x' });
  assert.equal(json.additionalModelOptionsAnsweredAt, 123);
  // Already current, no cache, or no Fable in the catalog: untouched.
  assert.equal(refreshCachedFableRow(json, { id: 'claude-fable-5-1', name: 'Fable 5.1' }), false);
  assert.equal(refreshCachedFableRow({}, { id: 'claude-fable-5-1', name: 'Fable 5.1' }), false);
  assert.equal(refreshCachedFableRow(json, null), false);
});

test('refreshCachedFableRowFile rewrites .claude.json in place and leaves a missing file alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-claude-json-'));
  const file = path.join(dir, '.claude.json');
  fs.writeFileSync(file, JSON.stringify({ other: true, additionalModelOptionsCache: [{ value: 'claude-fable-5[1m]', label: 'Fable', description: 'Fable 5 · Most capable' }] }));
  const models = [{ id: 'claude-fable-5-1', display_name: 'Claude Fable 5.1' }];
  assert.equal(refreshCachedFableRowFile(models, file), true);
  const out = read(file);
  assert.equal(out.other, true);
  assert.equal(out.additionalModelOptionsCache[0].value, 'claude-fable-5-1[1m]');
  assert.equal(out.additionalModelOptionsCache[0].description, 'Fable 5.1 · Most capable');
  assert.equal(refreshCachedFableRowFile(models, file), false);
  assert.equal(refreshCachedFableRowFile(models, path.join(dir, 'missing.json')), false);
});

// Sonnet's built-in row shows twice behind the pool (200K + 1M); a pin replaces
// it with one 1M row. The pin comes from the live catalog, never a literal.
test('sonnetPinFromCatalog pins the newest Sonnet 1M with Claude Code\'s row wording', () => {
  const pins = sonnetPinFromCatalog([
    { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', created: 100 },
    { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', created: 200 },
    { id: 'claude-fable-5-1', display_name: 'Claude Fable 5.1', created: 300 }
  ]);
  assert.deepEqual(pins, {
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5[1m]',
    ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'Sonnet',
    ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION: 'Sonnet 5 with 1M context · Efficient for routine tasks'
  });
  assert.deepEqual(sonnetPinFromCatalog([{ id: 'claude-opus-5' }]), {});
});

test('apply writes the derived Sonnet pin; an apply without one removes it; clear restores the user', () => {
  const p = tmpPaths();
  fs.writeFileSync(p.settings, JSON.stringify({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6' } }));
  const pins = sonnetPinFromCatalog([{ id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' }]);
  applyPoolEnv({ ...POOL, pins }, p);
  assert.equal(read(p.settings).env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-5[1m]');
  assert.equal(read(p.settings).env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME, 'Sonnet');
  applyPoolEnv(POOL, p); // catalog unreachable this time
  assert.equal(read(p.settings).env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-4-6');
  assert.ok(!('ANTHROPIC_DEFAULT_SONNET_MODEL_NAME' in read(p.settings).env));
  clearPoolEnv(p);
  assert.deepEqual(read(p.settings), { env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6' } });
});

test('a future derived Sonnet pin is recognised as bro\'s when no snapshot survived', () => {
  const p = tmpPaths();
  fs.writeFileSync(p.settings, JSON.stringify({ env: {
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-6[1m]',
    ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION: 'Sonnet 6 with 1M context · Efficient for routine tasks'
  } }));
  applyPoolEnv(POOL, p);
  assert.ok(!('ANTHROPIC_DEFAULT_SONNET_MODEL' in read(p.settings).env));
});
