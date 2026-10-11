import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BRO_DIR = path.join(os.homedir(), '.bro');
export const CONFIG_PATH = path.join(BRO_DIR, 'config.json');

// Optional user config. Missing or unreadable means defaults.
export function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) ?? {};
  } catch {
    return {};
  }
}

// Resolve the Claude Code permission posture from config:
//   'auto'   — Claude's intelligent auto-mode (--permission-mode auto)  [default]
//   'manual' — prompt for everything (Claude's normal mode)
//   'bypass' — skip every permission check (--dangerously-skip-permissions)
// `permissionMode` is the source of truth; the legacy `dangerouslySkipPermissions`
// boolean is honored only when `permissionMode` is unset, so existing configs keep
// working after upgrading.
export function configPermissionMode(config = {}) {
  const m = config.permissionMode;
  if (m === 'auto' || m === 'manual' || m === 'bypass') return m;
  if (config.dangerouslySkipPermissions === true) return 'bypass';
  if (config.dangerouslySkipPermissions === false) return 'manual';
  return 'auto';
}

// Map a permission posture ('auto' | 'manual' | 'bypass') to the claude CLI flags
// that put it in that mode at startup.
export function permissionArgs(mode) {
  if (mode === 'bypass') return ['--dangerously-skip-permissions'];
  if (mode === 'manual') return [];
  return ['--permission-mode', 'auto'];
}
