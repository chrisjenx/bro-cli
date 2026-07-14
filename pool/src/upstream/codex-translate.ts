// Pure protocol translation between Anthropic Messages API and Codex Responses API.
// No I/O, no network — everything here is fixture-tested.

import {
  isSourceEffortTier,
  type SourceEffortTier,
  type CodexEffort,
  type EffortMap,
} from "../models.ts";

/** Source effort tier of an Anthropic request. Precedence: output_config.effort
 * (what Claude Code sends with adaptive thinking) > legacy thinking.budget_tokens
 * bucketing (think ~4k → low, megathink ~10k → medium, ultrathink ~32k → high,
 * above → xhigh) > "default" (no signal). */
export function deriveEffortTier(body: Record<string, unknown>): SourceEffortTier {
  const oc = body.output_config as Record<string, unknown> | undefined;
  const effort = oc?.effort;
  if (effort !== "default" && isSourceEffortTier(effort)) return effort;
  const thinking = body.thinking as Record<string, unknown> | undefined;
  if (thinking?.type === "enabled" && typeof thinking.budget_tokens === "number") {
    const budget = thinking.budget_tokens;
    return budget < 8192 ? "low" : budget < 16384 ? "medium" : budget < 32768 ? "high" : "xhigh";
  }
  return "default";
}

/** Mapping override wins; otherwise tiers pass through 1:1 and "default" stays
 * unset so Codex applies its own server default (medium). */
export function codexEffortFor(tier: SourceEffortTier, effortMap?: EffortMap): CodexEffort | undefined {
  // effortMap values are already CodexEffort (sanitized on load, validated on POST).
  const explicit = effortMap?.[tier];
  if (explicit) return explicit;
  return tier === "default" ? undefined : (tier as CodexEffort);
}

/** Only gpt-5.6* exposes the `max` reasoning effort; every earlier Codex model
 * (gpt-5.5, gpt-5.4, gpt-5.4-mini) tops out at xhigh and 400s on `max`. Clamp
 * down rather than fail upstream — xhigh is supported everywhere `max` is asked. */
export function clampEffortForModel(effort: CodexEffort | undefined, upstreamModel: string): CodexEffort | undefined {
  if (effort === "max" && !upstreamModel.startsWith("gpt-5.6")) return "xhigh";
  return effort;
}

