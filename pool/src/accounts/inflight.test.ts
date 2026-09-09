import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig, type Config } from "../config.ts";
import { AccountManager } from "./manager.ts";
import { OPENAI_CREDS_FILENAME } from "./types.ts";
import { chooseMappedService } from "../server/server.ts";

function pool(overrides: Partial<Config> = {}) {
  const dir = mkdtempSync(join(process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, "tmp") : tmpdir(), "inflight-"));
  for (const name of ["claude", "gpt1", "gpt2"]) {
    mkdirSync(join(dir, "accounts", name), { recursive: true });
    writeFileSync(join(dir, "accounts", name, name === "claude" ? ".credentials.json" : OPENAI_CREDS_FILENAME), JSON.stringify(name === "claude" ? { claudeAiOauth: { accessToken: "t", expiresAt: Date.now() + 3600000 } } : { accessToken: "t", expiresAt: Date.now() + 3600000 }));
  }
  const config = loadConfig({ poolDir: dir, accountsDir: join(dir, "accounts"), usageFile: join(dir, "usage.json"), sessionsFile: join(dir, "sessions.json"), codexMaxInFlight: 1, anthropicMaxInFlight: 1, logFailover: false, ...overrides });
  return { mgr: new AccountManager(config), clean: () => rmSync(dir, { recursive: true, force: true }) };
}

test("capacity skips busy accounts and release is idempotent", () => {
  const { mgr, clean } = pool();
  try {
    const release = mgr.acquireInFlight("gpt1");
    expect(mgr.inFlightOf("gpt1")).toBe(1);
    expect(mgr.getAccount("gpt1").inFlight).toBe(1);
    expect(mgr.pick(undefined, undefined, "openai")?.name).toBe("gpt2");
    const release2 = mgr.acquireInFlight("gpt2");
    expect(mgr.pick(undefined, undefined, "openai")).toBeNull();
    expect(mgr.pick(undefined, undefined, "openai", null, { ignoreCap: true })).not.toBeNull();
    mgr.markRateLimited("gpt1"); mgr.markRateLimited("gpt2");
    expect(mgr.pick(undefined, undefined, "openai", null, { ignoreCap: true })).toBeNull();
    release(); release(); release2();
    expect(mgr.inFlightOf("gpt1")).toBe(0);
  } finally { clean(); }
});

test("unlimited accounts still count active reservations", () => {
  const { mgr, clean } = pool({ codexMaxInFlight: 0 });
  try {
    const release = mgr.acquireInFlight("gpt1");
    expect(mgr.getAccount("gpt1").inFlight).toBe(1);
    expect(mgr.pick(undefined, new Set(["gpt2"]), "openai")?.name).toBe("gpt1");
    release();
  } finally { clean(); }
});

test("mapped selection prefers free providers but waits rather than rejects when all are at cap", () => {
  const { mgr, clean } = pool();
  try {
    const releases = [mgr.acquireInFlight("gpt1"), mgr.acquireInFlight("gpt2")];
    expect(chooseMappedService(mgr, undefined, "sonnet")).toBe("anthropic");
    releases.push(mgr.acquireInFlight("claude"));
    expect(chooseMappedService(mgr, undefined, "sonnet")).not.toBeNull();
    releases.forEach(r => r());
  } finally { clean(); }
});

test("slot waits wake on release, abort and timeout", async () => {
  const { mgr, clean } = pool();
  try {
    let release = mgr.acquireInFlight("claude");
    let resolved = false;
    const wait = mgr.waitForSlot("anthropic", null, new AbortController().signal, 1000).then(() => { resolved = true; });
    await Promise.resolve(); expect(resolved).toBe(false);
    release(); await wait; expect(resolved).toBe(true);
    release = mgr.acquireInFlight("claude");
    const abort = new AbortController();
    const aborted = mgr.waitForSlot("anthropic", null, abort.signal, 1000);
    abort.abort(); await aborted;
    const start = Date.now();
    await mgr.waitForSlot("anthropic", null, new AbortController().signal, 20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
    release();
  } finally { clean(); }
});


test("reservation is atomic before its promise returns and a shared wait budget is spent only once", async () => {
  const { mgr, clean } = pool();
  const signal = new AbortController().signal;
  try {
    const a = mgr.reserveInFlight(undefined, undefined, "openai", null, signal, { remainingMs: 1000 });
    const b = mgr.reserveInFlight(undefined, undefined, "openai", null, signal, { remainingMs: 1000 });
    expect(mgr.inFlightOf("gpt1") + mgr.inFlightOf("gpt2")).toBe(2);
    const first = (await a)!; const second = (await b)!;
    expect(first.account.name).not.toBe(second.account.name);
    const budget = { remainingMs: 25 };
    const over = (await mgr.reserveInFlight(undefined, undefined, "openai", null, signal, budget))!;
    expect(budget.remainingMs).toBe(0); over.release();
    // A retry with the same budget must not start another wait.
    const retry = mgr.reserveInFlight(undefined, new Set([first.account.name]), "openai", null, signal, budget);
    expect(mgr.inFlightOf(second.account.name)).toBe(2);
    (await retry)!.release(); first.release(); second.release();
    expect(mgr.inFlightOf("gpt1") + mgr.inFlightOf("gpt2")).toBe(0);
  } finally { clean(); }
});

test("waking multiple waiters never races one free slot into unintended overflow", async () => {
  const { mgr, clean } = pool();
  const controller = new AbortController();
  try {
    const initial = mgr.acquireInFlight("claude");
    const pending1 = mgr.reserveInFlight(undefined, undefined, "anthropic", null, controller.signal, { remainingMs: 1000 });
    const pending2 = mgr.reserveInFlight(undefined, undefined, "anthropic", null, controller.signal, { remainingMs: 1000 });
    initial();
    const first = (await pending1)!;
    await Promise.resolve();
    expect(mgr.inFlightOf("claude")).toBe(1);
    first.release();
    const second = (await pending2)!;
    expect(mgr.inFlightOf("claude")).toBe(1);
    second.release();
  } finally { controller.abort(); clean(); }
});


test("routing preview reports capacity-skipped accounts even if no next pick exists", () => {
  const { mgr, clean } = pool();
  try {
    const release = mgr.acquireInFlight("claude");
    const preview = mgr.routingSnapshot("anthropic");
    expect(preview.nextPick).toBeNull();
    expect(preview.busy).toEqual([{ account: "claude", inFlight: 1, limit: 1 }]);
    release();
    expect(mgr.routingSnapshot("anthropic").busy).toEqual([]);
  } finally { clean(); }
});
