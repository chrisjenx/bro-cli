import { expect, test } from "bun:test";
import { buildDashboardDescriptors } from "./dashboard.ts";
import { createDashboardForms } from "./dashboard-forms.ts";
import { accountFixture, deferred, FIXTURE_NOW, statusFixture } from "./dashboard-test-helpers.ts";
import type { BrowserPort, DashboardState, DashboardStatus, TuningForm } from "./dashboard-types.ts";
const { createDashboardController } = await import("./dashboard-controller.ts").catch(() => ({ createDashboardController: undefined }));

function harness() {
  expect(typeof createDashboardController).toBe("function");
  const shared = buildDashboardDescriptors();
  const requests: Array<{ url: string; init?: RequestInit; pending: ReturnType<typeof deferred<Response>> }> = [];
  const intervals = new Map<number, { fn: () => void; ms: number }>();
  const timeouts = new Map<number, { fn: () => void; ms: number }>();
  let id = 0, time = FIXTURE_NOW, renderCount = 0, rendered: Readonly<DashboardState> | undefined;
  const port: BrowserPort = {
    now: () => time,
    fetch(url, init) { const pending = deferred<Response>(); requests.push({ url, init, pending }); return pending.promise; },
    setInterval(fn, ms) { const n = ++id; intervals.set(n, { fn, ms }); return n; },
    clearInterval(n) { intervals.delete(n as number); },
    setTimeout(fn, ms) { const n = ++id; timeouts.set(n, { fn, ms }); return n; },
    clearTimeout(n) { timeouts.delete(n as number); },
    render(s) { rendered = s; renderCount++; },
  };
  const controller = createDashboardController!(port, createDashboardForms(shared), shared);
  const respond = (index: number, body: unknown, status = 200) => requests[index]!.pending.resolve(Response.json(body, { status }));
  return { controller, requests, intervals, timeouts, respond, get rendered() { return rendered; }, get renderCount() { return renderCount; }, advance(n: number) { time += n; },
    async boot(s: DashboardStatus = statusFixture()) { const p = controller.refresh("initial"); respond(requests.length - 1, s); await p; },
  };
}

test("initial start fetches immediately and owns a four-second nonoverlapping poll", async () => {
  const h = harness(); const started = h.controller.start();
  expect(h.requests).toHaveLength(1);
  expect([...h.intervals.values()][0]!.ms).toBe(4000);
  [...h.intervals.values()][0]!.fn(); expect(h.requests).toHaveLength(1);
  h.respond(0, statusFixture()); await started;
  h.controller.stop(); expect(h.intervals.size).toBe(0); expect(h.timeouts.size).toBe(0);
});
test("poll renders once on settlement but still ticks while a request is pending", async () => {
  const h = harness(); const started = h.controller.start();
  h.respond(0, statusFixture()); await started;
  const tick = [...h.intervals.values()][0]!.fn;
  const initialRenders = h.renderCount;
  tick();
  expect(h.requests).toHaveLength(2);
  expect(h.renderCount).toBe(initialRenders);
  h.respond(1, statusFixture());
  for (let i = 0; i < 40; i++) await Promise.resolve();
  expect(h.renderCount).toBe(initialRenders + 1);
  tick(); tick();
  expect(h.requests).toHaveLength(3);
  expect(h.renderCount).toBe(initialRenders + 2);
  h.controller.stop();
});

test("matching the latest server value clears and rebases an external conflict", async () => {
  const h = harness(); await h.boot();
  h.controller.requestTransition({ kind: "account", account: "primary" });
  h.controller.editForm("account:primary", { account: "primary", priority: "2", weight: "1" });
  const changed = statusFixture([accountFixture("primary", { priority: 3 })]);
  let poll = h.controller.refresh("timer"); h.respond(1, changed); await poll;
  expect(h.controller.getState().forms.get("account:primary")!.externalChange).toBe(true);
  h.controller.editForm("account:primary", { account: "primary", priority: "3", weight: "1" });
  const draft = h.controller.getState().forms.get("account:primary")!;
  expect(draft.phase).toBe("clean");
  expect(draft.externalChange).toBe(false);
  expect(draft.baseline).toEqual({ account: "primary", priority: "3", weight: "1" });
  poll = h.controller.refresh("timer"); h.respond(2, changed); await poll;
  expect(draft.externalChange).toBe(false);
  h.controller.editForm("account:primary", { account: "primary", priority: "4", weight: "1" });
  poll = h.controller.refresh("timer"); h.respond(3, changed); await poll;
  expect(draft.externalChange).toBe(false);
  h.controller.stop();
});