export function anthropicToCodexRequest(
  body: Record<string, unknown>,
  upstreamModel: string,
  effortMap?: EffortMap,
): Record<string, unknown> {
  const input: Array<Record<string, unknown>> = [];
  for (const m of (body.messages as Array<Record<string, unknown>> | undefined) ?? []) {
    const role = m.role === "assistant" ? "assistant" : "user";
    const content = m.content;
    if (typeof content === "string") {
      input.push(textMessage(role, content));
      continue;
    }
    if (!Array.isArray(content)) continue;
    const blocks = content as Array<Record<string, unknown>>;
    // Text and image blocks accumulate as message parts; tool_use/tool_result/
    // reasoning are standalone items that flush any pending parts first.
    const parts: Array<Record<string, unknown>> = [];
    const flush = () => {
      if (parts.length) input.push({ type: "message", role, content: parts.splice(0) });
    };
    for (let bi = 0; bi < blocks.length; bi++) {
      const block = blocks[bi]!;
      if (block.type === "text" && typeof block.text === "string") {
        // Adjacent text blocks fold into one part joined with "\n" (matching
        // the pre-image behavior); an intervening image starts a new part.
        const last = parts[parts.length - 1];
        const kind = role === "assistant" ? "output_text" : "input_text";
        if (last && last.type === kind && typeof last.text === "string") {
          last.text = `${last.text}\n${block.text}`;
        } else {
          parts.push({ type: kind, text: block.text });
        }
      } else if (block.type === "image" && role === "user") {
        const image = imagePart(block);
        if (image) parts.push(image);
      } else if (block.type === "tool_use") {
        flush();
        input.push({
          type: "function_call",
          call_id: String(block.id ?? ""),
          name: String(block.name ?? ""),
          arguments: JSON.stringify(block.input ?? {}),
        });
      } else if (block.type === "thinking") {
        // A thinking block whose signature is our stash of a Codex reasoning
        // item round-trips back as a `reasoning` input item — Codex requires
        // the reasoning item to precede its paired function_call under
        // store:false, and 400s when it's missing. Thinking blocks from other
        // backends (opaque non-JSON signatures) are dropped as before.
        // Guard against orphans: a reasoning item must be followed by another
        // item from the same turn (Codex 400s on a reasoning item "without its
        // required following item"). An interrupted turn can end on thinking.
        const hasFollowingItem = blocks
          .slice(bi + 1)
          .some((b) => b.type === "text" || b.type === "tool_use");
        const stash = hasFollowingItem ? parseReasoningStash(block.signature) : null;
        if (stash) {
          flush();
          input.push({
            type: "reasoning",
            id: stash.id,
            summary:
              typeof block.thinking === "string" && block.thinking
                ? [{ type: "summary_text", text: block.thinking }]
                : [],
            encrypted_content: stash.encrypted_content,
          });
        }
      } else if (block.type === "tool_result") {
        flush();
        input.push({
          type: "function_call_output",
          call_id: String(block.tool_use_id ?? ""),
          output: foldToolResultContent(block.content),
        });
        // function_call_output.output is string-only on Codex, so image blocks
        // inside a tool_result (e.g. screenshots) ride in a follow-up user
        // message immediately after the tool output.
        const images = Array.isArray(block.content)
          ? (block.content as Array<Record<string, unknown>>)
              .filter((b) => b.type === "image")
              .map(imagePart)
              .filter((p): p is Record<string, unknown> => p !== null)
          : [];
        if (images.length) input.push({ type: "message", role: "user", content: images });
      }
      // assistant images / anything else: dropped (spec: degrade gracefully)
    }
    flush();
  }

  const out: Record<string, unknown> = {
    model: upstreamModel,
    instructions: foldSystem(body.system),
    input,
    stream: true,
    store: false,
    // Required on every stateless (store:false) call so reasoning items carry
    // encrypted_content we can round-trip on the next turn — matching the
    // Codex CLI (codex-rs/core/src/client.rs always sends this include).
    include: ["reasoning.encrypted_content"],
  };
  // Deliberately no output-token cap. The ChatGPT Codex backend rejects
  // `max_output_tokens` outright ("400 Unsupported parameter: max_output_tokens"),
  // and the reference Codex CLI's ResponsesApiRequest carries no output-length
  // field — the backend bounds output itself. Since Claude Code always sends
  // max_tokens, forwarding it here 400s every Codex-routed request. Do not
  // re-add it.
  const effort = clampEffortForModel(codexEffortFor(deriveEffortTier(body), effortMap), upstreamModel);
  if (effort) out.reasoning = { effort };
  const tools = (body.tools as Array<Record<string, unknown>> | undefined) ?? [];
  if (tools.length) {
    out.tools = tools
      .filter((t) => typeof t.name === "string")
      .map((t) => ({
        type: "function",
        name: t.name,
        description: t.description ?? "",
        strict: false,
        parameters: t.input_schema ?? { type: "object" },
      }));
    out.tool_choice = mapToolChoice(body.tool_choice);
    out.parallel_tool_calls = false;
  }
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  return out;
}

function textMessage(role: string, text: string): Record<string, unknown> {
  const kind = role === "assistant" ? "output_text" : "input_text";
  return { type: "message", role, content: [{ type: kind, text }] };
}

/** Maps an Anthropic image block onto a Codex `input_image` part; null when
 * the source shape is unrecognized. */
function imagePart(block: Record<string, unknown>): Record<string, unknown> | null {
  const source = block.source as Record<string, unknown> | undefined;
  if (source?.type === "base64" && typeof source.data === "string") {
    const mediaType = typeof source.media_type === "string" ? source.media_type : "image/png";
    return { type: "input_image", image_url: `data:${mediaType};base64,${source.data}` };
  }
  if (source?.type === "url" && typeof source.url === "string") {
    return { type: "input_image", image_url: source.url };
  }
  return null;
}

