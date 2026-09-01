import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  waitForExit,
  reapplyPoolEnv,
  fetchContextWindow,
  sessionWindowOf,
  contextWarningOf,
  sessionWindowLines,
  POOL_SUBCOMMANDS,
  runPoolCommand
} from './pool.js';
import {
  POOL_SONNET_MODEL,
  POOL_OPUS_MODEL,
  POOL_SONNET_MODEL_NAME,
  POOL_OPUS_MODEL_NAME,
  readPoolContextWindow
} from './settings.js';

// Strip ANSI so the assertions read on the words, not the colour codes.
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

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
test('reapplyPoolEnv writes the pool env, including the sonnet and opus 1M pins', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-pool-restart-'));
  const paths = {
    settings: path.join(dir, 'settings.json'),
    state: path.join(dir, 'pool-settings.json')
  };
  reapplyPoolEnv(4321, paths, null);
  const { env } = JSON.parse(fs.readFileSync(paths.settings, 'utf8'));
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4321');
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, POOL_SONNET_MODEL);
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, POOL_OPUS_MODEL);
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME, POOL_SONNET_MODEL_NAME);
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME, POOL_OPUS_MODEL_NAME);
  assert.equal('CLAUDE_CODE_AUTO_COMPACT_WINDOW' in env, false);
});

test('reapplyPoolEnv writes the auto-compact window it is given', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-pool-ctx-'));
  const paths = {
    settings: path.join(dir, 'settings.json'),
    state: path.join(dir, 'pool-settings.json')
  };
  reapplyPoolEnv(4321, paths, 272000);
  const { env } = JSON.parse(fs.readFileSync(paths.settings, 'utf8'));
  assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '272000');
  assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '272000');
});

// An unreachable pool must not block the override — the pins are still worth
// writing, and the window simply stays on Claude Code's own tuning.
test('fetchContextWindow returns null when the pool is unreachable', async () => {
  assert.equal(await fetchContextWindow(1), null);
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

// The pool's window is live (a dashboard mapping edit moves it at once) while
// settings.json is only rewritten at up/restart/launch. `bro pool status` has to
// surface both numbers, because the silent gap is how a dashboard click puts
// Claude Code back to budgeting a large window against a small model.
test('sessionWindowLines names both numbers and asks for a restart when they differ', () => {
  const out = sessionWindowLines(272000, 500000).map(plain);
  assert.equal(out.length, 2);
  assert.match(out[0], /272K/);
  assert.match(out[0], /500K/);
  assert.match(out[0], /settings\.json/);
  assert.match(out[1], /bro pool restart/);
});

test('sessionWindowLines stays quiet about drift when the two agree', () => {
  const out = sessionWindowLines(272000, 272000).map(plain);
  assert.equal(out.length, 1);
  assert.ok(!out[0].includes('bro pool restart'));
});

// A window that went back to null while settings.json still holds one is drift
// too — that is exactly the stale-value case, seen from the CLI.
test('sessionWindowLines reports a pool window of none against a stale settings value', () => {
  const out = sessionWindowLines(null, 272000).map(plain);
  assert.equal(out.length, 2);
  assert.match(out[0], /none/);
  assert.match(out[1], /bro pool restart/);
});

test('sessionWindowLines prints nothing when neither side has a window', () => {
  assert.deepEqual(sessionWindowLines(null, null), []);
});

// The steady state of a Claude-only pool: no Codex mapping, so the pool derives
// no window ever, and applyPoolEnv keeps restoring the user's own value rather
// than deleting it. That is not drift, and the restart advice would be a loop —
// applyPoolEnv(null) writes 400000 straight back.
test('sessionWindowLines does not call the user own restored window drift', () => {
  const out = sessionWindowLines(null, 400000, 400000).map(plain);
  assert.equal(out.length, 1);
  assert.match(out[0], /400K/);
  assert.ok(!out[0].includes('bro pool restart'));
});

// …but a settings value that is NOT the user's own is still stale pool output,
// which is the case the warning exists for.
test('sessionWindowLines still warns when the settings value is not the user own', () => {
  assert.equal(sessionWindowLines(272000, 500000, 400000).length, 2);
  assert.equal(sessionWindowLines(null, 272000, 400000).length, 2);
  // A user window that the pool happens to have pushed past is real drift too.
  assert.equal(sessionWindowLines(272000, 400000, 400000).length, 2);
});

test('sessionWindowOf reads the pool status block and rejects non-positive values', () => {
  assert.equal(sessionWindowOf({ context: { sessionWindow: 272000 } }), 272000);
  assert.equal(sessionWindowOf({ context: { sessionWindow: 0 } }), null);
  assert.equal(sessionWindowOf({ context: {} }), null);
  assert.equal(sessionWindowOf(null), null);
});

test('readPoolContextWindow reads what applyPoolEnv wrote, and null when absent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-pool-read-'));
  const paths = {
    settings: path.join(dir, 'settings.json'),
    state: path.join(dir, 'pool-settings.json')
  };
  assert.equal(readPoolContextWindow(paths), null);
  reapplyPoolEnv(4321, paths, 272000);
  assert.equal(readPoolContextWindow(paths), 272000);
  reapplyPoolEnv(4321, paths, null);
  assert.equal(readPoolContextWindow(paths), null);
});

// src/cli.js is imported by nothing else in the suite, so a syntax error in its
// HELP template literal — a stray backtick or `${` — would ship a green run and
// break only when a user typed `bro`. That has happened twice on this branch.
// Importing the module is most of the value here; the assertions keep HELP
// honest about the subcommands src/cli.js actually dispatches.
test('cli.js parses and its help documents every models subcommand', async () => {
  const { HELP } = await import('./cli.js');
  assert.equal(typeof HELP, 'string');
  for (const sub of ['list', 'update', 'context']) {
    assert.match(HELP, new RegExp(`bro models ${sub}\\b`));
  }
});


// The pool warns when an explicit session window outruns the smallest mapped
// model — that band fails hard instead of compacting. It is advisory (the
// override is deliberate), but it has to reach the terminal, not just the
// dashboard, since `bro pool up` is where the window gets applied.
test('contextWarningOf reads the pool status warning and is null when absent', () => {
  assert.equal(
    contextWarningOf({ context: { warning: 'session window 500,000 is larger than 272,000' } }),
    'session window 500,000 is larger than 272,000',
  );
  assert.equal(contextWarningOf({ context: { warning: null } }), null);
  assert.equal(contextWarningOf({ context: {} }), null);
  assert.equal(contextWarningOf({}), null);
  assert.equal(contextWarningOf(null), null);
});
