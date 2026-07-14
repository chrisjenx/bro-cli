import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { waitForExit } from './pool.js';

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
