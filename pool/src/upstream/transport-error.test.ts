import { describe, expect, test } from "bun:test";
import { UpstreamTransportError } from "./transport-error.ts";

describe("UpstreamTransportError", () => {
  test("includes a safe reset code and the headers phase", () => {
    const cause = Object.assign(new Error("socket reset"), {
      code: "ECONNRESET",
      headers: { authorization: "secret" },
    });

    const error = new UpstreamTransportError(cause, "headers");

    expect(error.message).toContain("ECONNRESET");
    expect(error.message).toContain("headers");
    expect(error.message).not.toContain("secret");
    expect(error.cause).toBe(cause);
  });

  test("finds a safe code in a bounded nested cause chain", () => {
    const root = Object.assign(new Error("connection closed"), { code: "ECONNRESET" });
    const error = new UpstreamTransportError(new Error("fetch failed", { cause: root }), "body");

    expect(error.message).toContain("body");
    expect(error.message).toContain("ECONNRESET");
    expect(error.cause).toBeInstanceOf(Error);
  });

  test("does not serialize non-Error values", () => {
    const cause = { name: "SocketFault", code: "ECONNRESET", body: "secret", headers: { authorization: "secret" } };
    const error = new UpstreamTransportError(cause, "body");

    expect(error.message).toContain("body");
    expect(error.message).toContain("ECONNRESET");
    expect(error.message).not.toContain("secret");
    expect(error.message).not.toContain("SocketFault");
    expect(error.cause).toBe(cause);
  });
});
