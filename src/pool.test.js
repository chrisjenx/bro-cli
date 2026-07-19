import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { waitForExit, reapplyPoolEnv } from './pool.js';
import { POOL_SONNET_MODEL } from './settings.js';

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
// restart writes the same settings.json override as up — including the sonnet
// 1M pin. Guards against restart silently drifting from up again.
test('reapplyPoolEnv writes the pool env, including the sonnet 1M pin', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-pool-restart-'));
  const paths = {
    settings: path.join(dir, 'settings.json'),
    state: path.join(dir, 'pool-settings.json')
  };
  reapplyPoolEnv(4321, paths);
  const { env } = JSON.parse(fs.readFileSync(paths.settings, 'utf8'));
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4321');
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, POOL_SONNET_MODEL);
});
