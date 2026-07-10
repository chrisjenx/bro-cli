import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SessionLedger } from "./sessions.ts";

const IDLE = 30 * 60_000;

function tempFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "cmp-sessions-"));
  return { dir, file: join(dir, "sessions.json") };
}

test("touch pins a session and get returns it while live", () => {
  const { dir, file } = tempFile();
  try {
    const ledger = new SessionLedger(file, IDLE);
    const now = Date.now();
    ledger.touch("anthropic", "sess-1", "acct-a", now);
    expect(ledger.get("anthropic", "sess-1", now)).toBe("acct-a");
    // Same key, other provider namespace: no pin.
    expect(ledger.get("openai", "sess-1", now)).toBe(null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pin expires after idleMs and stops counting toward load", () => {
  const { dir, file } = tempFile();
  try {
    const ledger = new SessionLedger(file, IDLE);
    const now = Date.now();
    ledger.touch("anthropic", "sess-1", "acct-a", now);
    expect(ledger.get("anthropic", "sess-1", now + IDLE - 1)).toBe("acct-a");
    expect(ledger.get("anthropic", "sess-1", now + IDLE)).toBe(null);
    expect(ledger.activeCount("acct-a", now + IDLE)).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("activeCount counts only live pins to that account", () => {
  const { dir, file } = tempFile();
  try {
    const ledger = new SessionLedger(file, IDLE);
    const now = Date.now();
    ledger.touch("anthropic", "s1", "acct-a", now);
    ledger.touch("anthropic", "s2", "acct-a", now);
    ledger.touch("anthropic", "s3", "acct-b", now);
    ledger.touch("anthropic", "s4", "acct-a", now - IDLE - 1); // already expired
    expect(ledger.activeCount("acct-a", now)).toBe(2);
    expect(ledger.activeCount("acct-b", now)).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evictAccount drops every pin to that account", () => {
  const { dir, file } = tempFile();
  try {
    const ledger = new SessionLedger(file, IDLE);
    const now = Date.now();
    ledger.touch("anthropic", "s1", "acct-a", now);
    ledger.touch("anthropic", "s2", "acct-b", now);
    ledger.evictAccount("acct-a");
    expect(ledger.get("anthropic", "s1", now)).toBe(null);
    expect(ledger.get("anthropic", "s2", now)).toBe("acct-b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pins and load counts survive a restart (persistence round-trip)", () => {
  const { dir, file } = tempFile();
  try {
    const now = Date.now();
    const first = new SessionLedger(file, IDLE);
    first.touch("anthropic", "s1", "acct-a", now);
    first.touch("openai", "s2", "acct-b", now);

    const reborn = new SessionLedger(file, IDLE);
    expect(reborn.get("anthropic", "s1")).toBe("acct-a");
    expect(reborn.get("openai", "s2")).toBe("acct-b");
    expect(reborn.activeCount("acct-a")).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("entries already expired on disk are dropped at load", () => {
  const { dir, file } = tempFile();
  try {
    const stale = Date.now() - IDLE - 60_000;
    writeFileSync(file, JSON.stringify({
      sessions: { "anthropic:old": { account: "acct-a", provider: "anthropic", lastSeenAt: stale } },
    }));
    const ledger = new SessionLedger(file, IDLE);
    expect(ledger.get("anthropic", "old")).toBe(null);
    expect(ledger.activeCount("acct-a")).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt or missing sessions.json starts empty without throwing", () => {
  const { dir, file } = tempFile();
  try {
    writeFileSync(file, "{not json");
    const ledger = new SessionLedger(file, IDLE);
    expect(ledger.get("anthropic", "s1")).toBe(null);
    // Missing file: also fine.
    const ledger2 = new SessionLedger(join(dir, "nope.json"), IDLE);
    expect(ledger2.activeCount("x")).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prune removes expired entries from disk", () => {
  const { dir, file } = tempFile();
  try {
    const ledger = new SessionLedger(file, IDLE);
    const now = Date.now();
    ledger.touch("anthropic", "s1", "acct-a", now - IDLE - 1);
    ledger.touch("anthropic", "s2", "acct-a", now);
    ledger.prune(now);
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(onDisk.sessions)).toEqual(["anthropic:s2"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
