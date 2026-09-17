import type { Account, Provider } from "../accounts/types.ts";
import type { RoutingSnapshot, RoutingTuning } from "../accounts/manager.ts";
import type { CodexEffort, ModelMapping, SourceEffortTier } from "../models.ts";

export interface MappingTarget { id: string; supportedEfforts: readonly CodexEffort[] }
export interface MappingState {
  enabled: boolean; mappings: ModelMapping[]; targets: MappingTarget[];
  /** Additive status metadata; targets retains its OpenAI-only HTTP contract. */
  anthropicTargets?: string[];
}
export interface DashboardStatus {
  accounts: Account[];
  routing: RoutingSnapshot;
  routingPreview?: RoutingSnapshot;
  routingCombined?: RoutingSnapshot;
  routingContext?: { provider: Provider; model: string | null; modelFamily: string | null; providers: Provider[] };
  tuning: RoutingTuning;
  mapping: MappingState;
  usageWindowMs: number;
  now: number;
}
export interface SharedDescriptors {
  families: readonly string[];
  effortTiers: readonly SourceEffortTier[];
  codexEfforts: readonly CodexEffort[];
  defaultPriority: number; defaultWeight: number; minWeight: number; maxWeight: number;
  tuningFields: Array<{ key: keyof RoutingTuning; label: string; min: number; max: number }>;
}
export type View = "overview" | "routing" | "settings";
export type StatusKey = "ready" | "cooldown" | "logged-out" | "sidelined" | "billing";
export interface OverviewFilters {
  search: string; provider: "all" | Provider;
  status: "all" | StatusKey | "unavailable" | "usage-warning";
}
export interface OverviewSort {
  key: "name" | "status" | "fiveHour" | "sevenDay" | "nextReset" | "activeSessions" | "inFlight";
  direction: "asc" | "desc";
}
export interface WindowView {
  key: string; model: string | null; percent: number | null;
  resetAt: number | null; reportedResetAt: number | null;
  provenance: "missing" | "reported" | "assumed-reset";
  lastCheckAt: number | null; checkError: string | null;
}
export interface AccountForm { account: string; priority: string; weight: string }
export interface MappingForm { enabled: boolean; mappings: ModelMapping[] }
export type TuningForm = Record<keyof RoutingTuning, string>;
export type FormValue = AccountForm | MappingForm | TuningForm;
export type FormKey = "mapping" | "tuning" | `account:${string}`;
export interface Draft {
  value: FormValue; baseline: FormValue; latest: FormValue;
  phase: "clean" | "dirty" | "saving" | "saved" | "error";
  externalChange: boolean; message: string | null;
}
export type Transition = { kind: "view"; view: View } | { kind: "account"; account: string } | { kind: "close-drawer" };
export interface DashboardState {
  snapshot: DashboardStatus | null;
  lastSuccessAt: number | null; connectionError: string | null;
  view: View; routingModel: string | null; routingPending: boolean;
  filters: OverviewFilters; sort: OverviewSort;
  drawer: { account: string; lastKnownAccount: Account; removed: boolean } | null;
  forms: Map<FormKey, Draft>;
  pendingTransition: Transition | null;
}
export interface BrowserPort {
  now(): number;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  render(state: Readonly<DashboardState>): void;
}
