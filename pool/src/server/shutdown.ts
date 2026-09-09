/**
 * Graceful shutdown for the pool server. `bro pool down`/`restart` send
 * SIGTERM; instead of dying mid-stream we stop accepting new connections and
 * let in-flight requests (including long SSE generations) run to completion,
 * force-closing only after a generous drain timeout.
 */

import type { Server } from "bun";

/** Long by design: a slow restart beats killing a generation mid-stream. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Stop listening and wait for in-flight requests to finish, up to
 * `drainTimeoutMs`. Note Bun cannot upgrade a graceful stop() to a forced
 * stop(true) — the forced promise never resolves — so on "timeout" the caller
 * must close stragglers itself (our signal handler does so via process.exit).
 */
export async function drainAndStop(
  server: Server<unknown>,
  drainTimeoutMs: number,
): Promise<"drained" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), drainTimeoutMs);
  });
  // stop(false) refuses new connections and resolves once existing ones drain.
  const drained = server.stop(false).then(() => "drained" as const);
  const outcome = await Promise.race([drained, timedOut]);
  clearTimeout(timer);
  return outcome;
}

/**
 * Keep one request's stray promise rejection from killing the daemon.
 *
 * Bun treats an unhandled rejection as fatal. In a pool serving many Claude
 * Code sessions that trades one dropped request for every live session at
 * once: the process dies mid-stream and each client then retries against a
 * port with nothing listening (ConnectionRefused). Log it loudly — the prefix
 * is greppable in ~/.bro/pool-proxy.log — and keep serving.
 */
export function installRejectionGuard(): void {
  process.on("unhandledRejection", (reason: unknown) => {
    const detail =
      reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
    console.error(`pool: unhandled rejection (request dropped, server still up): ${detail}`);
  });
}

/**
 * Install SIGTERM/SIGINT handlers that drain the server before exiting.
 * A second signal skips the drain and force-stops immediately.
 */
export function installGracefulShutdown(
  server: Server<unknown>,
  drainTimeoutMs: number = DEFAULT_DRAIN_TIMEOUT_MS,
): void {
  let draining = false;
  const onSignal = (signal: string) => {
    if (draining) {
      console.error(`pool: second ${signal}, force-closing in-flight requests`);
      void server.stop(true).then(() => process.exit(0));
      return;
    }
    draining = true;
    const pending = server.pendingRequests;
    console.error(
      `pool: ${signal} received, draining ${pending} in-flight request${pending === 1 ? "" : "s"} ` +
        `(up to ${Math.round(drainTimeoutMs / 60_000)}m; signal again to force)`,
    );
    void drainAndStop(server, drainTimeoutMs).then(() => process.exit(0));
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));
}
