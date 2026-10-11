#!/usr/bin/env bash
# Driver for exercising the `bro` CLI and its nested pool server without ever
# spawning a real `claude` process. See SKILL.md in this directory for usage.
#
# Run from the repo root: .claude/skills/run-bro-cli/driver.sh <command> [args...]
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
POOL_DIR="${ROOT_DIR}/pool"

# require_arg <value> <usage-hint> — usage error instead of a cryptic
# "unbound variable" abort when a required positional arg is missing.
require_arg() {
  if [ -z "${1:-}" ]; then
    echo "Missing argument. Usage: driver.sh $2" >&2
    exit 1
  fi
}

cmd_help() {
  cat <<'EOF'
Usage: driver.sh <command> [args...]

Direct invocation (never spawns claude):
  help                         Show this driver usage
  bro-help                     Show bro's own --help text
  dry-run [claude-args...]     Show what the pool launch would run, without
                                starting anything (bro --dry-run ...)
  pool-status                  Query the pool server + backend-override state
  models-list                  List the pool's model routing table

Standalone pool server (isolated port/dir — never touches a live pool):
  pool-serve-start [port]      Start `bun run src/index.ts serve` in the
                                background on an isolated CLAUDE_POOL_DIR
                                and PORT (default 3999). State is per-port.
  pool-serve-stop [port]       Kill that port's server, remove its sandbox
                                dir, log, and pid file (default 3999)
  pool-curl <path> [port]      curl the isolated pool server (e.g. /health)
EOF
}

cmd_help_bro() { node "$ROOT_DIR/bin/bro.js" --help; }
cmd_dry_run() { node "$ROOT_DIR/bin/bro.js" --dry-run "$@"; }
cmd_pool_status() { node "$ROOT_DIR/bin/bro.js" pool status; }
cmd_models_list() { node "$ROOT_DIR/bin/bro.js" models list; }

# All pool-server state is keyed by port so concurrent isolated servers on
# different ports never clobber each other's pid/sandbox/log.
pool_pidfile() { echo "/tmp/bro-driver-pool-$1.pid"; }
pool_dirfile() { echo "/tmp/bro-driver-pool-$1.dir"; }
pool_logfile() { echo "/tmp/bro-driver-pool-$1.log"; }

cmd_pool_serve_start() {
  local port="${1:-3999}"
  local sandbox_dir
  sandbox_dir="$(mktemp -d)"
  echo "$sandbox_dir" >"$(pool_dirfile "$port")"
  # IMPORTANT: `( cd dir && cmd & )` under `set -e` spawns an extra supervisor
  # subshell whose PID `$!` captures — not the real server's PID — because
  # errexit blocks bash's tail-exec optimization for the last command in a
  # backgrounded `&&` list. Backgrounding the whole `(... && exec cmd)` unit
  # (not a compound list inside it) keeps $! pointing at the actual process.
  ( cd "$POOL_DIR" && \
    exec env CLAUDE_POOL_DIR="$sandbox_dir" PORT="$port" \
    nohup bun run src/index.ts serve >"$(pool_logfile "$port")" 2>&1 ) &
  echo $! >"$(pool_pidfile "$port")"
  local n=0
  while ! curl -sS -o /dev/null "http://127.0.0.1:$port/health" 2>/dev/null; do
    n=$((n + 1))
    if [ "$n" -ge 25 ]; then
      echo "pool server did not come up on :$port — see $(pool_logfile "$port")" >&2
      # Don't leave a stale pid pointing at a dead (or recycled) process.
      rm -f "$(pool_pidfile "$port")" "$(pool_dirfile "$port")"
      rm -rf "$sandbox_dir"
      return 1
    fi
    sleep 0.2
  done
  echo "pool server up on :$port  (sandbox dir: $sandbox_dir, pid file: $(pool_pidfile "$port"))"
}
cmd_pool_serve_stop() {
  local port="${1:-3999}"
  if [ -f "$(pool_pidfile "$port")" ]; then
    kill "$(cat "$(pool_pidfile "$port")")" 2>/dev/null || true
    rm -f "$(pool_pidfile "$port")"
  fi
  if [ -f "$(pool_dirfile "$port")" ]; then
    rm -rf "$(cat "$(pool_dirfile "$port")")"
    rm -f "$(pool_dirfile "$port")"
  fi
  rm -f "$(pool_logfile "$port")"
}
cmd_pool_curl() {
  local path="$1" port="${2:-3999}"
  curl -sS "http://127.0.0.1:$port$path"
}

case "${1:-help}" in
  help) cmd_help ;;
  bro-help) cmd_help_bro ;;
  dry-run) shift; cmd_dry_run "$@" ;;
  pool-status) cmd_pool_status ;;
  models-list) cmd_models_list ;;
  pool-serve-start) cmd_pool_serve_start "${2:-3999}" ;;
  pool-serve-stop) cmd_pool_serve_stop "${2:-3999}" ;;
  pool-curl)
    require_arg "${2:-}" "pool-curl <path> [port]"
    cmd_pool_curl "$2" "${3:-3999}" ;;
  *) echo "Unknown command: ${1:-}" >&2; cmd_help; exit 1 ;;
esac
