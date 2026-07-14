import { describe, expect, test } from "bun:test";
import { anthropicToCodexRequest, CodexToAnthropicStream, stripCodexThinking, deriveEffortTier, codexEffortFor, clampEffortForModel } from "./codex-translate.ts";

const parse = (frame: string) => JSON.parse(frame.split("\ndata: ")[1]!.trim());

describe("anthropicToCodexRequest", () => {
  test("maps system, text turns, tools, and forces stream", () => {
    const out = anthropicToCodexRequest({
      model: "gpt", system: "be brief", max_tokens: 100,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
        { role: "user", content: [{ type: "text", text: "use the tool" }] },
      ],
      tools: [{ name: "read_file", description: "reads", input_schema: { type: "object" } }],
    }, "gpt-5.2-codex");
    expect(out.model).toBe("gpt-5.2-codex");
    expect(out.instructions).toBe("be brief");
    expect(out.stream).toBe(true);
    expect(out.store).toBe(false);
    const input = out.input as Array<Record<string, unknown>>;
    expect(input).toHaveLength(3);
    expect(input[0]).toMatchObject({ type: "message", role: "user" });
    const tools = out.tools as Array<Record<string, unknown>>;
    expect(tools[0]).toMatchObject({ type: "function", name: "read_file" });
  });

  test("maps tool_choice: any -> required, tool -> function, none -> none, default -> auto", () => {
    const base = {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "read_file", description: "reads", input_schema: { type: "object" } }],
    };
    expect(anthropicToCodexRequest({ ...base, tool_choice: { type: "any" } }, "m").tool_choice).toBe("required");
    expect(anthropicToCodexRequest({ ...base, tool_choice: { type: "tool", name: "read_file" } }, "m").tool_choice).toEqual({
      type: "function",
      name: "read_file",
    });
    expect(anthropicToCodexRequest({ ...base, tool_choice: { type: "none" } }, "m").tool_choice).toBe("none");
    expect(anthropicToCodexRequest({ ...base, tool_choice: { type: "auto" } }, "m").tool_choice).toBe("auto");
    expect(anthropicToCodexRequest(base, "m").tool_choice).toBe("auto");
  });

  test("always requests encrypted reasoning content (store:false statelessness)", () => {
    const out = anthropicToCodexRequest({ messages: [{ role: "user", content: "hi" }] }, "gpt-5.2-codex");
    expect(out.include).toEqual(["reasoning.encrypted_content"]);
  });

  test("never sends an output-token cap: the ChatGPT Codex backend rejects max_output_tokens", () => {
    // The ChatGPT Codex backend 400s with "Unsupported parameter:
    // max_output_tokens", and the reference Codex CLI's ResponsesApiRequest
    // carries no output-length field — the backend caps output itself. So we
    // drop it regardless of the caller's max_tokens (a normal value or a
    // Claude Code max_tokens:1 probe).
    for (const max_tokens of [4096, 1]) {
      const out = anthropicToCodexRequest(
        { max_tokens, messages: [{ role: "user", content: "hi" }] },
        "gpt-5.2-codex",
      );
      expect("max_output_tokens" in out).toBe(false);
    }
  });

  test("adjacent text blocks stay joined with a newline in a single part", () => {
    const out = anthropicToCodexRequest({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>x</system-reminder>" },
            { type: "text", text: "question" },
          ],
        },
      ],
    }, "m");
    const input = out.input as Array<Record<string, unknown>>;
    const parts = input[0]!.content as Array<Record<string, unknown>>;
    expect(parts).toHaveLength(1);
    expect(parts[0]!.text).toBe("<system-reminder>x</system-reminder>\nquestion");
  });

  test("an intervening image splits text into separate parts", () => {
    const out = anthropicToCodexRequest({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "before" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AA" } },
            { type: "text", text: "after" },
          ],
        },
      ],
    }, "m");
    const parts = (out.input as Array<Record<string, unknown>>)[0]!.content as Array<Record<string, unknown>>;
    expect(parts.map((p) => p.type)).toEqual(["input_text", "input_image", "input_text"]);
  });

  test("a trailing thinking block with no following item in its message emits no orphan reasoning item", () => {
    const signature = JSON.stringify({ id: "rs_9", encrypted_content: "enc" });
    const out = anthropicToCodexRequest({
      messages: [
        { role: "user", content: "go" },
        // Interrupted turn: thinking is the last (only) block.
        { role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature }] },
        { role: "user", content: "continue" },
      ],
    }, "m");
    const input = out.input as Array<Record<string, unknown>>;
    expect(input.some((i) => i.type === "reasoning")).toBe(false);
  });

  test("reconstructs reasoning input items from replayed thinking blocks", () => {
    const signature = JSON.stringify({ id: "rs_1", encrypted_content: "enc-blob" });
    const out = anthropicToCodexRequest({
      messages: [
        { role: "user", content: "do it" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "I should read the file", signature },
            { type: "tool_use", id: "call_1", name: "read_file", input: { path: "a" } },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "data" }] },
      ],
    }, "gpt-5.2-codex");
    const input = out.input as Array<Record<string, unknown>>;
    // reasoning item must precede its paired function_call (Codex 400s otherwise)
    expect(input[1]).toEqual({
      type: "reasoning",
      id: "rs_1",
      summary: [{ type: "summary_text", text: "I should read the file" }],
      encrypted_content: "enc-blob",
    });
    expect(input[2]).toMatchObject({ type: "function_call", call_id: "call_1" });
    expect(input[3]).toMatchObject({ type: "function_call_output", call_id: "call_1" });
  });

  test("drops thinking blocks whose signature is not a codex reasoning stash", () => {
    const out = anthropicToCodexRequest({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "anthropic-native thought", signature: "opaque-base64-not-json" },
            { type: "text", text: "hello" },
          ],
        },
      ],
    }, "gpt-5.2-codex");
    const input = out.input as Array<Record<string, unknown>>;
    expect(input).toHaveLength(1);
    expect(input[0]).toMatchObject({ type: "message", role: "assistant" });
  });

  test("maps thinking.budget_tokens onto reasoning effort tiers", () => {
    const base = { messages: [{ role: "user", content: "hi" }] };
    const effortOf = (budget_tokens: number) =>
      (anthropicToCodexRequest({ ...base, thinking: { type: "enabled", budget_tokens } }, "m")
        .reasoning as Record<string, unknown>).effort;
    expect(effortOf(4000)).toBe("low");      // "think"
    expect(effortOf(10000)).toBe("medium");  // "megathink"
    expect(effortOf(31999)).toBe("high");    // "ultrathink"
    // No thinking requested → leave effort to the server default.
    expect(anthropicToCodexRequest(base, "m").reasoning).toBeUndefined();
  });

  test("user image blocks become input_image parts (base64 and url sources)", () => {
    const out = anthropicToCodexRequest({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
            { type: "image", source: { type: "url", url: "https://x.test/pic.jpg" } },
          ],
        },
      ],
    }, "m");
    const input = out.input as Array<Record<string, unknown>>;
    expect(input).toHaveLength(1);
    const parts = input[0]!.content as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ type: "input_text", text: "what is this?" });
    expect(parts[1]).toEqual({ type: "input_image", image_url: "data:image/png;base64,AAAA" });
    expect(parts[2]).toEqual({ type: "input_image", image_url: "https://x.test/pic.jpg" });
  });

  test("tool_result image blocks are re-injected as a user input_image message", () => {
    const out = anthropicToCodexRequest({
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "screenshot", input: {} }] },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "c1",
            content: [
              { type: "text", text: "captured" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "BBBB" } },
            ],
          }],
        },
      ],
    }, "m");
    const input = out.input as Array<Record<string, unknown>>;
    expect(input[1]).toMatchObject({ type: "function_call_output", call_id: "c1", output: "captured" });
    // function_call_output.output is string-only on Codex, so the image rides
    // in a follow-up user message right after the tool output.
    expect(input[2]).toMatchObject({ type: "message", role: "user" });
    const parts = input[2]!.content as Array<Record<string, unknown>>;
    expect(parts).toContainEqual({ type: "input_image", image_url: "data:image/png;base64,BBBB" });
  });

  test("maps tool_use/tool_result round-trip", () => {
    const out = anthropicToCodexRequest({
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "read_file", input: { path: "a" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "file contents" }] },
      ],
    }, "gpt-5.2-codex");
    const input = out.input as Array<Record<string, unknown>>;
    expect(input[0]).toMatchObject({ type: "function_call", call_id: "tu_1", name: "read_file", arguments: '{"path":"a"}' });
    expect(input[1]).toMatchObject({ type: "function_call_output", call_id: "tu_1", output: "file contents" });
  });
});

