// Point Claude Code's settings.json `env` block at the account pool so *every*
// Claude Code session (foreground, new windows, background agents) routes through
// it. Reversible: applyPoolEnv snapshots whatever was there before, clearPoolEnv
// restores it exactly. All fs paths are injectable so the logic is unit-testable.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Pin Claude Code's `sonnet` alias to its 1M-context variant. Behind a custom
// ANTHROPIC_BASE_URL (Claude Code treats the pool as an "LLM gateway") it can't
// verify 1M support, so plain Sonnet is budgeted at 200K and auto-compacts
// there; the `[1m]` suffix selects the full ~1M window. Claude Code strips the
// `[1m]` before sending the request, so the pool still receives `claude-sonnet-5`.
// Bump this when the Sonnet default version changes.
export const POOL_SONNET_MODEL = 'claude-sonnet-5[1m]';

// Pin Claude Code's `opus` alias to the 1M-context Opus 5, for the same reason
// as Sonnet above: the bare id is budgeted at 200K behind the gateway and
// auto-compacts there, and pinning it would *downgrade* a user who had picked
// the 1M Opus row themselves. Bump when the Opus default version changes.
export const POOL_OPUS_MODEL = 'claude-opus-5[1m]';

const POOL_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL'
];

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

  // Snapshot the user's pre-pool values once so clearPoolEnv restores them.
  // Backfill keys introduced in a later bro version: a state file written before
  // a key existed won't have snapshotted it, and env[k] is still the user's own
  // value here (we overwrite below). The `!(k in prior)` guard stops already-
  // managed keys from being re-snapshotted with the pool's own values. A present
  // but unreadable state file is left alone (matches the original behaviour).
  const stateExists = fs.existsSync(paths.state);
  const state = stateExists ? readJson(paths.state) : null;
  if (!stateExists) {
    const prior = {};
    for (const k of POOL_ENV_KEYS) prior[k] = k in env ? env[k] : null;
    writeJson(paths.state, { managed: true, prior });
  } else if (state) {
    const prior = { ...(state.prior || {}) };
    let changed = false;
    for (const k of POOL_ENV_KEYS) {
      if (!(k in prior)) {
        prior[k] = k in env ? env[k] : null;
        changed = true;
      }
    }
    if (changed) writeJson(paths.state, { ...state, prior });
  }

  env.ANTHROPIC_BASE_URL = baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = token;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = POOL_SONNET_MODEL;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = POOL_OPUS_MODEL;
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
