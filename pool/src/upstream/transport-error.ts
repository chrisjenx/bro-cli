export type UpstreamTransportPhase = "headers" | "body";

const MAX_CAUSE_DEPTH = 3;
const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.-]{0,80}$/;

function property(value: object, key: string): unknown {
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function identifier(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_IDENTIFIER.test(value) ? value : undefined;
}

function diagnostic(cause: unknown, phase: UpstreamTransportPhase): string {
  const details: string[] = [];
  let current = cause;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null && typeof current === "object"; depth += 1) {
    const code = identifier(property(current, "code"));
    if (code) details.push(code);
    if (current instanceof Error) {
      const name = identifier(current.name);
      if (!code && name && name !== "Error") details.push(name);
      if (current.message) details.push(current.message);
    }
    current = property(current, "cause");
  }

  return `Upstream transport failure during ${phase}${details.length ? `: ${details.join("; ")}` : ""}`;
}

export class UpstreamTransportError extends Error {
  constructor(cause: unknown, phase: UpstreamTransportPhase) {
    super(diagnostic(cause, phase), { cause });
    this.name = "UpstreamTransportError";
  }
}