function foldSystem(system: unknown): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((b) => (typeof (b as Record<string, unknown>).text === "string" ? (b as Record<string, unknown>).text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function foldToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b as Record<string, unknown>).text)
      .filter((t): t is string => typeof t === "string")
      .join("\n");
  }
  return "";
}

/**
 * Strips thinking blocks fabricated by this translator (stash-JSON signature,
 * or no signature at all — native Anthropic thinking blocks always carry an
 * opaque one) from a request body headed to the real Anthropic API. Without
 * this, a session that ran on a Codex model and then switches to a claude-*
 * model replays fake-signed thinking blocks that Anthropic rejects with a
 * retry-stable 400 during thinking-enabled tool-use continuations. Assistant
 * messages emptied by the strip are dropped. Non-object bodies and bodies with
 * nothing to strip are returned unchanged; the input is never mutated.
 */
export function stripCodexThinking(body: unknown): unknown {
  if (body == null || typeof body !== "object" || Array.isArray(body)) return body;
  const messages = (body as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) return body;

  const isOurs = (block: Record<string, unknown>): boolean =>
    block.type === "thinking" &&
    (typeof block.signature !== "string" || parseReasoningStash(block.signature) !== null);

  const needsStrip = messages.some(
    (m) =>
      Array.isArray((m as Record<string, unknown>)?.content) &&
      ((m as Record<string, unknown>).content as Array<Record<string, unknown>>).some(isOurs),
  );
  if (!needsStrip) return body;

  const stripped = messages.flatMap((m) => {
    const msg = m as Record<string, unknown>;
    if (!Array.isArray(msg?.content)) return [m];
    const content = (msg.content as Array<Record<string, unknown>>).filter((b) => !isOurs(b));
    if (content.length === 0) return [];
    return [{ ...msg, content }];
  });
  return { ...(body as Record<string, unknown>), messages: stripped };
}

/** Parses a thinking-block signature back into the Codex reasoning stash we
 * wrote in closeBlock(); returns null for foreign/opaque signatures. */
function parseReasoningStash(signature: unknown): { id: string; encrypted_content: string } | null {
  if (typeof signature !== "string") return null;
  try {
    const parsed = JSON.parse(signature) as Record<string, unknown>;
    if (typeof parsed.id === "string" && typeof parsed.encrypted_content === "string") {
      return { id: parsed.id, encrypted_content: parsed.encrypted_content };
    }
  } catch {
    // not ours
  }
  return null;
}

function mapToolChoice(choice: unknown): unknown {
  const c = choice as Record<string, unknown> | undefined;
  if (c?.type === "any") return "required";
  if (c?.type === "tool" && typeof c.name === "string") return { type: "function", name: c.name };
  if (c?.type === "none") return "none";
  return "auto";
}

