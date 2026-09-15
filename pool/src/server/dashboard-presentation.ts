import type { Account, AccountUsage, RateLimitWindow } from "../accounts/types.ts";
import type { DashboardStatus, OverviewFilters, OverviewSort, StatusKey, WindowView } from "./dashboard-types.ts";

/** Serialized into the page: runtime dependencies must be arguments or local helpers. */
export function createDashboardPresentation(durationMs: (key: string) => number | null, sortWindows: (windows: RateLimitWindow[]) => RateLimitWindow[]) {
  function relative(timestamp: number | null | undefined, now = Date.now(), future = false): string {
    if (timestamp == null) return "—";
    const delta = future ? timestamp - now : now - timestamp;
    if (delta <= 0) return future ? "reset passed" : "just now";
    const minutes = Math.floor(delta / 60000);
    const text = minutes < 1 ? "<1m" : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${Math.floor(minutes / 1440)}d ${Math.floor(minutes / 60) % 24}h`;
    return future ? `in ${text}` : `${text} ago`;
  }
  function projectWindow(window: RateLimitWindow | null, usage: AccountUsage, now: number): WindowView {
    const known = window?.utilization != null && Number.isFinite(window.utilization);
    let percent = known ? Math.min(100, Math.max(0, window!.utilization! * 100)) : null;
    let resetAt = window?.reset ?? null;
    let provenance: WindowView["provenance"] = known ? "reported" : "missing";
    if (resetAt != null && resetAt <= now) {
      const duration = window ? durationMs(window.key) : null;
      if (known && duration && duration > 0) {
        resetAt += (Math.floor((now - resetAt) / duration) + 1) * duration;
        percent = 0;
        provenance = "assumed-reset";
      } else resetAt = null;
    }
    return { key: window?.key ?? "", model: window?.model ?? null, percent, resetAt,
      reportedResetAt: window?.reset ?? null, provenance,
      lastCheckAt: usage.lastUsageCheckAt, checkError: usage.lastUsageCheckError };
  }
  function statusOf(account: Account, now: number): { key: StatusKey; label: string } {
    if (account.available) return { key: "ready", label: "Ready" };
    if (!account.authenticated) return { key: "logged-out", label: "Logged out" };
    if ((account.usage.rateLimitedUntil ?? 0) > now) return { key: "cooldown", label: "Cooldown" };
    return { key: "sidelined", label: "Sidelined" };
  }
  function accountRow(account: Account, now: number) {
    const windows = account.usage.rateLimitStatus?.windows ?? [];
    const slot = (key: string) => ({ ...projectWindow(windows.find(w => w.key === key && w.model == null) ?? null, account.usage, now), key });
    const fiveHour = slot("5h"), sevenDay = slot("7d");
    const resets = [fiveHour, sevenDay].filter(w => w.resetAt != null).sort((a, b) => a.resetAt! - b.resetAt!);
    const status = statusOf(account, now);
    return { account, statusKey: status.key, statusLabel: status.label,
      usageWarning: !!account.usage.lastUsageCheckError, fiveHour, sevenDay,
      nextReset: resets[0] ? { key: resets[0].key, at: resets[0].resetAt! } : null };
  }
  function overviewModel(status: DashboardStatus, filters: OverviewFilters, sort: OverviewSort, now: number) {
    const metrics = status.accounts.reduce((m, a) => ({ total: m.total + 1, available: m.available + Number(a.available),
      activeSessions: m.activeSessions + (a.activeSessions ?? 0), inFlight: m.inFlight + (a.inFlight ?? 0), unavailable: m.unavailable + Number(!a.available) }),
    { total: 0, available: 0, activeSessions: 0, inFlight: 0, unavailable: 0 });
    const rows = status.accounts.map(a => accountRow(a, now)).filter(row => {
      const a = row.account;
      return a.name.toLowerCase().includes(filters.search.trim().toLowerCase())
        && (filters.provider === "all" || a.provider === filters.provider)
        && (filters.status === "all" || (filters.status === "usage-warning" ? row.usageWarning
          : filters.status === "unavailable" ? !a.available : row.statusKey === filters.status));
    });
    const value = (row: ReturnType<typeof accountRow>): string | number | null => {
      switch (sort.key) {
        case "name": return row.account.name;
        case "status": return row.statusLabel;
        case "fiveHour": return row.fiveHour.percent;
        case "sevenDay": return row.sevenDay.percent;
        case "nextReset": return row.nextReset?.at ?? null;
        default: return row.account[sort.key] ?? null;
      }
    };
    rows.sort((a, b) => {
      const av = value(a), bv = value(b);
      if (av == null || bv == null) return av == null ? (bv == null ? a.account.name.localeCompare(b.account.name) : 1) : -1;
      const delta = typeof av === "string" ? av.localeCompare(String(bv)) : av - Number(bv);
      return delta * (sort.direction === "asc" ? 1 : -1) || a.account.name.localeCompare(b.account.name);
    });
    return { metrics, rows };
  }
  function routingModel(status: DashboardStatus) {
    const snapshot = status.routingCombined ?? status.routingPreview ?? status.routing;
    const candidatesByName = new Map((snapshot.candidates ?? []).map(c => [c.account, c]));
    const busyByName = new Map((snapshot.busy ?? []).map(b => [b.account, b]));
    const accountsByName = new Map(status.accounts.map(a => [a.name, a]));
    const winnerName = snapshot.nextPick?.account ?? null;
    const winner = winnerName ? accountsByName.get(winnerName) : undefined;
    const providers = status.routingContext?.providers ?? ["anthropic"];
    const model = status.routingContext?.model ?? null;
    function row(account: Account) {
      const candidate = candidatesByName.get(account.name) ?? null;
      const busy = busyByName.get(account.name) ?? null;
      const activeTier = snapshot.providerPicks?.find(p => p.provider === account.provider)?.activeTier;
      const reason = !providers.includes(account.provider) ? "Provider excluded by this routing context"
        : !account.available ? account.unavailableReason || "Account unavailable"
        : busy ? "At soft limit; requests may wait for a slot"
        : activeTier != null && account.priority > activeTier ? `Reserve priority tier (active ${activeTier})`
        : candidate ? "Active candidate" : "Not included in this candidate snapshot";
      return { account, candidate, busy, reason };
    }
    const candidates = (snapshot.candidates ?? []).flatMap(c => { const a = accountsByName.get(c.account); return a ? [row(a)] : []; });
    const others = status.accounts.filter(a => !candidatesByName.has(a.name)).map(row);
    return { snapshot, contextLabel: model || "Account-wide comparison",
      pickLabel: model ? `Next new session for ${model}` : "Hypothetical pick", winnerName,
      winnerPriority: winner?.priority ?? null, winnerProvider: winner?.provider ?? null, providers, candidates, others };
  }
  function accountDetailModel(status: DashboardStatus, retained: Account, now: number) {
    const current = status.accounts.find(a => a.name === retained.name);
    const account = current ?? retained;
    const windows = sortWindows(account.usage.rateLimitStatus?.windows ?? [])
      .map(w => projectWindow(w, account.usage, now));
    return { account, removed: !current, windows, routing: routingModel(status), status: statusOf(account, now) };
  }
  return { relative, projectWindow, statusOf, overviewModel, routingModel, accountDetailModel,
    number: (n: number | null | undefined) => n == null ? "—" : n.toLocaleString("en-US") };
}
export type DashboardPresentation = ReturnType<typeof createDashboardPresentation>;
