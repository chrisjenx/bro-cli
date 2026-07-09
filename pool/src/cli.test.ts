import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { isValidProvider, parsePriorityArg, runAccountsCommand } from "./cli.ts";
import { loadConfig } from "./config.ts";

// FIX 6: `--provider chatgpt` (a typo) must not silently fall through to the
// default anthropic login — only "anthropic" and "openai" are real providers.
describe("isValidProvider", () => {
  test("accepts the two known providers", () => {
    expect(isValidProvider("anthropic")).toBe(true);
    expect(isValidProvider("openai")).toBe(true);
  });

  test("rejects typos and unknown providers", () => {
    expect(isValidProvider("chatgpt")).toBe(false);
    expect(isValidProvider("Anthropic")).toBe(false);
    expect(isValidProvider("")).toBe(false);
    expect(isValidProvider("codex")).toBe(false);
  });
});

test("parsePriorityArg accepts non-negative integers, rejects the rest", () => {
  expect(parsePriorityArg("0")).toBe(0);
  expect(parsePriorityArg("2")).toBe(2);
  expect(parsePriorityArg("-1")).toBeNull();
  expect(parsePriorityArg("1.5")).toBeNull();
  expect(parsePriorityArg("abc")).toBeNull();
  expect(parsePriorityArg(undefined)).toBeNull();
});

test("accounts tier <name> <priority> writes routing.json", async () => {
  const poolDir = mkdtempSync(join(tmpdir(), "cmp-cli-"));
  const accountsDir = join(poolDir, "accounts");
  mkdirSync(join(accountsDir, "work"), { recursive: true });
  writeFileSync(
    join(accountsDir, "work", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "t" } }),
  );
  const config = loadConfig({ poolDir, accountsDir, usageFile: join(poolDir, "usage.json") });
  try {
    const code = await runAccountsCommand(config, ["tier", "work", "1"]);
    expect(code).toBe(0);
    const onDisk = JSON.parse(readFileSync(join(accountsDir, "work", "routing.json"), "utf8"));
    expect(onDisk.priority).toBe(1);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});

test("accounts tier rejects a bad priority with a non-zero exit code", async () => {
  const poolDir = mkdtempSync(join(tmpdir(), "cmp-cli-"));
  const accountsDir = join(poolDir, "accounts");
  mkdirSync(join(accountsDir, "work"), { recursive: true });
  writeFileSync(
    join(accountsDir, "work", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "t" } }),
  );
  const config = loadConfig({ poolDir, accountsDir, usageFile: join(poolDir, "usage.json") });
  try {
    expect(await runAccountsCommand(config, ["tier", "work", "-1"])).toBe(1);
    expect(await runAccountsCommand(config, ["tier", "ghost", "1"])).toBe(1);
  } finally {
    rmSync(poolDir, { recursive: true, force: true });
  }
});