describe("stripCodexThinking", () => {
  const stash = JSON.stringify({ id: "rs_1", encrypted_content: "enc" });

  test("removes codex-stashed and signature-less thinking blocks, keeps native ones", () => {
    const body = {
      model: "claude-sonnet-5",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "codex thought", signature: stash },
            { type: "thinking", thinking: "orphaned", }, // no signature: ours too
            { type: "thinking", thinking: "native", signature: "opaque-base64-sig" },
            { type: "text", text: "answer" },
          ],
        },
      ],
    };
    const out = stripCodexThinking(body) as typeof body;
    const content = out.messages[1]!.content as Array<Record<string, unknown>>;
    expect(content).toEqual([
      { type: "thinking", thinking: "native", signature: "opaque-base64-sig" },
      { type: "text", text: "answer" },
    ]);
    expect(out.model).toBe("claude-sonnet-5");
    // Input body is not mutated.
    expect((body.messages[1]!.content as unknown[]).length).toBe(4);
  });

  test("drops an assistant message emptied by stripping (interrupted codex turn)", () => {
    const out = stripCodexThinking({
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: stash }] },
        { role: "user", content: "continue" },
      ],
    }) as { messages: Array<Record<string, unknown>> };
    expect(out.messages).toHaveLength(2);
    expect(out.messages.map((m) => m.role)).toEqual(["user", "user"]);
  });

  test("returns non-object and thinking-free bodies unchanged", () => {
    expect(stripCodexThinking(null)).toBeNull();
    const clean = { messages: [{ role: "user", content: "hi" }], stream: true };
    expect(stripCodexThinking(clean)).toBe(clean);
  });
});

