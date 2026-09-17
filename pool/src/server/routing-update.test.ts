import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig } from "../config.ts";
import { AccountManager } from "../accounts/manager.ts";
import { handleRoutingUpdate, handleTuningUpdate, handleRecheck } from "./server.ts";

function tempMgr(names: string[]): { poolDir: string; accountsDir: string; mgr: AccountManager } {
  const poolDir = mkdtempSync(join(process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, "tmp") : tmpdir(), "cmp-routing-"));
  const accountsDir = join(poolDir, "accounts");
  for (const n of names) {
    mkdirSync(join(accountsDir, n), { recursive: true });
    writeFileSync(
      join(accountsDir, n, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "t" } }),
    );
  }
  const config = loadConfig({
    poolDir,
    accountsDir,
    usageFile: join(poolDir, "usage.json"),
    sessionsFile: join(poolDir, "sessions.json"),
  });
  return { poolDir, accountsDir, mgr: new AccountManager(config) };
}

test("handleRoutingUpdate persists a valid priority", async () => {
  const { poolDir, accountsDir, mgr } = tempMgr(["work"]);
  try {
    const res = handleRoutingUpdate(mgr, { account: "work", priority: 2 });
    expect(res.status).toBe(200);
    const onDisk = JSON.parse(readFileSync(join(accountsDir, "work", "routing.json"), "utf8"));
    expect(onDisk.priority).toBe(2);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("handleRoutingUpdate rejects unknown account and bad priority", () => {
  const { poolDir, mgr } = tempMgr(["work"]);
  try {
    expect(handleRoutingUpdate(mgr, { account: "nope", priority: 1 }).status).toBe(400);
    expect(handleRoutingUpdate(mgr, { account: "work", priority: -1 }).status).toBe(400);
    expect(handleRoutingUpdate(mgr, { account: "work", priority: 1.5 }).status).toBe(400);
    expect(handleRoutingUpdate(mgr, {}).status).toBe(400);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("handleTuningUpdate persists valid knobs and reflects them in getTuning", async () => {
  const { poolDir, mgr } = tempMgr(["work"]);
  try {
    const res = handleTuningUpdate(mgr, { headroomTaperStart: 0.9, minHeadroom: 0.2 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tuning: { headroomTaperStart: number; minHeadroom: number; fiveHourExp: number } };
    expect(body.tuning.headroomTaperStart).toBe(0.9);
    expect(body.tuning.minHeadroom).toBe(0.2);
    expect(body.tuning.fiveHourExp).toBe(1); // untouched knob preserved at default
    const onDisk = JSON.parse(readFileSync(join(poolDir, "tuning.json"), "utf8"));
    expect(onDisk.headroomTaperStart).toBe(0.9);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("handleTuningUpdate rejects out-of-bounds values and empty bodies", () => {
  const { poolDir, mgr } = tempMgr(["work"]);
  try {
    expect(handleTuningUpdate(mgr, { fiveHourExp: 99 }).status).toBe(400);
    expect(handleTuningUpdate(mgr, { minHeadroom: 2 }).status).toBe(400);
    expect(handleTuningUpdate(mgr, { loadSlope: -1 }).status).toBe(400);
    expect(handleTuningUpdate(mgr, {}).status).toBe(400);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("tuning rejects mixed current and retired or unknown keys atomically", () => {
  const { poolDir, mgr } = tempMgr(["work"]);
  try {
    for (const key of ["urgencyDecay", "loadSlope", "unknown", "toString"]) {
      expect(handleTuningUpdate(mgr, { fiveHourExp: 2, [key]: 1 }).status).toBe(400);
      expect(mgr.getTuning().fiveHourExp).toBe(1);
    }
  } finally { rmSync(poolDir, { recursive: true, force: true }); }
});

test("handleRecheck clears a billing block so the account serves again", () => {
  const { poolDir, mgr } = tempMgr(["work"]);
  try {
    mgr.markBillingBlocked("work", "OAuth authentication is currently not allowed for this organization.");
    expect(mgr.getAccount("work").available).toBe(false);

    const res = handleRecheck(mgr, { account: "work" });

    expect(res.status).toBe(200);
    const after = mgr.getAccount("work");
    expect(after.billingBlocked).toBe(false);
    expect(after.available).toBe(true);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("handleRecheck rejects an unknown account", () => {
  const { poolDir, mgr } = tempMgr(["work"]);
  try {
    expect(handleRecheck(mgr, { account: "nope" }).status).toBe(400);
    expect(handleRecheck(mgr, {}).status).toBe(400);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});
