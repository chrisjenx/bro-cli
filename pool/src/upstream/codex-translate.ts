// Pure protocol translation between Anthropic Messages API and Codex Responses API.
// No I/O, no network — everything here is fixture-tested.

export function anthropicToCodexRequest(
  body: Record<string, unknown>,
  upstreamModel: string,
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
    const textBlocks: string[] = [];
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === "text" && typeof block.text === "string") {
        textBlocks.push(block.text);
      } else if (block.type === "tool_use") {
        if (textBlocks.length) input.push(textMessage(role, textBlocks.splice(0).join("\n")));
        input.push({
          type: "function_call",
          call_id: String(block.id ?? ""),
          name: String(block.name ?? ""),
          arguments: JSON.stringify(block.input ?? {}),
        });
      } else if (block.type === "tool_result") {
        if (textBlocks.length) input.push(textMessage(role, textBlocks.splice(0).join("\n")));
        input.push({
          type: "function_call_output",
          call_id: String(block.tool_use_id ?? ""),
          output: foldToolResultContent(block.content),
        });
      }
      // image / thinking / anything else: dropped (spec: degrade gracefully)
    }
    if (textBlocks.length) input.push(textMessage(role, textBlocks.join("\n")));
  }

  const out: Record<string, unknown> = {
    model: upstreamModel,
    instructions: foldSystem(body.system),
    input,
    stream: true,
    store: false,
  };
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
      .map((b) => (typeof (b as Record<string, unknown>).text === "string" ? (b as Record<string, unknown>).text : ""))
      .join("\n");
  }
  return "";
}

function mapToolChoice(choice: unknown): unknown {
  const c = choice as Record<string, unknown> | undefined;
  if (c?.type === "any") return "required";
  if (c?.type === "tool" && typeof c.name === "string") return { type: "function", name: c.name };
  if (c?.type === "none") return "none";
  return "auto";
}

export class CodexToAnthropicStream {
  usage = { input_tokens: 0, output_tokens: 0 };
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
  private msgId: string | undefined;
  private model: string | undefined;
  private content: Array<Record<string, unknown>> = [];
  private argsAccum = new Map<number, string>();

  constructor(private modelId: string) {}

  handleEvent(event: { event: string; data: string }): string[] {
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
        this.started = true;
        this.msgId = msgId(data);
        this.model = this.modelId;
        return [frame("message_start", {
          type: "message_start",
          message: {
            id: msgId(data), type: "message", role: "assistant", model: this.modelId,
            content: [], stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        })];
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
        return []; // reasoning etc.
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
        return this.closeBlock();
      case "response.completed": {
        const usage = ((data.response as Record<string, unknown>)?.usage ?? {}) as Record<string, unknown>;
        if (typeof usage.input_tokens === "number") this.usage.input_tokens = usage.input_tokens;
        if (typeof usage.output_tokens === "number") this.usage.output_tokens = usage.output_tokens;
        this.stopReason = this.sawToolUse ? "tool_use" : "end_turn";
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

  finish(): string[] {
    if (this.finished || !this.started) return [];
    if (this.sawError) {
      this.finished = true;
      return [];
    }
    this.finished = true;
    const frames = this.closeBlock();
    frames.push(frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: this.stopReason ?? "end_turn", stop_sequence: null },
      usage: { input_tokens: this.usage.input_tokens, output_tokens: this.usage.output_tokens },
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

  private closeBlock(): string[] {
    if (!this.blockOpen) return [];
    this.blockOpen = false;
    const idx = this.index;
    const block = this.content[idx];
    if (block && block.type === "tool_use") {
      const raw = this.argsAccum.get(idx) ?? "";
      try {
        block.input = JSON.parse(raw);
      } catch {
        block.input = {};
      }
      this.argsAccum.delete(idx);
    }
    return [frame("content_block_stop", { type: "content_block_stop", index: idx })];
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
      usage: { input_tokens: this.usage.input_tokens, output_tokens: this.usage.output_tokens },
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