describe("CodexToAnthropicStream", () => {
  const ev = (event: string, data: unknown) => ({ event, data: JSON.stringify(data) });

  test("text turn produces well-formed Anthropic SSE sequence", () => {
    const s = new CodexToAnthropicStream("gpt");
    const frames = [
      ...s.handleEvent(ev("response.created", { response: { id: "r1" } })),
      ...s.handleEvent(ev("response.output_item.added", { item: { type: "message" } })),
      ...s.handleEvent(ev("response.output_text.delta", { delta: "Hel" })),
      ...s.handleEvent(ev("response.output_text.delta", { delta: "lo" })),
      ...s.handleEvent(ev("response.output_item.done", { item: { type: "message" } })),
      ...s.handleEvent(ev("response.completed", { response: { usage: { input_tokens: 10, output_tokens: 5 } } })),
      ...s.finish(),
    ];
    const types = frames.map((f) => parse(f).type);
    expect(types).toEqual([
      "message_start", "content_block_start", "content_block_delta",
      "content_block_delta", "content_block_stop", "message_delta", "message_stop",
    ]);
    expect(s.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    expect(s.stopReason).toBe("end_turn");
    const delta = frames.filter((f) => parse(f).type === "message_delta")[0]!;
    expect(parse(delta).delta.stop_reason).toBe("end_turn");
  });

  test("function call maps to tool_use block and stop_reason tool_use", () => {
    const s = new CodexToAnthropicStream("gpt");
    const frames = [
      ...s.handleEvent(ev("response.created", { response: { id: "r1" } })),
      ...s.handleEvent(ev("response.output_item.added", { item: { type: "function_call", call_id: "c1", name: "read_file" } })),
      ...s.handleEvent(ev("response.function_call_arguments.delta", { delta: '{"path":' })),
      ...s.handleEvent(ev("response.function_call_arguments.delta", { delta: '"a"}' })),
      ...s.handleEvent(ev("response.output_item.done", { item: { type: "function_call" } })),
      ...s.handleEvent(ev("response.completed", { response: { usage: { input_tokens: 1, output_tokens: 2 } } })),
      ...s.finish(),
    ];
    const start = frames.map(parse).find((d) => d.type === "content_block_start")!;
    expect(start.content_block).toMatchObject({ type: "tool_use", id: "c1", name: "read_file" });
    const deltas = frames.map(parse).filter((d) => d.type === "content_block_delta");
    expect(deltas.map((d) => d.delta.partial_json).join("")).toBe('{"path":"a"}');
    expect(s.stopReason).toBe("tool_use");
  });

  test("toAnthropicMessage folds structured state into a non-stream message (text)", () => {
    const s = new CodexToAnthropicStream("gpt");
    s.handleEvent(ev("response.created", { response: { id: "r1" } }));
    s.handleEvent(ev("response.output_item.added", { item: { type: "message" } }));
    s.handleEvent(ev("response.output_text.delta", { delta: "Hi" }));
    s.handleEvent(ev("response.output_item.done", { item: { type: "message" } }));
    s.handleEvent(ev("response.completed", { response: { usage: { input_tokens: 3, output_tokens: 1 } } }));
    s.finish();
    const msg = s.toAnthropicMessage();
    expect(msg).toMatchObject({
      id: "r1",
      type: "message", role: "assistant", model: "gpt",
      content: [{ type: "text", text: "Hi" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 1 },
    });
  });

  test("toAnthropicMessage parses tool_use input from accumulated function-call arguments", () => {
    const s = new CodexToAnthropicStream("gpt");
    s.handleEvent(ev("response.created", { response: { id: "r1" } }));
    s.handleEvent(ev("response.output_item.added", { item: { type: "function_call", call_id: "c1", name: "read_file" } }));
    s.handleEvent(ev("response.function_call_arguments.delta", { delta: '{"path":' }));
    s.handleEvent(ev("response.function_call_arguments.delta", { delta: '"a"}' }));
    s.handleEvent(ev("response.output_item.done", { item: { type: "function_call" } }));
    s.handleEvent(ev("response.completed", { response: { usage: { input_tokens: 1, output_tokens: 2 } } }));
    s.finish();
    const msg = s.toAnthropicMessage();
    expect(msg).toMatchObject({
      id: "r1",
      content: [{ type: "tool_use", id: "c1", name: "read_file", input: { path: "a" } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 2 },
    });
  });

  test("forceMessageStart emits an envelope, and the later response.created is a no-op", () => {
    const s = new CodexToAnthropicStream("gpt");
    const forced = s.forceMessageStart();
    expect(forced.map(parse).map((d) => d.type)).toEqual(["message_start"]);
    expect(parse(forced[0]!).message).toMatchObject({ type: "message", role: "assistant", model: "gpt" });

    // The real response.created must not emit a second message_start once forced.
    expect(s.handleEvent(ev("response.created", { response: { id: "r1" } }))).toEqual([]);

    // Content still flows normally after a forced start.
    const rest = [
      ...s.handleEvent(ev("response.output_item.added", { item: { type: "message" } })),
      ...s.handleEvent(ev("response.output_text.delta", { delta: "Hi" })),
      ...s.handleEvent(ev("response.output_item.done", { item: { type: "message" } })),
      ...s.finish(),
    ];
    expect(rest.map(parse).map((d) => d.type)).toEqual([
      "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop",
    ]);
  });

  test("forceMessageStart is a no-op once the stream has already started", () => {
    const s = new CodexToAnthropicStream("gpt");
    s.handleEvent(ev("response.created", { response: { id: "r1" } }));
    expect(s.forceMessageStart()).toEqual([]);
  });

  test("reasoning item becomes a thinking block carrying encrypted_content in its signature", () => {
    const s = new CodexToAnthropicStream("gpt");
    const frames = [
      ...s.handleEvent(ev("response.created", { response: { id: "r1" } })),
      ...s.handleEvent(ev("response.output_item.added", { item: { type: "reasoning", id: "rs_1" } })),
      ...s.handleEvent(ev("response.reasoning_summary_text.delta", { delta: "planning " })),
      ...s.handleEvent(ev("response.reasoning_summary_text.delta", { delta: "the read" })),
      ...s.handleEvent(ev("response.output_item.done", {
        item: { type: "reasoning", id: "rs_1", encrypted_content: "enc-blob", summary: [] },
      })),
      ...s.handleEvent(ev("response.output_item.added", { item: { type: "function_call", call_id: "c1", name: "read_file" } })),
      ...s.handleEvent(ev("response.function_call_arguments.delta", { delta: "{}" })),
      ...s.handleEvent(ev("response.output_item.done", { item: { type: "function_call" } })),
      ...s.handleEvent(ev("response.completed", { response: { usage: { input_tokens: 1, output_tokens: 2 } } })),
      ...s.finish(),
    ];
    const parsed = frames.map(parse);
    const start = parsed.find((d) => d.type === "content_block_start" && d.content_block.type === "thinking")!;
    expect(start.index).toBe(0);
    const thinkDeltas = parsed.filter((d) => d.type === "content_block_delta" && d.delta.type === "thinking_delta");
    expect(thinkDeltas.map((d) => d.delta.thinking).join("")).toBe("planning the read");
    const sig = parsed.find((d) => d.type === "content_block_delta" && d.delta.type === "signature_delta")!;
    expect(JSON.parse(sig.delta.signature)).toEqual({ id: "rs_1", encrypted_content: "enc-blob" });

    // Folded message carries the same thinking block, before the tool_use.
    const msg = s.toAnthropicMessage();
    const content = msg.content as Array<Record<string, unknown>>;
    expect(content[0]).toMatchObject({ type: "thinking", thinking: "planning the read" });
    expect(JSON.parse(content[0]!.signature as string)).toEqual({ id: "rs_1", encrypted_content: "enc-blob" });
    expect(content[1]).toMatchObject({ type: "tool_use", id: "c1" });
  });

  test("reasoning item without encrypted_content still closes cleanly with no signature", () => {
    const s = new CodexToAnthropicStream("gpt");
    s.handleEvent(ev("response.created", { response: { id: "r1" } }));
    s.handleEvent(ev("response.output_item.added", { item: { type: "reasoning", id: "rs_1" } }));
    s.handleEvent(ev("response.output_item.done", { item: { type: "reasoning", id: "rs_1" } }));
    s.handleEvent(ev("response.output_item.added", { item: { type: "message" } }));
    s.handleEvent(ev("response.output_text.delta", { delta: "Hi" }));
    s.handleEvent(ev("response.output_item.done", { item: { type: "message" } }));
    s.handleEvent(ev("response.completed", { response: { usage: { input_tokens: 1, output_tokens: 1 } } }));
    s.finish();
    const content = s.toAnthropicMessage().content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content[1]).toMatchObject({ type: "text", text: "Hi" });
  });

  test("incomplete response due to max_output_tokens maps to stop_reason max_tokens", () => {
    const s = new CodexToAnthropicStream("gpt");
    const frames = [
      ...s.handleEvent(ev("response.created", { response: { id: "r1" } })),
      ...s.handleEvent(ev("response.output_item.added", { item: { type: "message" } })),
      ...s.handleEvent(ev("response.output_text.delta", { delta: "truncat" })),
      ...s.handleEvent(ev("response.completed", {
        response: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          usage: { input_tokens: 5, output_tokens: 100 },
        },
      })),
      ...s.finish(),
    ];
    expect(s.stopReason).toBe("max_tokens");
    const delta = frames.map(parse).find((d) => d.type === "message_delta")!;
    expect(delta.delta.stop_reason).toBe("max_tokens");
  });

  test("non-empty malformed tool args surface as an error, not a silent {} tool call", () => {
    const s = new CodexToAnthropicStream("gpt");
    const frames = [
      ...s.handleEvent(ev("response.created", { response: { id: "r1" } })),
      ...s.handleEvent(ev("response.output_item.added", { item: { type: "function_call", call_id: "c1", name: "write_file" } })),
      ...s.handleEvent(ev("response.function_call_arguments.delta", { delta: '{"path":"a","content":"trunca' })),
      ...s.handleEvent(ev("response.output_item.done", { item: { type: "function_call" } })),
      ...s.finish(),
    ];
    const types = frames.map((f) => parse(f).type);
    expect(s.sawError).not.toBeNull();
    expect(types).toContain("error");
    // Terminal like other mid-stream errors: no clean-finish frames follow.
    expect(types).not.toContain("message_delta");
    expect(types).not.toContain("message_stop");
  });

  test("empty tool args still fold to {} without error", () => {
    const s = new CodexToAnthropicStream("gpt");
    s.handleEvent(ev("response.created", { response: { id: "r1" } }));
    s.handleEvent(ev("response.output_item.added", { item: { type: "function_call", call_id: "c1", name: "list" } }));
    s.handleEvent(ev("response.output_item.done", { item: { type: "function_call" } }));
    s.handleEvent(ev("response.completed", { response: { usage: { input_tokens: 1, output_tokens: 1 } } }));
    s.finish();
    expect(s.sawError).toBeNull();
    const content = s.toAnthropicMessage().content as Array<Record<string, unknown>>;
    expect(content[0]).toMatchObject({ type: "tool_use", input: {} });
  });

  test("cached input tokens surface as cache_read_input_tokens", () => {
    const s = new CodexToAnthropicStream("gpt");
    const frames = [
      ...s.handleEvent(ev("response.created", { response: { id: "r1" } })),
      ...s.handleEvent(ev("response.output_item.added", { item: { type: "message" } })),
      ...s.handleEvent(ev("response.output_text.delta", { delta: "Hi" })),
      ...s.handleEvent(ev("response.output_item.done", { item: { type: "message" } })),
      ...s.handleEvent(ev("response.completed", {
        response: { usage: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 80 } } },
      })),
      ...s.finish(),
    ];
    expect(s.usage.cache_read_input_tokens).toBe(80);
    const delta = frames.map(parse).find((d) => d.type === "message_delta")!;
    expect(delta.usage.cache_read_input_tokens).toBe(80);
    expect((s.toAnthropicMessage().usage as Record<string, unknown>).cache_read_input_tokens).toBe(80);
  });

  test("no events are translated after an upstream error (error is terminal for handleEvent)", () => {
    const s = new CodexToAnthropicStream("gpt");
    s.handleEvent(ev("response.created", { response: { id: "r1" } }));
    s.handleEvent(ev("error", { error: { code: "boom", message: "backend broke" } }));
    // Post-error items must not leak content frames after the error event.
    expect(s.handleEvent(ev("response.output_item.added", { item: { type: "message" } }))).toEqual([]);
    expect(s.handleEvent(ev("response.output_text.delta", { delta: "late" }))).toEqual([]);
  });

  test("stream ending mid-args: finish() emits the error frame and no clean close", () => {
    // Upstream disconnects while function_call arguments are still streaming —
    // finish() closes the dangling block, detects the truncated JSON, and must
    // NOT follow the error with message_delta/message_stop.
    const s = new CodexToAnthropicStream("gpt");
    s.handleEvent(ev("response.created", { response: { id: "r1" } }));
    s.handleEvent(ev("response.output_item.added", { item: { type: "function_call", call_id: "c1", name: "write_file" } }));
    s.handleEvent(ev("response.function_call_arguments.delta", { delta: '{"path":"a","content":"trun' }));
    const frames = s.finish();
    const types = frames.map((f) => parse(f).type);
    expect(s.sawError).not.toBeNull();
    expect(types).toContain("error");
    expect(types).not.toContain("message_delta");
    expect(types).not.toContain("message_stop");
  });

  test("args truncated by max_output_tokens fold to {} with stop_reason max_tokens, not an error", () => {
    // When the response is token-capped, truncated tool args are expected —
    // surface the Anthropic-native max_tokens stop instead of a terminal error.
    const s = new CodexToAnthropicStream("gpt");
    const frames = [
      ...s.handleEvent(ev("response.created", { response: { id: "r1" } })),
      ...s.handleEvent(ev("response.output_item.added", { item: { type: "function_call", call_id: "c1", name: "write_file" } })),
      ...s.handleEvent(ev("response.function_call_arguments.delta", { delta: '{"path":"a","content":"trun' })),
      ...s.handleEvent(ev("response.output_item.done", { item: { type: "function_call" } })),
      ...s.handleEvent(ev("response.completed", {
        response: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          usage: { input_tokens: 5, output_tokens: 100 },
        },
      })),
      ...s.finish(),
    ];
    const types = frames.map((f) => parse(f).type);
    expect(s.sawError).toBeNull();
    expect(types).not.toContain("error");
    expect(s.stopReason).toBe("max_tokens");
    expect(types).toContain("message_stop");
  });

  test("response.incomplete terminal event maps like completed-with-incomplete-status", () => {
    const s = new CodexToAnthropicStream("gpt");
    s.handleEvent(ev("response.created", { response: { id: "r1" } }));
    s.handleEvent(ev("response.output_item.added", { item: { type: "message" } }));
    s.handleEvent(ev("response.output_text.delta", { delta: "partial" }));
    s.handleEvent(ev("response.incomplete", {
      response: {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        usage: { input_tokens: 2, output_tokens: 50 },
      },
    }));
    s.finish();
    expect(s.stopReason).toBe("max_tokens");
    expect(s.usage.output_tokens).toBe(50);
  });

  test("content_filter incompleteness maps to stop_reason refusal, not a clean finish", () => {
    const s = new CodexToAnthropicStream("gpt");
    s.handleEvent(ev("response.created", { response: { id: "r1" } }));
    s.handleEvent(ev("response.output_item.added", { item: { type: "message" } }));
    s.handleEvent(ev("response.output_item.done", { item: { type: "message" } }));
    s.handleEvent(ev("response.completed", {
      response: { status: "incomplete", incomplete_details: { reason: "content_filter" }, usage: {} },
    }));
    s.finish();
    expect(s.stopReason).toBe("refusal");
  });

  test("mid-stream error is terminal: no message_delta/message_stop follow it", () => {
    const s = new CodexToAnthropicStream("gpt");
    const frames = [
      ...s.handleEvent(ev("response.created", { response: { id: "r1" } })),
      ...s.handleEvent(ev("response.output_item.added", { item: { type: "message" } })),
      ...s.handleEvent(ev("response.output_text.delta", { delta: "Hel" })),
      ...s.handleEvent(ev("response.failed", { response: { error: { code: "boom", message: "backend broke" } } })),
      ...s.finish(),
    ];
    const types = frames.map((f) => parse(f).type);
    expect(types.filter((t) => t === "error")).toHaveLength(1);
    expect(types).not.toContain("message_stop");
    expect(types).not.toContain("message_delta");
  });
});

