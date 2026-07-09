import { describe, expect, test } from "bun:test";
import { SseParser } from "./shared.ts";

describe("SseParser", () => {
  test("parses events split across chunks and across lines", () => {
    const events: { event: string; data: string }[] = [];
    const parser = new SseParser((e) => events.push(e));
    parser.push(new TextEncoder().encode("event: message_start\ndata: {\"a\":1}\n"));
    parser.push(new TextEncoder().encode("\n"));
    expect(events).toEqual([{ event: "message_start", data: '{"a":1}' }]);
  });

  test("throws instead of buffering forever when a single line never terminates", () => {
    const parser = new SseParser(() => {}, 1024);
    const chunk = new TextEncoder().encode("data: " + "x".repeat(2048));
    expect(() => parser.push(chunk)).toThrow(/exceeded/);
  });

  test("a legitimately long line under the cap is buffered fine until its newline arrives", () => {
    const events: { event: string; data: string }[] = [];
    const parser = new SseParser((e) => events.push(e), 1024);
    const longValue = "x".repeat(900);
    parser.push(new TextEncoder().encode(`data: ${longValue}`));
    parser.push(new TextEncoder().encode("\n\n"));
    expect(events).toEqual([{ event: "message", data: longValue }]);
  });
});
