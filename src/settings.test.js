import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyPoolEnv, clearPoolEnv, isPoolEnvActive, POOL_SONNET_MODEL } from './settings.js';

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
  assert.equal(s.env.ANTHROPIC_DEFAULT_SONNET_MODEL, POOL_SONNET_MODEL);
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

test('clear restores a user ANTHROPIC_DEFAULT_SONNET_MODEL added before the key was managed', () => {
  const p = tmpPaths();
  // Simulate an older bro: the pool is already active (state file exists) but its
  // snapshot predates the sonnet key, while the user has their own value set.
  fs.writeFileSync(p.settings, JSON.stringify({
    env: { ANTHROPIC_BASE_URL: POOL.baseUrl, ANTHROPIC_AUTH_TOKEN: POOL.token, ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-5' }
  }));
  fs.writeFileSync(p.state, JSON.stringify({ managed: true, prior: { ANTHROPIC_BASE_URL: null, ANTHROPIC_AUTH_TOKEN: null } }));

  applyPoolEnv(POOL, p);
  assert.equal(read(p.settings).env.ANTHROPIC_DEFAULT_SONNET_MODEL, POOL_SONNET_MODEL); // overridden while active

  clearPoolEnv(p);
  const s = read(p.settings);
  assert.equal(s.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-4-5'); // user value backfilled + restored
  assert.ok(!('ANTHROPIC_BASE_URL' in s.env)); // was absent pre-pool → stays absent
});

test('apply twice keeps the original snapshot', () => {
  const p = tmpPaths();
  fs.writeFileSync(p.settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://gw.example' } }));
  applyPoolEnv(POOL, p);
  applyPoolEnv({ baseUrl: 'http://127.0.0.1:9999', token: 'x' }, p);
  clearPoolEnv(p);
  assert.equal(read(p.settings).env.ANTHROPIC_BASE_URL, 'https://gw.example');
});