describe("deriveEffortTier", () => {
  test("output_config.effort wins over thinking budget", () => {
    expect(
      deriveEffortTier({ output_config: { effort: "xhigh" }, thinking: { type: "enabled", budget_tokens: 4000 } }),
    ).toBe("xhigh");
    expect(deriveEffortTier({ output_config: { effort: "max" } })).toBe("max");
  });

  test("legacy budget buckets when effort absent", () => {
    expect(deriveEffortTier({ thinking: { type: "enabled", budget_tokens: 4000 } })).toBe("low");
    expect(deriveEffortTier({ thinking: { type: "enabled", budget_tokens: 10000 } })).toBe("medium");
    expect(deriveEffortTier({ thinking: { type: "enabled", budget_tokens: 20000 } })).toBe("high");
    expect(deriveEffortTier({ thinking: { type: "enabled", budget_tokens: 32768 } })).toBe("xhigh");
  });

  test("bucket boundaries land in the higher tier (< is exclusive on the lower bound)", () => {
    expect(deriveEffortTier({ thinking: { type: "enabled", budget_tokens: 8192 } })).toBe("medium");
    expect(deriveEffortTier({ thinking: { type: "enabled", budget_tokens: 16384 } })).toBe("high");
  });

  test("no signal and junk values yield default", () => {
    expect(deriveEffortTier({})).toBe("default");
    expect(deriveEffortTier({ output_config: { effort: "ultra" } })).toBe("default");
  });
});

