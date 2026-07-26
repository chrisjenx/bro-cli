// Point Claude Code's settings.json `env` block at the account pool so *every*
// Claude Code session (foreground, new windows, background agents) routes through
// it. Reversible: applyPoolEnv snapshots whatever was there before, clearPoolEnv
// restores it exactly. All fs paths are injectable so the logic is unit-testable.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Pin Claude Code's `sonnet` alias to its 1M-context variant. Behind a custom
// ANTHROPIC_BASE_URL (Claude Code treats the pool as an "LLM gateway") it can't
// verify 1M support, so plain Sonnet is budgeted at 200K and auto-compacts
// there; the `[1m]` suffix selects the full ~1M window. Claude Code strips the
// `[1m]` before sending the request, so the pool still receives `claude-sonnet-5`.
// Bump this when the Sonnet default version changes.
export const POOL_SONNET_MODEL = 'claude-sonnet-5[1m]';

// Behind a custom base URL Claude Code renders the Sonnet picker row *from*
// ANTHROPIC_DEFAULT_SONNET_MODEL, defaulting the label to the raw id and the
// description to "Custom Sonnet model" — so an unnamed pin shows up as
// `claude-sonnet-5[1m]  Custom Sonnet model (1M context)`. The _NAME/
// _DESCRIPTION keys are Claude Code's own opt-out; these mirror its built-in
// row wording. Bump alongside POOL_SONNET_MODEL.
export const POOL_SONNET_MODEL_NAME = 'Sonnet';
export const POOL_SONNET_MODEL_DESCRIPTION = 'Sonnet 5 with 1M context · Efficient for routine tasks';

// Pin Claude Code's `opus` alias to the 1M-context Opus 5, for the same reason
// as Sonnet above: the bare id is budgeted at 200K behind the gateway and
// auto-compacts there, and pinning it would *downgrade* a user who had picked
// the 1M Opus row themselves. Bump when the Opus default version changes.
export const POOL_OPUS_MODEL = 'claude-opus-5[1m]';

// As POOL_SONNET_MODEL_NAME above. Bump alongside POOL_OPUS_MODEL.
export const POOL_OPUS_MODEL_NAME = 'Opus';
export const POOL_OPUS_MODEL_DESCRIPTION = 'Opus 5 with 1M context · Best for everyday, complex tasks';

const POOL_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION'
];

// The full settings.json `env` mutation, in one place so applyPoolEnv, the
// `bro pool` launch env and `--dry-run`'s report can't drift apart.
export function poolEnvBlock({ baseUrl, token }) {
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_DEFAULT_SONNET_MODEL: POOL_SONNET_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: POOL_SONNET_MODEL_NAME,
    ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION: POOL_SONNET_MODEL_DESCRIPTION,
    ANTHROPIC_DEFAULT_OPUS_MODEL: POOL_OPUS_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: POOL_OPUS_MODEL_NAME,
    ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION: POOL_OPUS_MODEL_DESCRIPTION
  };
}

// The snapshot file for one Claude profile. Profiles must not share one: with a
// single fixed path, `bro pool up` under ~/.claude-personal and a later
// `bro pool down` under ~/.claude took each other's snapshot — down cleaned the
// wrong settings.json and left the other profile pinned to a dead pool with no
// state left for bro to find it by. The default profile keeps the original
// filename so state written by an earlier bro still round-trips.
function stateFileFor(claudeDir) {
  const broDir = path.join(os.homedir(), '.bro');
  const resolved = path.resolve(claudeDir);
  if (resolved === path.resolve(path.join(os.homedir(), '.claude'))) {
    return path.join(broDir, 'pool-settings.json');
  }
  // Readable stem for eyeballing ~/.bro, hash for collision-free + bounded.
  // Profile dirs are dot-prefixed, so drop leading dots or the name reads
  // `pool-settings..claude-personal.<hash>.json`.
  const stem = path.basename(resolved).replace(/^\.+/, '').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 40);
  const hash = createHash('sha256').update(resolved).digest('hex').slice(0, 8);
  return path.join(broDir, `pool-settings.${stem}.${hash}.json`);
}

// Where Claude Code actually reads settings from (honor CLAUDE_CONFIG_DIR, which
// Claude Code exports to its own subprocesses), plus bro's pre-pool snapshot for
// that same profile. Both move together so up/down always target one profile.
export function defaultPaths() {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return {
    settings: path.join(claudeDir, 'settings.json'),
    state: stateFileFor(claudeDir)
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

  settings.env = { ...env, ...poolEnvBlock({ baseUrl, token }) };
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
