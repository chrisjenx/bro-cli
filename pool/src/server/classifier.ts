import type { Config } from "../config.ts";

/**
 * Opening sentence of the system prompt Claude Code's auto mode sends with its
 * per-tool-call safety classifier request. The classifier is a plain Sonnet
 * request (whatever ANTHROPIC_DEFAULT_SONNET_MODEL resolves to), so without
 * this detection it inherits the pool's Sonnet mapping and lands on Codex.
 */
export const AUTO_MODE_CLASSIFIER_MARKER = "You are a security monitor for autonomous AI coding agents";

/** Observed max_tokens is 64; the margin tolerates modest growth. */
export const CLASSIFIER_MAX_TOKENS = 1024;

function systemTexts(system: unknown): string[] {
  if (typeof system === "string") return [system];
  if (!Array.isArray(system)) return [];
  return system.flatMap((block) =>
    block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
      ? [(block as { text: string }).text]
      : [],
  );
}

/**
 * The classifier's request shape independent of its wording: non-streaming,
 * no tools, tiny output budget. On its own this is too loose to route on
 * (other small helper calls share it), but a shape match without the marker
 * is the signal that Claude Code reworded the prompt.
 */
export function classifierShapeMatches(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const req = body as { stream?: unknown; tools?: unknown; max_tokens?: unknown };
  if (req.stream === true) return false;
  if (Array.isArray(req.tools) && req.tools.length > 0) return false;
  return typeof req.max_tokens === "number" && req.max_tokens <= CLASSIFIER_MAX_TOKENS;
}

/**
 * True iff `body` looks like the auto-mode classifier: the shape above plus a
 * system block that opens with the marker. The shape guards keep a user
 * prompt that merely quotes the sentence from matching.
 */
export function isAutoModeClassifierRequest(body: unknown): boolean {
  if (!classifierShapeMatches(body)) return false;
  return systemTexts((body as { system?: unknown }).system).some((text) => text.startsWith(AUTO_MODE_CLASSIFIER_MARKER));
}

/** Whether handleAnthropic should skip the model mapping and serve on Claude accounts. */
export function bypassMappingForClassifier(config: Pick<Config, "classifierRoute">, body: unknown): boolean {
  return config.classifierRoute === "anthropic" && isAutoModeClassifierRequest(body);
}