describe("codexEffortFor", () => {
  test("explicit mapping entry wins", () => {
    expect(codexEffortFor("medium", { medium: "high" })).toBe("high");
    expect(codexEffortFor("default", { default: "low" })).toBe("low");
  });
  test("pass-through defaults: tiers map 1:1, default stays unset", () => {
    expect(codexEffortFor("low")).toBe("low");
    expect(codexEffortFor("max")).toBe("max");
    expect(codexEffortFor("default")).toBeUndefined();
  });
});

describe("clampEffortForModel", () => {
  test("only gpt-5.6* keeps max; every earlier model clamps to xhigh", () => {
    expect(clampEffortForModel("max", "gpt-5.6-sol")).toBe("max");
    expect(clampEffortForModel("max", "gpt-5.6-luna")).toBe("max");
    // gpt-5.5, gpt-5.4, and gpt-5.4-mini all top out at xhigh (no max).
    expect(clampEffortForModel("max", "gpt-5.5")).toBe("xhigh");
    expect(clampEffortForModel("max", "gpt-5.4")).toBe("xhigh");
    expect(clampEffortForModel("max", "gpt-5.4-mini")).toBe("xhigh");
    // Non-max efforts and undefined pass through untouched on any model.
    expect(clampEffortForModel("high", "gpt-5.4-mini")).toBe("high");
    expect(clampEffortForModel(undefined, "gpt-5.4")).toBeUndefined();
  });
});

