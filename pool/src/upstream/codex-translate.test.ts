import { describe, expect, test } from "bun:test";
import { anthropicToCodexRequest, CodexToAnthropicStream, collectAnthropicMessage } from "./codex-translate.ts";

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

  test("collectAnthropicMessage folds frames into a non-stream message", () => {
    const s = new CodexToAnthropicStream("gpt");
    const frames = [
      ...s.handleEvent(ev("response.created", { response: { id: "r1" } })),
      ...s.handleEvent(ev("response.output_item.added", { item: { type: "message" } })),
      ...s.handleEvent(ev("response.output_text.delta", { delta: "Hi" })),
      ...s.handleEvent(ev("response.output_item.done", { item: { type: "message" } })),
      ...s.handleEvent(ev("response.completed", { response: { usage: { input_tokens: 3, output_tokens: 1 } } })),
      ...s.finish(),
    ];
    const msg = collectAnthropicMessage(frames);
    expect(msg).toMatchObject({
      type: "message", role: "assistant",
      content: [{ type: "text", text: "Hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 1 },
    });
  });
});
