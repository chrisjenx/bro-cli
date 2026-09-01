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

// Model-pin keys. Written only when derived from the live catalog at apply time
// (sonnetPinFromCatalog — see there for why Sonnet is pinned and Fable is not);
// otherwise they revert to the user's pre-pool value, which also scrubs pins an
// earlier bro hard-coded. `bro pool down` restores whatever the user had.
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
export function poolEnvBlock({ baseUrl, token, pins = {} }) {
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: token,
    ...pins
  };
}

// Claude Code's Fable picker row is not built in: it is `additionalModelOptionsCache`
// in the profile's .claude.json, written by a startup "bootstrap" call that only
// runs when the profile has a live claude.ai login. Behind the pool (token auth)
// it never refreshes, so the row goes stale and the picker offers an old Fable
// beside the current one. Pinning ANTHROPIC_DEFAULT_FABLE_MODEL doesn't replace
// that row — it adds a second one. So bro refreshes the cached row itself from
// the pool's live GET /v1/models (Anthropic's catalog): newest claude-fable-* id,
// only the version-bearing parts changed, everything else in the entry kept.
export function newestOfFamily(models, family) {
  const re = new RegExp(`^claude-${family}-\\d`);
  const hits = (Array.isArray(models) ? models : [])
    .filter((m) => m && typeof m.id === 'string' && re.test(m.id))
    .sort((a, b) => (b.created || 0) - (a.created || 0) || b.id.localeCompare(a.id, undefined, { numeric: true }));
  const newest = hits[0];
  if (!newest) return null;
  return { id: newest.id, name: (newest.display_name || newest.id).replace(/^Claude\s+/, '') };
}

export function newestFable(models) {
  return newestOfFamily(models, 'fable');
}

// Sonnet's picker row IS built in, and behind the pool (token auth) Claude Code
// shows it twice: "Sonnet" (200K-budgeted) and "Sonnet 5 (1M context)". Unlike
// Fable, pinning ANTHROPIC_DEFAULT_SONNET_MODEL replaces the built-in row, so a
// pin collapses the pair into one 1M row. Derived from the live catalog (newest
// claude-sonnet-*), wording copied from Claude Code's own row, so no release is
// needed for the next Sonnet. {} when the catalog has no Sonnet: nothing pinned.
export function sonnetPinFromCatalog(models) {
  const sonnet = newestOfFamily(models, 'sonnet');
  if (!sonnet) return {};
  return {
    ANTHROPIC_DEFAULT_SONNET_MODEL: `${sonnet.id}[1m]`,
    ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'Sonnet',
    ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION: `${sonnet.name} with 1M context · Efficient for routine tasks`
  };
}

// Rewrites the cached Fable row in `claudeJson` (parsed .claude.json) to `fable`
// ({ id, name } from newestFable). Returns true when something changed. Only
// touches an existing claude-fable-* entry: with no cached row there is nothing
// stale to fix, and inventing one is Claude Code's job.
export function refreshCachedFableRow(claudeJson, fable) {
  const rows = claudeJson?.additionalModelOptionsCache;
  if (!fable || !Array.isArray(rows)) return false;
  let changed = false;
  for (const row of rows) {
    if (!row || typeof row.value !== 'string' || !/^claude-fable-\d/.test(row.value)) continue;
    const m = /^(claude-fable-[\w.-]*?)(\[1m\])?$/.exec(row.value);
    if (!m || m[1] === fable.id) continue;
    const oldName = oldFableName(row) ?? m[1];
    row.value = `${fable.id}${m[2] || ''}`;
    if (typeof row.description === 'string' && oldName && row.description.startsWith(oldName)) {
      row.description = fable.name + row.description.slice(oldName.length);
    }
    changed = true;
  }
  return changed;
}

// "Fable 5 · Most capable…" → "Fable 5"; the description's leading version token.
function oldFableName(row) {
  const m = typeof row.description === 'string' ? /^(Fable[^·]*?)\s*·/.exec(row.description) : null;
  return m ? m[1] : null;
}

// Path of the .claude.json Claude Code reads for the active profile.
export function claudeJsonPath() {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

// Apply refreshCachedFableRow to the file on disk, atomically. Returns true when
// it rewrote the file. Never throws: a missing or unparseable file is left alone.
export function refreshCachedFableRowFile(models, file = claudeJsonPath()) {
  const json = readJson(file);
  if (!json || !refreshCachedFableRow(json, newestFable(models))) return false;
  const tmp = `${file}.bro-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(json, null, 2));
  fs.renameSync(tmp, file);
  return true;
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
  for (const k of RETIRED_POOL_ENV_KEYS) if (isBroPinValue(k, env[k])) delete env[k];
  return env;
}

// A value bro wrote for a retired key: one of the historical literals, or the
// shape fablePinFromCatalog produces for any model version.
function isBroPinValue(k, value) {
  if (LEGACY_PIN_VALUES.has(value)) return true;
  if (typeof value !== 'string') return false;
  if (k === 'ANTHROPIC_DEFAULT_FABLE_MODEL') return /^claude-fable-\d[\w.-]*\[1m\]$/.test(value);
  if (k === 'ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION') return value.endsWith(' · Most capable for your hardest and longest-running tasks');
  if (k === 'ANTHROPIC_DEFAULT_SONNET_MODEL') return /^claude-sonnet-\d[\w.-]*\[1m\]$/.test(value);
  if (k === 'ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION') return value.endsWith(' with 1M context · Efficient for routine tasks');
  return false;
}

function snapshotValue(env, k) {
  if (!(k in env) || isBroPinValue(k, env[k])) return null;
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
export function applyPoolEnv({ baseUrl, token, pins = {} }, paths = defaultPaths()) {
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
  settings.env = { ...env, ...poolEnvBlock({ baseUrl, token, pins }) };
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