export class CodexToAnthropicStream {
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number } = {
    input_tokens: 0,
    output_tokens: 0,
  };
  stopReason: string | null = null;
  sawError: { type: string; message: string } | null = null;

  private index = -1;
  private blockOpen = false;
  private sawToolUse = false;
  private started = false;
  private finished = false;

  // Structured accumulation for the non-streaming (folded) response. Built
  // from the same events as the SSE frames below — no string round-trip
  // through the emitted frames is needed to reconstruct the final message.
  /** Set when a tool_use block closed with unparseable non-empty args; the
   * error is deferred to finish() so a token-cap terminal event (where
   * truncated args are expected) can clear it first. */
  private argsError: string | null = null;

  private msgId: string | undefined;
  private model: string | undefined;
  private content: Array<Record<string, unknown>> = [];
  private argsAccum = new Map<number, string>();

  constructor(private modelId: string) {}

  /** True once the message_start envelope has been emitted (real or forced). */
  get hasStarted(): boolean {
    return this.started;
  }

  handleEvent(event: { event: string; data: string }): string[] {
    // An error is terminal for the Anthropic SSE contract: once emitted, no
    // further content frames may follow it.
    if (this.sawError) return [];
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      return [];
    }
    const type = (data.type as string | undefined) ?? event.event;
    switch (type) {
      case "response.created":
        if (this.started) return [];
        return this.emitMessageStart(msgId(data));
      case "response.output_item.added": {
        const item = (data.item ?? {}) as Record<string, unknown>;
        if (item.type === "message") return [this.openBlock({ type: "text", text: "" })];
        if (item.type === "function_call") {
          this.sawToolUse = true;
          return [this.openBlock({
            type: "tool_use",
            id: String(item.call_id ?? item.id ?? `tu_${this.index + 1}`),
            name: String(item.name ?? ""),
            input: {},
          })];
        }
        if (item.type === "reasoning") {
          // Reasoning becomes an Anthropic thinking block; its summary text
          // streams as thinking_delta and closeBlock() stashes the item's
          // encrypted_content into the signature for the next-turn round-trip.
          return [this.openBlock({ type: "thinking", thinking: "" })];
        }
        return [];
      }
      case "response.reasoning_summary_text.delta": {
        const block = this.content[this.index];
        if (!this.blockOpen || block?.type !== "thinking") return [];
        const text = String(data.delta ?? "");
        block.thinking = (typeof block.thinking === "string" ? block.thinking : "") + text;
        return [frame("content_block_delta", {
          type: "content_block_delta", index: this.index,
          delta: { type: "thinking_delta", thinking: text },
        })];
      }
      case "response.output_text.delta": {
        if (!this.blockOpen) return [];
        const text = String(data.delta ?? "");
        const block = this.content[this.index];
        if (block) block.text = (typeof block.text === "string" ? block.text : "") + text;
        return [frame("content_block_delta", {
          type: "content_block_delta", index: this.index,
          delta: { type: "text_delta", text },
        })];
      }
      case "response.function_call_arguments.delta": {
        if (!this.blockOpen) return [];
        const delta = String(data.delta ?? "");
        this.argsAccum.set(this.index, (this.argsAccum.get(this.index) ?? "") + delta);
        return [frame("content_block_delta", {
          type: "content_block_delta", index: this.index,
          delta: { type: "input_json_delta", partial_json: delta },
        })];
      }
      case "response.output_item.done":
        return this.closeBlock((data.item ?? {}) as Record<string, unknown>);
      case "response.completed":
      case "response.incomplete": {
        const response = (data.response ?? {}) as Record<string, unknown>;
        const usage = (response.usage ?? {}) as Record<string, unknown>;
        if (typeof usage.input_tokens === "number") this.usage.input_tokens = usage.input_tokens;
        if (typeof usage.output_tokens === "number") this.usage.output_tokens = usage.output_tokens;
        const inputDetails = (usage.input_tokens_details ?? {}) as Record<string, unknown>;
        if (typeof inputDetails.cached_tokens === "number") {
          this.usage.cache_read_input_tokens = inputDetails.cached_tokens;
        }
        const incomplete = (response.incomplete_details ?? {}) as Record<string, unknown>;
        if (response.status === "incomplete" || type === "response.incomplete") {
          // Truncation must not read as a clean finish — Anthropic callers key
          // continuation behavior off stop_reason. content_filter maps to
          // "refusal"; token-cap (and unknown) reasons map to "max_tokens".
          this.stopReason = incomplete.reason === "content_filter" ? "refusal" : "max_tokens";
          // Truncated tool-call args are expected under a token cap; the
          // non-clean stop_reason already tells the client not to run the tool.
          this.argsError = null;
        } else {
          this.stopReason = this.sawToolUse ? "tool_use" : "end_turn";
        }
        return [];
      }
      case "response.failed":
      case "error": {
        const err = ((data.response as Record<string, unknown>)?.error ?? data.error ?? data) as Record<string, unknown>;
        this.sawError = {
          type: String(err.code ?? err.type ?? "api_error"),
          message: String(err.message ?? "Codex backend error"),
        };
        return [frame("error", { type: "error", error: this.sawError })];
      }
      default:
        return [];
    }
  }

  /**
   * Emit the `message_start` envelope without waiting for Codex's
   * `response.created` event. Codex echoes the request `instructions` (the full
   * system prompt + tool schemas) inside `response.created`, so that single SSE
   * `data:` line can exceed the proxy's prefix-commit cap — leaving the parser
   * unable to complete the first event and the client with no opening frame.
   * The streaming proxy calls this when it commits at the cap so the client
   * always gets a prompt envelope; the `started` guard makes the eventual real
   * `response.created` a no-op. Returns [] if the stream already started.
   */
  forceMessageStart(): string[] {
    if (this.started) return [];
    return this.emitMessageStart(`msg_${Date.now().toString(36)}`);
  }

  private emitMessageStart(id: string): string[] {
    this.started = true;
    this.msgId = id;
    this.model = this.modelId;
    return [frame("message_start", {
      type: "message_start",
      message: {
        id: this.msgId, type: "message", role: "assistant", model: this.modelId,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })];
  }

  finish(): string[] {
    if (this.finished || !this.started) return [];
    if (this.sawError) {
      this.finished = true;
      return [];
    }
    this.finished = true;
    const frames = this.closeBlock();
    if (this.argsError) {
      // A tool call closed with corrupt args and no token-cap event excused
      // it — end the stream with a terminal error instead of a clean close.
      this.sawError = { type: "api_error", message: this.argsError };
      frames.push(frame("error", { type: "error", error: this.sawError }));
      return frames;
    }
    frames.push(frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: this.stopReason ?? "end_turn", stop_sequence: null },
      usage: { ...this.usage },
    }));
    frames.push(frame("message_stop", { type: "message_stop" }));
    return frames;
  }

  private openBlock(contentBlock: Record<string, unknown>): string {
    this.index += 1;
    this.blockOpen = true;
    this.content[this.index] = contentBlock;
    return frame("content_block_start", {
      type: "content_block_start", index: this.index, content_block: contentBlock,
    });
  }

  private closeBlock(item?: Record<string, unknown>): string[] {
    if (!this.blockOpen) return [];
    this.blockOpen = false;
    const idx = this.index;
    const block = this.content[idx];
    const frames: string[] = [];
    if (block && block.type === "tool_use") {
      const raw = this.argsAccum.get(idx) ?? "";
      this.argsAccum.delete(idx);
      try {
        block.input = raw ? JSON.parse(raw) : {};
      } catch {
        // Truncated/malformed argument JSON: running the tool with {} would
        // fold a wrong result back into context. Defer the verdict to
        // finish(): a token-cap terminal event downgrades this to a normal
        // max_tokens stop; otherwise finish() ends the stream with an error.
        block.input = {};
        this.argsError = `Codex returned malformed arguments for tool "${String(block.name ?? "")}"`;
      }
    }
    if (
      block && block.type === "thinking" &&
      typeof item?.id === "string" && typeof item?.encrypted_content === "string"
    ) {
      // Stash the reasoning item's identity + encrypted payload in the
      // signature; anthropicToCodexRequest() reverses this on the next turn.
      const signature = JSON.stringify({ id: item.id, encrypted_content: item.encrypted_content });
      block.signature = signature;
      frames.push(frame("content_block_delta", {
        type: "content_block_delta", index: idx,
        delta: { type: "signature_delta", signature },
      }));
    }
    frames.push(frame("content_block_stop", { type: "content_block_stop", index: idx }));
    return frames;
  }

  /**
   * Returns the non-streaming Anthropic message built from structured state
   * accumulated in handleEvent() — no re-parsing of emitted SSE frames.
   * Call after finish() so stop_reason/usage reflect the completed response.
   */
  toAnthropicMessage(): Record<string, unknown> {
    return {
      id: this.msgId,
      type: "message",
      role: "assistant",
      model: this.model,
      content: this.content,
      stop_reason: this.stopReason ?? "end_turn",
      stop_sequence: null,
      usage: { ...this.usage },
    };
  }
}

function frame(eventName: string, payload: Record<string, unknown>): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function msgId(data: Record<string, unknown>): string {
  const r = data.response as Record<string, unknown> | undefined;
  return typeof r?.id === "string" ? r.id : `msg_${Date.now().toString(36)}`;
}
