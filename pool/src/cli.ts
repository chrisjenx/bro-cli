/**
 * `accounts` sub-commands for managing the pool from the terminal.
 *
 *   accounts list                 List accounts and their status.
 *   accounts login <name>         Create the account (if needed) and open an
 *                                 interactive Claude login in its own config dir.
 *   accounts import <name>        Copy the machine's current Claude login into a
 *                                 new pool account.
 *   accounts add <name>           Create an empty account dir (login separately).
 *   accounts remove <name>        Delete an account and its credentials.
 */

import { homedir } from "os";
import { join } from "path";
import { readFileSync } from "fs";
import type { Config } from "./config.ts";
import { AccountManager, isValidPriority } from "./accounts/manager.ts";
import { loginOpenAI } from "./accounts/openai-login.ts";
import { normalizeCodexAuthJson } from "./accounts/openai-oauth.ts";
import {
  applyContextEdits,
  declaredCeiling,
  effectiveContextWindow,
  loadModelConfig,
  saveModelConfig,
  updateOpenAIModels,
} from "./models.ts";

function fmtWhen(ts: number | null): string {
  if (!ts) return "never";
  return new Date(ts).toLocaleString();
}

/** Pulls `--provider <name>` out of args, defaulting to "anthropic". */
function extractProvider(args: string[]): { provider: string; positional: string[] } {
  const idx = args.indexOf("--provider");
  const provider = idx === -1 ? "anthropic" : (args[idx + 1] ?? "anthropic");
  const positional = args.filter((a, i) => a !== "--provider" && args[i - 1] !== "--provider");
  return { provider, positional };
}

/** The only two providers the pool knows how to log in / import. */
export function isValidProvider(provider: string): provider is "anthropic" | "openai" {
  return provider === "anthropic" || provider === "openai";
}

/**
 * Parse the priority argument for `accounts tier`. Returns null for anything
 * that isn't a bare non-negative integer string. The `/^\d+$/` guard rejects
 * empty/whitespace input (which `Number("")` would otherwise coerce to 0),
 * negatives, and decimals before the shared value check.
 */
export function parsePriorityArg(raw: string | undefined): number | null {
  if (raw == null || !/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw);
  return isValidPriority(n) ? n : null;
}

/** Parse the token count for `models context`. Bare non-negative integers only,
 * mirroring parsePriorityArg — `Number("")` would otherwise coerce to 0. */
