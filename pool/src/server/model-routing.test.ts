import { test, expect } from "bun:test";
import { parseOpenAI } from "../adapters/openai.ts";
import { parseAnthropic } from "../adapters/anthropic.ts";
import { modelFamilyOf } from "../accounts/types.ts";

/**
 * handleOpenAI/handleAnthropic in server.ts (the CLI-subprocess backend path)
 * must derive the routing `modelFamily` from `parsed.requestedModel` — the
 * raw model id the caller sent — not from `parsed.model`, which is the
 * CLI-resolved alias ("opus"/"sonnet"/"haiku") used only to pick a `claude`
 * CLI flag and can never represent "fable"/"mythos". These tests lock in the
 * distinction those handlers depend on.
 */

test("OpenAI adapter: requestedModel preserves the raw model id even though the CLI alias collapses it", () => {
  const parsed = parseOpenAI({
    model: "claude-fable-5",
    messages: [{ role: "user", content: "hi" }],
  });
  expect(parsed.model).toBe("sonnet"); // resolveModel() has no fable mapping
  expect(parsed.requestedModel).toBe("claude-fable-5");
  expect(modelFamilyOf(parsed.requestedModel)).toBe("fable");
  expect(modelFamilyOf(parsed.model)).not.toBe("fable");
});

test("Anthropic adapter: requestedModel preserves the raw model id even though the CLI alias collapses it", () => {
  const parsed = parseAnthropic({
    model: "claude-fable-5",
    messages: [{ role: "user", content: "hi" }],
  });
  expect(parsed.model).toBe("sonnet");
  expect(parsed.requestedModel).toBe("claude-fable-5");
  expect(modelFamilyOf(parsed.requestedModel)).toBe("fable");
});
