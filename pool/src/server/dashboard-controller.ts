import type { DashboardForms } from "./dashboard-forms.ts";
import type { BrowserPort, DashboardState, DashboardStatus, Draft, FormKey, FormValue, OverviewFilters, OverviewSort, SharedDescriptors, Transition } from "./dashboard-types.ts";

/** Owns requests and drafts; no DOM or imported runtime closures survive serialization. */
export function createDashboardController(port: BrowserPort, forms: DashboardForms, shared: SharedDescriptors) {
  const state: DashboardState = {
    snapshot: null, lastSuccessAt: null, connectionError: null,
    view: "overview", routingModel: null, routingPending: false,
    filters: { search: "", provider: "all", status: "all" }, sort: { key: "name", direction: "asc" },
    drawer: null, forms: new Map(), pendingTransition: null,
  };
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
  const requests = new Set<AbortController>();
  const saves = new Map<FormKey, Promise<boolean>>();
  let interval: unknown = null, pending: AbortController | null = null;
  let ticket = 0, stopped = false, started = false, resolving = false;
  const render = () => { if (!stopped) port.render(state); };
  const message = (e: unknown) => e instanceof Error ? e.message : String(e);
  function invalidate() { ticket++; pending?.abort(new Error("Superseded request")); pending = null; }
  async function request(url: string, init: RequestInit, abort: AbortController): Promise<unknown> {
    requests.add(abort);
    let onAbort: () => void = () => {};
    const canceled = new Promise<never>((_, reject) => {
      onAbort = () => reject(abort.signal.reason ?? new Error("Request canceled"));
      abort.signal.addEventListener("abort", onAbort, { once: true });
      if (abort.signal.aborted) onAbort();
    });
    const timeout = port.setTimeout(() => abort.abort(new Error("Request timed out")), 10_000);
    try {
      const response = port.fetch(url, { ...init, signal: abort.signal }).then(async r => {
        const text = await r.text();
        let body: unknown;
        try { body = JSON.parse(text); } catch { throw new Error(r.ok ? "Invalid JSON acknowledgement" : `HTTP ${r.status}: ${text.slice(0, 200) || r.statusText}`); }
        if (!r.ok) {
          const error = (body as { error?: unknown } | null)?.error;
          const detail = typeof error === "string" ? error : (error as { message?: unknown } | null)?.message;
          throw new Error(typeof detail === "string" ? detail : `HTTP ${r.status}`);
        }
        return body;
      });
      return await Promise.race([response, canceled]);
    } finally {
      port.clearTimeout(timeout);
      abort.signal.removeEventListener("abort", onAbort);
      requests.delete(abort);
    }
  }
  function readStatus(raw: unknown): DashboardStatus {
    const s = raw as DashboardStatus | null;
    if (!s || !Array.isArray(s.accounts) || !s.routing || !Array.isArray(s.routing.tiers)
      || !s.mapping || typeof s.mapping.enabled !== "boolean" || !Array.isArray(s.mapping.mappings) || !Array.isArray(s.mapping.targets)
      || !s.tuning || shared.tuningFields.some(f => !Number.isFinite(s.tuning[f.key]))
      || !Number.isFinite(s.now) || !Number.isFinite(s.usageWindowMs)
      || s.accounts.some(a => !a || typeof a.name !== "string" || typeof a.available !== "boolean" || !a.usage
        || (a.usage.rateLimitStatus != null && !Array.isArray(a.usage.rateLimitStatus.windows)))) {
      throw new Error("Invalid pool status response");
    }
    // Historical target lists contained strings; capability-free entries must not invent support.
    s.mapping.targets = s.mapping.targets.map(t => typeof t === "string" ? { id: t, supportedEfforts: [] } : t);
    return s;
  }
  function ensureForm(key: FormKey): Draft | undefined {
    if (!state.snapshot) return;
    const current = state.forms.get(key);
    if (current) return current;
    const value = forms.readServerForm(key, state.snapshot);
    if (!value) return;
    const draft: Draft = { value: clone(value), baseline: clone(value), latest: clone(value), phase: "clean", externalChange: false, message: null };
    state.forms.set(key, draft);
    return draft;
  }
  function syncForms() {
    if (!state.snapshot) return;
    ensureForm("mapping"); ensureForm("tuning");
    for (const [key, draft] of state.forms) {
      const value = forms.readServerForm(key, state.snapshot);
      if (!value) continue;
      const wasDirty = draft.phase === "saving" || draft.phase === "error" || !forms.equal(draft.value, draft.latest);
      const changed = !forms.equal(value, draft.latest);
      draft.latest = clone(value);
      if (wasDirty) {
        draft.externalChange = !forms.equal(value, draft.baseline);
        if (draft.phase !== "saving" && forms.equal(draft.value, value)) {
          draft.phase = "clean"; draft.baseline = clone(value); draft.message = null; draft.externalChange = false;
        }
      } else if (changed) {
        draft.value = clone(value); draft.baseline = clone(value); draft.phase = "clean";
        draft.message = null; draft.externalChange = false;
      }
    }
    if (state.drawer) {
      const account = state.snapshot.accounts.find(a => a.name === state.drawer!.account);
      state.drawer.removed = !account;
      if (account) state.drawer.lastKnownAccount = account;
    }
  }
  async function refresh(reason: "initial" | "timer" | "context" | "save" | "retry"): Promise<void> {
    if (stopped || (reason === "timer" && pending)) return;
    if (reason !== "timer") invalidate();
    const ownTicket = ++ticket, model = state.routingModel;
    const abort = new AbortController(); pending = abort;
    const current = () => !stopped && ownTicket === ticket;
    try {
      const raw = await request(`/api/status?model=${encodeURIComponent(model ?? "")}`, {}, abort);
      if (!current()) return;
      state.snapshot = readStatus(raw);
      state.lastSuccessAt = port.now(); state.connectionError = null; state.routingPending = false;
      syncForms(); render();
    } catch (error) {
      if (current()) { state.connectionError = message(error); state.routingPending = false; render(); }
    } finally { if (pending === abort) pending = null; }
  }
  async function start() {
    if (started || stopped) return;
    started = true;
    interval = port.setInterval(() => { if (pending) render(); else void refresh("timer"); }, 4000);
    render(); await refresh("initial");
  }
  function stop() {
    stopped = true; invalidate();
    if (interval != null) port.clearInterval(interval);
    interval = null;
    for (const abort of requests) abort.abort(new Error("Dashboard closed"));
  }
  async function setContext(model: string | null) {
    state.routingModel = model; state.routingPending = true; render(); await refresh("context");
  }
  function editForm(key: FormKey, value: FormValue) {
    const draft = ensureForm(key);
    if (!draft || draft.phase === "saving") return;
    draft.value = clone(value);    draft.phase = forms.equal(value, draft.latest) ? "clean" : "dirty";
    if (draft.phase === "clean") { draft.baseline = clone(draft.latest); draft.externalChange = false; }
    draft.message = null; render();
  }
  function cancelForm(key: FormKey) {
    const draft = state.forms.get(key);
    if (!draft || draft.phase === "saving") return;
    draft.value = clone(draft.latest); draft.baseline = clone(draft.latest);
    draft.phase = "clean"; draft.externalChange = false; draft.message = null; render();
  }
  async function saveForm(key: FormKey): Promise<boolean> {
    const draft = ensureForm(key);
    if (stopped || !state.snapshot || !draft || saves.has(key)) return false;
    const prepared = forms.prepareSave(key, draft.value, draft.latest, state.snapshot);
    if (!prepared.ok) { draft.phase = "error"; draft.message = Object.values(prepared.errors).join(" "); render(); return false; }
    if (key === "tuning" && Object.keys(prepared.payload).length === 0) { cancelForm(key); return true; }
    draft.phase = "saving"; draft.message = null;
    invalidate(); render();
    const saving = (async () => {
      try {
        const raw = await request(prepared.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(prepared.payload) }, new AbortController());
        if (stopped || !state.snapshot) return false;
        const updated = forms.applyAck(key, raw, state.snapshot);
        invalidate(); state.snapshot = updated;
        if (state.forms.get(key) === draft) {
          const value = forms.readServerForm(key, updated);
          if (value) { draft.value = clone(value); draft.baseline = clone(value); draft.latest = clone(value); }
          draft.phase = "saved"; draft.externalChange = false; draft.message = "Saved";
        }
        syncForms(); render(); void refresh("save");
        return true;
      } catch (error) {
        if (!stopped && state.forms.get(key) === draft) {
          draft.phase = "error";
          draft.message = `Save could not be confirmed; server values may have changed. ${message(error)}`;
          render();
        }
        return false;
      } finally { saves.delete(key); }
    })();
    saves.set(key, saving);
    return saving;
  }
  function affectedKeys(next: Transition): FormKey[] {
    const keys: FormKey[] = [];
    if (state.drawer && !(next.kind === "account" && next.account === state.drawer.account)) keys.push(`account:${state.drawer.account}`);
    if (state.view === "settings" && next.kind === "view" && next.view !== "settings") keys.push("mapping", "tuning");
    return keys.filter(key => { const d = state.forms.get(key); return d && (d.phase === "saving" || d.phase === "error" || !forms.equal(d.value, d.latest)); });
  }
  function applyTransition(next: Transition): boolean {
    const previousAccount = state.drawer?.account;
    if (next.kind === "account") {
      const account = state.snapshot?.accounts.find(a => a.name === next.account);
      if (!account) return false;
      state.drawer = { account: account.name, lastKnownAccount: account, removed: false };
      ensureForm(`account:${account.name}`);
    } else {
      state.drawer = null;
      if (next.kind === "view") state.view = next.view;
    }
    if (previousAccount && previousAccount !== state.drawer?.account) state.forms.delete(`account:${previousAccount}`);
    state.pendingTransition = null; render(); return true;
  }
  function requestTransition(next: Transition): boolean {
    if (affectedKeys(next).length) { state.pendingTransition = next; render(); return false; }
    return applyTransition(next);
  }
  async function resolveTransition(decision: "save" | "discard" | "stay"): Promise<boolean> {
    const next = state.pendingTransition;
    if (!next || resolving) return false;
    if (decision === "stay") { state.pendingTransition = null; render(); return false; }
    resolving = true;
    try {
      for (const key of affectedKeys(next)) {
        const pendingSave = saves.get(key);
        if (pendingSave && !(await pendingSave)) return false;
        if (decision === "save") { if (!pendingSave && !(await saveForm(key))) return false; }
        else cancelForm(key);
      }
      return applyTransition(next);
    } finally { resolving = false; render(); }
  }
  /**
   * Clear an account's billing block on demand and reload, so a reactivated
   * subscription can be put back in rotation without restarting the pool.
   */
  async function recheckAccount(account: string): Promise<boolean> {
    if (stopped) return false;
    try {
      await request("/api/recheck", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account }) }, new AbortController());
      // Fire-and-forget like saveForm: the caller only waits on the POST, so a
      // slow status poll never holds the button in its disabled state.
      void refresh("save");
      return true;
    } catch {
      return false;
    }
  }
  return { start, stop, refresh, setContext, editForm, cancelForm, saveForm, requestTransition, resolveTransition, recheckAccount,
    getState: (): Readonly<DashboardState> => state,
    setFilters(filters: OverviewFilters) { state.filters = { ...filters }; render(); },
    setSort(sort: OverviewSort) { state.sort = { ...sort }; render(); },
  };
}
export type DashboardController = ReturnType<typeof createDashboardController>;