export function parseContextArg(raw: string | undefined): number | null {
  if (raw == null || !/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}

const CONTEXT_USAGE = "models context <model-id> <tokens|default>";
/** Spelled the way the usage string and README document it — no undocumented
 * aliases, so what the CLI accepts and what it advertises stay the same set. */
const CLEAR_WORDS = new Set(["default", "clear"]);

/**
 * Send a context edit to a running pool, or report that there isn't one.
 *
 * Returns an exit code when a pool answered — including when it REFUSED. A
 * refusal is authoritative and must not fall through to the file path, or the
 * CLI would quietly apply an edit the pool just rejected and the two surfaces
 * would disagree all over again.
 */
async function postContextEdit(config: Config, body: unknown): Promise<0 | 1 | "unreachable"> {
  let res: Response;
  try {
    res = await fetch(`http://${config.host}:${config.port}/api/context`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    return "unreachable";
  }
  if (res.ok) return 0;
  // A pool from before this route existed answers 404/405. That says nothing
  // about the edit, so treat it as "no pool" and let the file path handle it —
  // reporting a routing failure would strand anyone with a long-running pool
  // started from an older build.
  if (res.status === 404 || res.status === 405) return "unreachable";
  const detail = await res
    .json()
    .then((b: any) => b?.error?.message)
    .catch(() => null);
  console.error(detail ?? `pool rejected the edit (HTTP ${res.status})`);
  return 1;
}

function unknownProviderErr(provider: string): number {
  console.error(`Unknown provider "${provider}". Use --provider openai (or omit for the default Claude/anthropic login).`);
  return 1;
}

export async function runAccountsCommand(config: Config, rawArgs: string[]): Promise<number> {
  const mgr = new AccountManager(config);
  const { provider, positional } = extractProvider(rawArgs);
  const [sub, name] = positional;

  switch (sub) {
    case undefined:
    case "list": {
      const accounts = mgr.listAccounts();
      if (accounts.length === 0) {
        console.log(`No accounts yet.

Each account is a separate Claude Max / Team login the proxy can pool.

  1. Install the Claude CLI (if needed):
       npm install -g @anthropic-ai/claude-code

  2. Log in your first plan (run /login, then /exit inside the CLI):
       bun run src/index.ts accounts login work

     …or import the login already on this machine:
       bun run src/index.ts accounts import primary

  3. Repeat for each plan, then start the server:
       bun start

Pool dir: ${config.accountsDir}`);
        return 0;
      }
      console.log(`Pool dir: ${config.accountsDir}\n`);
      for (const a of accounts) {
        const state = a.available ? "READY" : a.authenticated ? "SIDELINED" : "LOGGED OUT";
        console.log(`● ${a.name}  [${a.provider}] [${state}]  priority ${a.priority} · weight ${a.weight} · ${a.activeSessions} session${a.activeSessions === 1 ? "" : "s"}`);
        console.log(`    plan:      ${a.subscriptionType ?? "unknown"}   tier: ${a.rateLimitTier ?? "-"}`);
        console.log(
          `    token:     ${a.tokenExpired ? "expired (auto-refreshes on use)" : "valid until " + fmtWhen(a.tokenExpiresAt)}`,
        );
        console.log(
          `    usage:     ${a.usage.windowRequests} req / ${a.usage.windowInputTokens + a.usage.windowOutputTokens} tok this window · ${a.usage.totalRequests} req all-time`,
        );
        if (a.unavailableReason) console.log(`    note:      ${a.unavailableReason}`);
        if (a.usage.lastError) console.log(`    last err:  ${a.usage.lastError}`);
        console.log("");
      }
      return 0;
    }

    case "add": {
      if (!name) return usageErr("accounts add <name>");
      mgr.create(name);
      console.log(`Created account "${name}" at ${mgr.configDirFor(name)}`);
      console.log(`Now log in:  bun run src/index.ts accounts login ${name}`);
      return 0;
    }

    case "login": {
      if (!name) return usageErr("accounts login <name>");
      if (!isValidProvider(provider)) return unknownProviderErr(provider);
      if (!mgr.listNames().includes(name)) mgr.create(name);

      if (provider === "openai") {
        console.log(`Logging in to ChatGPT (subscription OAuth) for "${name}".`);
        const ok = await loginOpenAI(mgr, name);
        if (ok) {
          const acct = mgr.getAccount(name);
          console.log(`\n✓ "${name}" is authenticated (${acct.subscriptionType ?? "plan unknown"}).`);
          return 0;
        }
        console.log(`\n⚠ Login for "${name}" did not complete. Try again.`);
        return 1;
      }

      const dir = mgr.configDirFor(name);
      console.log(`Opening interactive Claude login for "${name}".`);
      console.log(`Config dir: ${dir}`);
      console.log(`When Claude starts, run /login (or complete onboarding), then /exit.\n`);

      // Snapshot the Keychain first: adoption must require the item to change,
      // or an aborted login lets a stale Keychain token overwrite the rotated
      // one the pool cached to disk (see adoptKeychainLogin).
      const keychainBefore = mgr.keychainRefreshToken(name);

      const proc = Bun.spawn([config.claudeBin], {
        cwd: process.cwd(),
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([k]) => k !== "CLAUDECODE"),
          ),
          CLAUDE_CONFIG_DIR: dir,
        },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      await proc.exited;

      // macOS writes the new login to the Keychain, which the pool reads second
      // (see adoptKeychainLogin) — reconcile before reporting success.
      if (mgr.adoptKeychainLogin(name, keychainBefore)) {
        console.log(`Picked up the new login from the macOS Keychain for "${name}".`);
      }

      const acct = mgr.getAccount(name);
      if (acct.authenticated) {
        console.log(`\n✓ "${name}" is authenticated (${acct.subscriptionType ?? "plan unknown"}, tier ${acct.rateLimitTier ?? "-"}).`);
        return 0;
      }
      console.log(`\n⚠ "${name}" still has no stored credentials. Re-run login and complete /login.`);
      return 1;
    }

    case "import": {
      if (!name) return usageErr("accounts import <name>");
      if (!isValidProvider(provider)) return unknownProviderErr(provider);

      if (provider === "openai") {
        const src = join(homedir(), ".codex", "auth.json");
        let raw: unknown;
        try {
          raw = JSON.parse(readFileSync(src, "utf8"));
        } catch {
          console.error(`No Codex login found at ${src}. Log in with \`codex login\` first.`);
          return 1;
        }
        const creds = normalizeCodexAuthJson(raw);
        if (!creds) {
          console.error(`${src} did not contain usable credentials. Log in with \`codex login\` first.`);
          return 1;
        }
        if (!mgr.listNames().includes(name)) mgr.create(name);
        mgr.updateOpenAICreds(name, creds);
        const acct = mgr.getAccount(name);
        console.log(`✓ Imported ChatGPT login into "${name}" (${acct.subscriptionType ?? "plan unknown"}).`);
        return 0;
      }

      mgr.importCurrent(name);
      const acct = mgr.getAccount(name);
      console.log(
        acct.authenticated
          ? `✓ Imported current login into "${name}" (${acct.subscriptionType ?? "plan unknown"}).`
          : `Imported into "${name}", but no valid credentials were found.`,
      );
      return acct.authenticated ? 0 : 1;
    }

    case "remove":
    case "rm": {
      if (!name) return usageErr("accounts remove <name>");
      mgr.remove(name);
      console.log(`Removed account "${name}".`);
      return 0;
    }

    case "tier": {
      if (!name) return usageErr("accounts tier <name> [priority]");
      if (!mgr.listNames().includes(name)) {
        console.error(`Account "${name}" does not exist.`);
        return 1;
      }
      const rawPriority = positional[2];
      if (rawPriority === undefined) {
        console.log(`${name}: priority ${mgr.priorityFor(name)}`);
        return 0;
      }
      const priority = parsePriorityArg(rawPriority);
      if (priority === null) {
        console.error(`Priority must be a non-negative integer, got "${rawPriority}".`);
        return 1;
      }
      mgr.setPriority(name, priority);
      console.log(`Set "${name}" priority to ${priority}.`);
      return 0;
    }

    default:
      console.error(`Unknown accounts sub-command: ${sub}`);
      return usageErr("accounts <list|login|import|add|remove|tier> [name]");
  }
}

function usageErr(usage: string): number {
  console.error(`Usage: bun run src/index.ts ${usage}`);
  return 1;
}

/**
 * `models` sub-commands.
 *
 *   models list                    Show the current model-id → provider routing
 *                                   table, each row's effective context window,
 *                                   and the house cap it's clamped against.
 *   models update                  Refresh the openai entries from an authenticated
 *                                   ChatGPT-subscription account (best-effort; see models.ts).
 *   models context <id> <tokens>   Set a per-model context-window ceiling
 *                                   (maxContextWindow) in models.json — the same
 *                                   field the dashboard editor writes.
 */
export async function runModelsCommand(config: Config, args: string[]): Promise<number> {
  const [sub] = args;
  const cfg = loadModelConfig(config.modelsFile);
  const table = cfg.models;

  if (sub === undefined || sub === "list") {
    for (const m of table) {
      const win = effectiveContextWindow(m, config.contextWindowCap);
      const ceiling = declaredCeiling(m);
      const note = ceiling !== null && ceiling > win ? ` (capped from ${ceiling.toLocaleString("en-US")})` : "";
      console.log(
        `${m.id.padEnd(24)} → ${m.provider}:${m.upstreamModel.padEnd(16)} ` +
        `${win.toLocaleString("en-US").padStart(11)} ctx${note}`,
      );
    }
    console.log(`\nHouse cap: ${config.contextWindowCap.toLocaleString("en-US")} (POOL_MAX_CONTEXT)`);
    return 0;
  }

  if (sub === "update") {
    const mgr = new AccountManager(config);
    const updated = await updateOpenAIModels(mgr, table);
    saveModelConfig(config.modelsFile, { ...cfg, models: updated });
    console.log(`Saved ${updated.length} models to ${config.modelsFile}`);
    return 0;
  }

  if (sub === "context") {
    const [, id, raw] = args;
    if (!id || raw === undefined) return usageErr(CONTEXT_USAGE);
    // "default" is the CLI spelling of the dashboard's null: clear the override
    // and fall back to the bundled ceiling. Without it the two surfaces could
    // not express the same edit.
    let ceiling: number | null = null;
    if (!CLEAR_WORDS.has(raw)) {
      ceiling = parseContextArg(raw);
      if (ceiling === null) return usageErr(CONTEXT_USAGE);
    }
    const edit = { models: [{ id, maxContextWindow: ceiling }] };
    const applied = ceiling === null ? "cleared to the bundled default" : `set to ${ceiling.toLocaleString("en-US")}`;

    // A running pool owns the live table. Going through it means the edit
    // hot-applies and survives — writing the file behind its back left the pool
    // serving its boot-time table, and the next dashboard Save wrote that stale
    // table back over this edit.
    const viaPool = await postContextEdit(config, edit);
    if (viaPool !== "unreachable") {
      if (viaPool === 0) console.log(`${id}: context ceiling ${applied} (applied to the running pool)`);
      return viaPool;
    }

    // No pool listening: same validated core, same rules, written straight to
    // the file for the next start to pick up.
    const result = applyContextEdits(cfg, edit, config.autoCompactWindowOverride);
    if (!result.ok) {
      console.error(result.message);
      return 1;
    }
    saveModelConfig(config.modelsFile, result.config);
    console.log(`${id}: context ceiling ${applied} in ${config.modelsFile}`);
    return 0;
  }

  console.error(`Unknown models sub-command: ${sub}`);
  return usageErr("models <list|update|context>");
}
