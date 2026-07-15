/**
 * Codex reports two rolling windows (primary, secondary) whose real duration is
 * given by a `*-window-minutes` header / `limit_window_seconds` field, NOT by
 * their slot. Map a window's duration (ms) to the pool's canonical account-wide
 * key so the dashboard's fixed 5h/7d slots and routing keep working: a
 * session-scale window (< 24h) → "5h", a weekly-scale window → "7d". When the
 * duration is unknown, fall back to the slot's historical default so partial
 * data never regresses (primary → "5h", secondary → "7d"). Note: with no
 * duration header, a weekly window sitting in the primary slot still reads "5h" —
 * unavoidable from that data alone; the usage poller (which reports the real
 * duration) corrects it.
 */
export function durationToWindowKey(ms: number | null, slot: "primary" | "secondary"): "5h" | "7d" {
  if (ms == null || !Number.isFinite(ms)) return slot === "primary" ? "5h" : "7d";
  const DAY = 24 * 60 * 60 * 1000;
  return ms < DAY ? "5h" : "7d";
}
