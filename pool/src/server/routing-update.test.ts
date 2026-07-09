import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig } from "../config.ts";
import { AccountManager } from "../accounts/manager.ts";
import { handleRoutingUpdate } from "./server.ts";

function tempMgr(names: string[]): { poolDir: string; accountsDir: string; mgr: AccountManager } {
  const poolDir = mkdtempSync(join(tmpdir(), "cmp-routing-"));
  const accountsDir = join(poolDir, "accounts");
  for (const n of names) {
    mkdirSync(join(accountsDir, n), { recursive: true });
    writeFileSync(
      join(accountsDir, n, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "t" } }),
    );
  }
  const config = loadConfig({ poolDir, accountsDir, usageFile: join(poolDir, "usage.json") });
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