test("closing or switching drawers releases resolved account drafts", async () => {
  const h = harness(); await h.boot(statusFixture([accountFixture("primary"), accountFixture("second")]));
  h.controller.requestTransition({ kind: "account", account: "primary" });
  h.controller.requestTransition({ kind: "account", account: "second" });
  expect(h.controller.getState().forms.has("account:primary")).toBe(false);
  h.controller.editForm("account:second", { account: "second", priority: "2", weight: "1" });
  expect(h.controller.requestTransition({ kind: "close-drawer" })).toBe(false);
  expect(h.controller.getState().forms.has("account:second")).toBe(true);
  await h.controller.resolveTransition("stay");
  expect(h.controller.getState().forms.has("account:second")).toBe(true);
  h.controller.requestTransition({ kind: "close-drawer" });
  await h.controller.resolveTransition("discard");
  expect([...h.controller.getState().forms.keys()]).toEqual(["mapping", "tuning"]);
  h.controller.requestTransition({ kind: "account", account: "second" });
  expect(h.controller.getState().forms.get("account:second")!.value).toEqual({ account: "second", priority: "100", weight: "1" });
  h.controller.stop();
});

test("old context and its failure cannot replace a newer successful snapshot", async () => {
  const h = harness(); const old = h.controller.refresh("initial");
  const current = h.controller.setContext("opus");
  const s = statusFixture(); s.routingContext!.model = "opus";
  h.respond(1, s); await current;
  h.requests[0]!.pending.reject(new Error("old failed")); await old;
  expect(h.controller.getState().snapshot?.routingContext?.model).toBe("opus");
  expect(h.controller.getState().connectionError).toBeNull(); h.controller.stop();
});
test("initial failure is not an empty pool; later failure preserves last good snapshot", async () => {
  const h = harness(); let pending = h.controller.refresh("initial");
  h.respond(0, {}, 500); await pending;
  expect(h.controller.getState().snapshot).toBeNull();
  await h.boot(); const success = h.controller.getState().lastSuccessAt;
  pending = h.controller.refresh("timer"); h.requests.at(-1)!.pending.reject(new Error("offline")); await pending;
  expect(h.controller.getState().snapshot?.accounts).toHaveLength(1);
  expect(h.controller.getState().lastSuccessAt).toBe(success);
  expect(h.controller.getState().connectionError).toContain("offline"); h.controller.stop();
});
test("malformed status is rejected instead of erasing the pool", async () => {
  const h = harness(); await h.boot();
  const pending = h.controller.refresh("timer"); h.respond(1, { accounts: [] }); await pending;
  expect(h.controller.getState().snapshot?.accounts).toHaveLength(1);
  expect(h.controller.getState().connectionError).toBeTruthy(); h.controller.stop();
});
test("timeout releases a hung request so polling can recover", async () => {
  const h = harness(); const pending = h.controller.refresh("initial");
  [...h.timeouts.values()][0]!.fn(); await pending;
  expect(h.controller.getState().connectionError).toContain("timed out");
  await h.boot(); expect(h.controller.getState().connectionError).toBeNull(); h.controller.stop();
});
test("live values update while dirty account input survives external changes", async () => {
  const h = harness(); await h.boot();
  h.controller.requestTransition({ kind: "account", account: "primary" });
  h.controller.editForm("account:primary", { account: "primary", priority: "2", weight: "1.5" });
  const pending = h.controller.refresh("timer");
  h.respond(1, statusFixture([accountFixture("primary", { priority: 3, inFlight: 2 })])); await pending;
  expect(h.controller.getState().snapshot!.accounts[0]!.inFlight).toBe(2);
  const draft = h.controller.getState().forms.get("account:primary")!;
  expect(draft.value).toEqual({ account: "primary", priority: "2", weight: "1.5" });
  expect(draft.externalChange).toBe(true);
  h.controller.cancelForm("account:primary");
  expect(h.controller.getState().forms.get("account:primary")!.value).toEqual({ account: "primary", priority: "3", weight: "1" }); h.controller.stop();
});
test("account save sends both settings once and old reads cannot undo acknowledgement", async () => {
  const h = harness(); await h.boot();
  h.controller.requestTransition({ kind: "account", account: "primary" });
  h.controller.editForm("account:primary", { account: "primary", priority: "2", weight: "1.5" });
  const old = h.controller.refresh("timer");
  const saving = h.controller.saveForm("account:primary");
  expect(JSON.parse(String(h.requests[2]!.init!.body))).toEqual({ account: "primary", priority: 2, weight: 1.5 });
  expect(await h.controller.saveForm("account:primary")).toBe(false);
  h.respond(2, { ok: true, account: "primary", priority: 2, weight: 1.5 });
  expect(await saving).toBe(true);
  h.respond(1, statusFixture()); await old;
  expect(h.controller.getState().snapshot!.accounts[0]!.priority).toBe(2);
  expect(h.controller.getState().forms.get("account:primary")!.phase).toBe("saved");
  h.controller.stop();
});
test("a read started during save is also invalidated by acknowledgement", async () => {
  const h = harness(); await h.boot();
  h.controller.requestTransition({ kind: "account", account: "primary" });
  h.controller.editForm("account:primary", { account: "primary", priority: "2", weight: "1" });
  const saving = h.controller.saveForm("account:primary");
  const during = h.controller.refresh("timer");
  h.respond(1, { ok: true, account: "primary", priority: 2, weight: 1 }); await saving;
  h.respond(2, statusFixture()); await during;
  expect(h.controller.getState().snapshot!.accounts[0]!.priority).toBe(2); h.controller.stop();
});
test("unconfirmed or rejected save preserves the draft and reports failure", async () => {
  const h = harness(); await h.boot();
  h.controller.requestTransition({ kind: "account", account: "primary" });
  h.controller.editForm("account:primary", { account: "primary", priority: "2", weight: "1" });
  const saving = h.controller.saveForm("account:primary"); h.respond(1, { ok: true });
  expect(await saving).toBe(false);
  expect(h.controller.getState().forms.get("account:primary")!.message).toContain("could not be confirmed");
  expect(h.controller.getState().forms.get("account:primary")!.value).toEqual({ account: "primary", priority: "2", weight: "1" }); h.controller.stop();
});
test("keep editing cancels all guarded transitions; discard uses latest values", async () => {
  const h = harness(); await h.boot();
  h.controller.requestTransition({ kind: "account", account: "primary" });
  h.controller.editForm("account:primary", { account: "primary", priority: "2", weight: "1" });
  for (const next of [{ kind: "close-drawer" }, { kind: "view", view: "routing" }] as const) {
    expect(h.controller.requestTransition(next)).toBe(false);
    expect(await h.controller.resolveTransition("stay")).toBe(false);
    expect(h.controller.getState().drawer?.account).toBe("primary");
  }
  h.controller.requestTransition({ kind: "close-drawer" });
  expect(await h.controller.resolveTransition("discard")).toBe(true);
  expect(h.controller.getState().drawer).toBeNull(); h.controller.stop();
});
test("removed account stays identifiable, cannot save, and can be discarded", async () => {
  const h = harness(); await h.boot();
  h.controller.requestTransition({ kind: "account", account: "primary" });
  h.controller.editForm("account:primary", { account: "primary", priority: "2", weight: "1" });
  const poll = h.controller.refresh("timer"); h.respond(1, statusFixture([])); await poll;
  expect(h.controller.getState().drawer?.removed).toBe(true);
  expect(await h.controller.saveForm("account:primary")).toBe(false);
  h.controller.requestTransition({ kind: "close-drawer" }); await h.controller.resolveTransition("discard");
  expect(h.controller.getState().drawer).toBeNull(); h.controller.stop();
});
test("two-form save-and-leave keeps the view if the second save fails", async () => {
  const h = harness(); await h.boot(); h.controller.requestTransition({ kind: "view", view: "settings" });
  h.controller.editForm("mapping", { enabled: true, mappings: [] });
  h.controller.editForm("tuning", { fiveHourExp: "2", headroomTaperStart: "0.2", minHeadroom: "0.1" } as TuningForm);
  h.controller.requestTransition({ kind: "view", view: "overview" });
  const transition = h.controller.resolveTransition("save");
  h.respond(1, { ok: true, mappingEnabled: true, mappings: [] });
  // Wait for the first real save to advance to the second form, without real timers.
  for (let i = 0; i < 40 && !h.requests.some(r => r.url === "/api/tuning"); i++) await Promise.resolve();
  const index = h.requests.findIndex(r => r.url === "/api/tuning"); expect(index).toBeGreaterThan(1);
  h.respond(index, { error: { message: "cannot persist" } }, 500);
  expect(await transition).toBe(false);
  expect(h.controller.getState().view).toBe("settings");
  expect(h.controller.getState().snapshot!.mapping.enabled).toBe(true);
  expect(h.controller.getState().forms.get("tuning")!.phase).toBe("error"); h.controller.stop();
});
