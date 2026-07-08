import { describe, expect, test } from "bun:test";
import { isValidProvider } from "./cli.ts";

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
