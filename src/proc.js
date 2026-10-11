import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isWin = process.platform === 'win32';

// Cross-platform `which`. On Windows it honours PATHEXT (.exe/.cmd/.bat...).
export function which(name, extraDirs = []) {
  const exts = isWin ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  const dirs = [...extraDirs, ...(process.env.PATH || '').split(path.delimiter)];
  for (const d of dirs) {
    if (!d) continue;
    for (const e of exts) {
      const p = path.join(d, name + e);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

// Where bun / npm drop globally-installed bin shims (so we can find `bun`
// even when that directory isn't on PATH — common on Windows).
export function globalBinDirs() {
  const dirs = [path.join(os.homedir(), '.bun', 'bin')];
  if (process.env.BUN_INSTALL) dirs.push(path.join(process.env.BUN_INSTALL, 'bin'));
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
  try {
    const prefix = execSync('npm config get prefix', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (prefix) dirs.push(prefix, path.join(prefix, 'bin'));
  } catch {
    /* npm not installed */
  }
  return [...new Set(dirs)];
}

function winQuote(a) {
  return /[\s"]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a;
}

// Spawn inheriting stdio. Handles Windows .cmd/.bat shims (npm), which can't be
// spawned directly. Resolves with the child's exit code.
export function runInherit(file, args, env = process.env) {
  return new Promise((resolve) => {
    const ext = path.extname(file).toLowerCase();
    let child;
    if (isWin && (ext === '.cmd' || ext === '.bat')) {
      const line = [file, ...args].map(winQuote).join(' ');
      child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], {
        stdio: 'inherit',
        env,
        windowsVerbatimArguments: true
      });
    } else {
      child = spawn(file, args, { stdio: 'inherit', env });
    }
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', (err) => {
      console.error(err.message);
      resolve(1);
    });
  });
}
