/**
 * Pre-flight context-window check for the Codex path.
 *
 * Claude Code sizes its own auto-compact threshold from the env the CLI writes,
 * but a resumed session, a non-bro client, or a mapping edit mid-session can
 * still put an over-window request on the wire. Codex answers those with an
 * opaque 400; this turns them into a line that names the model and the limit.
 */
import { effectiveContextWindow, type ModelRoute } from "../models.ts";

/** Chars per token. Deliberately coarse: this gates a guard rail, not billing,
 * and a cheap over-estimate is better than tokenizing every request. */
const CHARS_PER_TOKEN = 4;

/** Content nests at most a couple of levels deep in practice (message ->
 * tool_result -> text block); this just keeps a pathological/cyclic shape
 * from recursing unbounded rather than reflecting any real protocol depth. */
const MAX_CONTENT_DEPTH = 8;

function textLength(content: unknown, depth = 0): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content) || depth >= MAX_CONTENT_DEPTH) return 0;
  let total = 0;
  for (const block of content) {
    if (block == null || typeof block !== "object") continue;
    const text = (block as Record<string, unknown>).text;
    if (typeof text === "string") total += text.length;
    const input = (block as Record<string, unknown>).input;
    if (input != null) total += JSON.stringify(input).length;
    // tool_result blocks carry their payload in `.content`, either a string
    // or a nested array of blocks — this is the dominant source of context
    // growth in agentic sessions (Read/Grep/Bash/Edit output), so it must
    // count. Recursing through textLength covers both shapes; malformed
    // content (number, object, null) falls through to 0 via the guards above.
    const nested = (block as Record<string, unknown>).content;
    if (nested != null) total += textLength(nested, depth + 1);
  }
  return total;
}

export function estimateInputTokens(body: unknown): number {
  if (body == null || typeof body !== "object") return 0;
  const b = body as Record<string, unknown>;
  let chars = textLength(b.system);
  if (Array.isArray(b.messages)) {
    for (const m of b.messages) {
      if (m == null || typeof m !== "object") continue;
      chars += textLength((m as Record<string, unknown>).content);
    }
  }
  if (Array.isArray(b.tools)) chars += JSON.stringify(b.tools).length;
  return Math.floor(chars / CHARS_PER_TOKEN);
}

export function contextOverflowMessage(model: string, estimate: number, window: number): string {
  const n = (v: number) => v.toLocaleString("en-US");
  return (
    `Request is about ${n(estimate)} input tokens, over the ${n(window)}-token context window ` +
    `the pool allows for "${model}". Compact or shorten the conversation, map this family to a ` +
    `model with a larger window, or raise POOL_MAX_CONTEXT if the upstream model allows more.`
  );
}

/** The overflow message, or null when the request fits. */
export function checkContextWindow(body: unknown, route: ModelRoute, cap: number): string | null {
  const window = effectiveContextWindow(route, cap);
  const estimate = estimateInputTokens(body);
  if (estimate <= window) return null;
  return contextOverflowMessage(route.upstreamModel, estimate, window);
}
