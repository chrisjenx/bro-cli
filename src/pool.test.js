import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { waitForExit, reapplyPoolEnv, POOL_SUBCOMMANDS, runPoolCommand } from './pool.js';

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
