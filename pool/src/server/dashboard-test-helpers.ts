import { emptyUsage, type Account, type AccountUsage } from "../accounts/types.ts";
import type { RoutingSnapshot } from "../accounts/manager.ts";
import type { DashboardStatus } from "./dashboard-types.ts";

export const FIXTURE_NOW = 1_800_000_000_000;
export function accountFixture(name: string, patch: Partial<Account> = {}, usage: Partial<AccountUsage> = {}): Account {
  return {
    name, configDir: `/fixture/${name}`, provider: "anthropic", authenticated: true,
    subscriptionType: "max", rateLimitTier: null, scopes: [], priority: 100, weight: 1,
    activeSessions: 0, inFlight: 0, tokenExpiresAt: FIXTURE_NOW + 3_600_000,
    tokenExpired: false, usage: { ...emptyUsage(FIXTURE_NOW), ...usage },
    available: true, unavailableReason: null, billingBlocked: false, ...patch,
  };
}
export function candidateFixture(account: string, patch: Partial<NonNullable<RoutingSnapshot["candidates"]>[number]> = {}) {
  return { account, expiryShare: 1, activeSessions: 0, inFlight: 0, fiveHourFactor: 1,
    viable: true, weight: 1, urgency: 1, loadFactor: 1, headroom: 1, score: 1, ...patch };
}
export function statusFixture(accounts: Account[] = [accountFixture("primary")], patch: Partial<DashboardStatus> = {}): DashboardStatus {
  return {
    accounts, routing: { activeTier: null, nextPick: null, tiers: [], candidates: [], busy: [] },
    routingContext: { provider: "anthropic", model: null, modelFamily: null, providers: ["anthropic", "openai"] },
    tuning: { fiveHourExp: 1, headroomTaperStart: 0.2, minHeadroom: 0.1 },
    mapping: { enabled: false, mappings: [], targets: [] },
    usageWindowMs: 18_000_000, now: FIXTURE_NOW, ...patch,
  };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
