import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from './cli.js';

// Flags/commands from bro's multi-provider days must be rejected up front: if
// they fell through to claude they would run only after the pool had been made
// the global backend, and `update` / `-p <x>` mean something else to claude.
test('removed provider-era flags and commands are rejected before any launch', async () => {
  const priorError = console.error;
  console.error = () => {};
  try {
    for (const argv of [['update'], ['image'], ['-p', 'openrouter'], ['--provider', 'sakana'], ['-m', 'opus'], ['--list'], ['-l']]) {
      assert.equal(await main(argv), 1, argv.join(' '));
    }
  } finally {
    console.error = priorError;
  }
});
