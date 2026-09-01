// Point Claude Code's settings.json `env` block at the account pool so *every*
// Claude Code session (foreground, new windows, background agents) routes through
// it. Reversible: applyPoolEnv snapshots whatever was there before, clearPoolEnv
// restores it exactly. All fs paths are injectable so the logic is unit-testable.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Keys bro writes today: just enough to point Claude Code at the pool.
const ACTIVE_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'];

// Keys an earlier bro wrote and this one no longer does: Claude Code owns its
// own model picker (behind the gateway it already renders the current Opus/
// Sonnet/Fable/Haiku rows, 1M variants included). Still managed so `bro pool up`
// scrubs old pins and `bro pool down` restores whatever the user had before.
export const RETIRED_POOL_ENV_KEYS = [
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME',
  'ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION'
];

const POOL_ENV_KEYS = [...ACTIVE_KEYS, ...RETIRED_POOL_ENV_KEYS];

// The full settings.json `env` mutation, in one place so applyPoolEnv, the
// `bro pool` launch env and `--dry-run`'s report can't drift apart.
export function poolEnvBlock({ baseUrl, token }) {
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: token
  };
}

// Every value an earlier bro ever wrote for a retired key. Closed, historical
// list — bro writes no pins any more, so it never needs a new entry. Used where
// there is no snapshot to consult (a wiped ~/.bro, or an exported shell env) to
// tell bro's leftovers from a value the user chose.
const LEGACY_PIN_VALUES = new Set([
  'claude-sonnet-5[1m]', 'claude-opus-5[1m]', 'claude-fable-5-1[1m]',
  'Sonnet', 'Opus', 'Fable',
  'Sonnet 5 with 1M context · Efficient for routine tasks',
  'Opus 5 with 1M context · Best for everyday, complex tasks',
  'Fable 5.1 · Most capable for your hardest and longest-running tasks'
]);

// Deletes retired-key values that an earlier bro wrote; user values stay.
export function scrubLegacyPins(env) {
  for (const k of RETIRED_POOL_ENV_KEYS) if (LEGACY_PIN_VALUES.has(env[k])) delete env[k];
  return env;
}

function snapshotValue(env, k) {
  if (!(k in env) || LEGACY_PIN_VALUES.has(env[k])) return null;
  return env[k];
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

function restoreKeys(env, prior, keys) {
  for (const k of keys) {
    if (prior[k] === null || prior[k] === undefined) delete env[k];
    else env[k] = prior[k];
  }
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
  let prior = {};
  if (!stateExists) {
    for (const k of POOL_ENV_KEYS) prior[k] = snapshotValue(env, k);
    writeJson(paths.state, { managed: true, prior });
  } else if (state) {
    prior = { ...(state.prior || {}) };
    let changed = false;
    for (const k of POOL_ENV_KEYS) {
      if (!(k in prior)) {
        prior[k] = snapshotValue(env, k);
        changed = true;
      }
    }
    if (changed) writeJson(paths.state, { ...state, prior });
  }

  // Retired keys revert to the user's snapshot (null → removed), so pins an
  // earlier bro wrote disappear here.
  restoreKeys(env, prior, RETIRED_POOL_ENV_KEYS);
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
  restoreKeys(env, state.prior || {}, POOL_ENV_KEYS);
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