describe("anthropicToCodexRequest reasoning.effort", () => {
  const msg = { messages: [{ role: "user", content: "hi" }] };
  test("output_config.effort flows through with mapping override", () => {
    const out = anthropicToCodexRequest({ ...msg, output_config: { effort: "medium" } }, "gpt-5.6-sol", { medium: "high" });
    expect(out.reasoning).toEqual({ effort: "high" });
  });
  test("no effort signal leaves reasoning unset", () => {
    const out = anthropicToCodexRequest({ ...msg }, "gpt-5.6-sol");
    expect(out.reasoning).toBeUndefined();
  });
  test("legacy thinking budget still buckets (existing behavior preserved)", () => {
    const out = anthropicToCodexRequest({ ...msg, thinking: { type: "enabled", budget_tokens: 10000 } }, "gpt-5.6-sol");
    expect(out.reasoning).toEqual({ effort: "medium" });
  });
  test("mapping override applies before the per-model clamp: high->max, clamped to xhigh on gpt-5.5", () => {
    const out = anthropicToCodexRequest(
      { ...msg, output_config: { effort: "high" } },
      "gpt-5.5",
      { high: "max" },
    );
    expect(out.reasoning).toEqual({ effort: "xhigh" });
  });
  test("pass-through max on the default haiku->gpt-5.4-mini target clamps to xhigh (5.4-mini has no max)", () => {
    // No effort map: source tier "max" passes through 1:1, then the per-model
    // clamp saves it from a 400 on a model that tops out at xhigh.
    const out = anthropicToCodexRequest({ ...msg, output_config: { effort: "max" } }, "gpt-5.4-mini");
    expect(out.reasoning).toEqual({ effort: "xhigh" });
  });
});
