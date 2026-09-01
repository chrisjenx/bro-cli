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

// Pin Claude Code's `opus` alias to the 1M-context Opus 5, for the same reason
// as Sonnet above: the bare id is budgeted at 200K behind the gateway and
// auto-compacts there, and pinning it would *downgrade* a user who had picked
// the 1M Opus row themselves. Bump when the Opus default version changes.
export const POOL_OPUS_MODEL = 'claude-opus-5[1m]';

// As POOL_SONNET_MODEL_NAME above. Bump alongside POOL_OPUS_MODEL.
export const POOL_OPUS_MODEL_NAME = 'Opus';

// "1M" / "500K" / "272K" — matches how Claude Code's own picker writes windows.
export function formatContextWindow(n) {
  return n % 1_000_000 === 0 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}K`;
}

// The picker description for each pinned alias. Behind a gateway Claude Code
// renders these rows from the env, so when the pool caps the window the row has
// to say the real number — a row promising 1M while auto-compact fires at 272K
// is how you get a surprised user.
export function sonnetDescriptionFor(contextWindow) {
  return `Sonnet 5 with ${formatContextWindow(contextWindow ?? 1_000_000)} context · Efficient for routine tasks`;
}
export function opusDescriptionFor(contextWindow) {
  return `Opus 5 with ${formatContextWindow(contextWindow ?? 1_000_000)} context · Best for everyday, complex tasks`;
}


const POOL_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION',
  // Sized from the pool's mapping. Listed here so `bro pool down` restores or
  // removes them like the rest of the block.
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS'
];

/**
 * The full settings.json `env` mutation, in one place so applyPoolEnv, the
 * `bro pool` launch env and `--dry-run`'s report can't drift apart.
 *
 * `contextWindow` is the pool's session-safe budget (see the pool's
 * sessionContextWindow), or null when no family is Codex-mapped. When set:
 *   - CLAUDE_CODE_AUTO_COMPACT_WINDOW sizes auto-compact for the pinned
 *     `claude-*[1m]` aliases — Claude Code takes min(model window, this).
 *   - CLAUDE_CODE_MAX_CONTEXT_TOKENS sizes a raw `gpt-5.6-*` id picked from
 *     gateway discovery. Claude Code applies it only to ids that aren't a known
 *     Claude model, so it can't disturb the aliases above.
 * The [1m] pins stay either way — they're what lifts the ceiling to 1M so the
 * auto-compact value can bind; without them the ceiling is 200K.
 */
export function poolEnvBlock({ baseUrl, token, contextWindow = null }) {
  // Normalize once so the descriptions and the write guard can never disagree.
  // 0, negative, NaN, and non-numbers all mean "no window" — the same path as
  // null/undefined.
  const win = typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0
    ? contextWindow
    : null;
  const env = {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_DEFAULT_SONNET_MODEL: POOL_SONNET_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: POOL_SONNET_MODEL_NAME,
    ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION: sonnetDescriptionFor(win),
    ANTHROPIC_DEFAULT_OPUS_MODEL: POOL_OPUS_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: POOL_OPUS_MODEL_NAME,
    ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION: opusDescriptionFor(win)
  };
  if (win) {
    env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(win);
    env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(win);
  }
  return env;
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
export function applyPoolEnv({ baseUrl, token, contextWindow = null }, paths = defaultPaths()) {
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
  // Null only when the state file exists but won't parse — see the restore loop.
  let prior = null;
  if (!stateExists) {
    prior = {};
    for (const k of POOL_ENV_KEYS) prior[k] = k in env ? env[k] : null;
    writeJson(paths.state, { managed: true, prior });
  } else if (state) {
    prior = { ...(state.prior || {}) };
    let changed = false;
    for (const k of POOL_ENV_KEYS) {
      if (!(k in prior)) {
        prior[k] = k in env ? env[k] : null;
        changed = true;
      }
    }
    if (changed) writeJson(paths.state, { ...state, prior });
  }

  // Spread the block on, then UNSET every managed key the block chose not to
  // set. poolEnvBlock omits the two window keys when contextWindow is null, and
  // a spread cannot clear a value that is already there — so without this, a
  // window the pool wrote on an earlier `up` survives a later `restart` that
  // derived no window (every family mapped back to Claude, or a transient
  // /api/status failure, which fetchContextWindow reports as null). Claude Code
  // would keep compacting at a number nothing on the branch still believes in,
  // and the picker descriptions — which DO get rewritten — would contradict it.
  //
  // "Unset" is `prior`'s value, not a delete — the same rule clearPoolEnv
  // applies below, so the two functions share one semantic. A user with only
  // Claude accounts and no Codex mapping has a null window *permanently*, so an
  // unconditional delete would strip their own CLAUDE_CODE_AUTO_COMPACT_WINDOW
  // on every `up`, `restart` and launch, and keep it stripped for as long as the
  // pool is up. When prior holds a real value the key was the user's, so restore
  // it; when it holds null the key was absent before the pool, so anything
  // present can only be what the pool itself wrote — delete that.
  //
  // prior is null only when the state file exists but won't parse; delete then,
  // matching clearPoolEnv, which bails out entirely on that file and so could
  // not have restored the value either way.
  //
  // No risk of resurrecting a pool-written value: the backfill above only
  // snapshots keys absent from prior, and both window keys joined POOL_ENV_KEYS
  // in the same commit that first wrote them, so no bro version ever wrote one
  // while it was unsnapshotted.
  //
  // (Unsetting is also why poolEnvBlock must keep omitting rather than emitting
  // `undefined`: Object.assign into the launch env at pool.js would stringify an
  // undefined to the literal string "undefined".)
  const block = poolEnvBlock({ baseUrl, token, contextWindow });
  const nextEnv = { ...env, ...block };
  for (const k of POOL_ENV_KEYS) {
    if (k in block) continue;
    const was = prior ? prior[k] : null;
    if (was === null || was === undefined) delete nextEnv[k];
    else nextEnv[k] = was;
  }
  settings.env = nextEnv;
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

// The auto-compact window currently sitting in settings.json (the number Claude
// Code is actually budgeting against), or null when the key is absent or isn't
// a positive integer. Read through this module rather than re-reading the file
// ad hoc, so `bro pool status` and applyPoolEnv can't disagree about which key
// or which profile's settings.json holds it.
//
// It exists because the window only *reaches* Claude Code at `bro pool up` /
// `restart` / a `bro` launch: a dashboard mapping or context edit moves what
// the pool reports without moving this, and nothing else would tell the user.
export function readPoolContextWindow(paths = defaultPaths()) {
  return positiveInt(readJson(paths.settings)?.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
}

// The auto-compact window the *user* had set before the pool took the env over,
// as snapshotted by applyPoolEnv — or null when they had none (or the snapshot
// is missing/unreadable).
//
// applyPoolEnv restores this value whenever the pool derives no window of its
// own, which is the permanent state for a Claude-only pool. Without a way to
// recognise it, `bro pool status` would read it back as settings-vs-pool drift
// and tell the user forever to run a restart that only writes it again.
export function readPriorContextWindow(paths = defaultPaths()) {
  return positiveInt(readJson(paths.state)?.prior?.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
}

// Claude Code's env values are strings; a hand-edited settings.json may hold a
// number. Anything else — absent, null, non-numeric, non-positive — is no window.
function positiveInt(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
