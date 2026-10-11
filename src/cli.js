import { readFileSync } from 'node:fs';
import { loadConfig, configPermissionMode, CONFIG_PATH } from './config.js';
import { runPool, runPoolAccounts, runPoolModels, runPoolCommand } from './pool.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `bro — pool many Claude / ChatGPT subscriptions behind one endpoint and
run Claude Code across them.

Usage:
  bro                    Start the pool (if needed) and launch Claude Code
                         through it
  bro accounts list      List pool accounts
  bro accounts login <name>
                         Add/log in a Claude account for the pool
  bro accounts login <name> --provider openai
                         Add/log in a ChatGPT subscription account instead
  bro accounts import <name>
                         Copy this machine's current Claude login into the pool
  bro models list        List pool model routing entries
  bro models update      Discover new Codex ids from pooled accounts
  bro pool up            Make the account pool the backend for ALL Claude
                         Code sessions (agents included). Alias: bro pool start
  bro pool down          Stop the pool (drains in-flight requests first) and
                         restore your normal Claude login. Alias: bro pool stop
  bro pool restart       Restart the pool server, draining in-flight requests
  bro pool status        Show pool server + backend-override status
  bro --dry-run          Show what would run; launch nothing
  bro --safe             Start Claude in manual mode (prompt for everything)
                         instead of the default auto mode
  bro -h, --help         Show this help
  bro -v, --version      Show version
  bro --resume <id>      Launch through the pool, passing args to claude
  bro -- <args...>       Force everything after -- straight to claude

Put bro flags first. The first unrecognized arg, and everything after it,
is passed verbatim to claude.

Config:  ${CONFIG_PATH}`;

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--') { a._.push(...argv.slice(i + 1)); break; }
    // `-p pool` was how the pool was picked when bro had other providers; keep
    // accepting it so existing muscle memory and scripts still work.
    if ((t === '--provider' || t === '-p') && argv[i + 1] === 'pool') i++;
    else if (t === '--dry-run') a.dryRun = true;
    else if (t === '--safe') a.safe = true;
    else if (t === '--help' || t === '-h') a.help = true;
    else if (t === '--version' || t === '-v') a.version = true;
    else {
      // Unknown args belong to Claude. Once Claude args begin, preserve the
      // rest verbatim so values like `bro --resume pool` are not re-parsed.
      a._.push(...argv.slice(i));
      break;
    }
  }
  return a;
}

export async function main(argv) {
  if (argv[0] === 'accounts') {
    return runPoolAccounts(argv.slice(1));
  }

  if (argv[0] === 'models') {
    return runPoolModels(argv.slice(1));
  }

  if (argv[0] === 'pool') {
    return runPoolCommand(argv.slice(1));
  }

  const args = parseArgs(argv);
  if (args.help) { console.log(HELP); return 0; }
  if (args.version) { console.log(pkg.version); return 0; }

  // Claude starts in auto mode by default; --safe forces manual.
  const permissionMode = args.safe ? 'manual' : configPermissionMode(loadConfig());
  const result = await runPool({
    extraArgs: args._,
    permissionMode,
    dryRun: args.dryRun
  });
  if (args.dryRun) { console.log(JSON.stringify(result, null, 2)); return 0; }
  return typeof result === 'number' ? result : 0;
}
