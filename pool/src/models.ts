/** Model-id → provider routing table, persisted at <poolDir>/models.json. */
import { existsSync, readFileSync, writeFileSync } from "fs";
import type { Provider } from "./accounts/types.ts";

export interface ModelRoute {
  id: string;
  provider: Provider;
  upstreamModel: string;
}

const claude = (id: string): ModelRoute => ({ id, provider: "anthropic", upstreamModel: id });
const openai = (id: string): ModelRoute => ({ id, provider: "openai", upstreamModel: id });

export const DEFAULT_MODEL_TABLE: ModelRoute[] = [
  claude("opus"), claude("sonnet"), claude("haiku"),
  claude("claude-opus-4-8"), claude("claude-sonnet-5"), claude("claude-haiku-4-5"),
  openai("gpt-5.2-codex"), openai("gpt-5.1-codex-max"),
];

export function loadModelTable(modelsFile: string): ModelRoute[] {
  let fromFile: ModelRoute[] = [];
  if (existsSync(modelsFile)) {
    try {
      const parsed = JSON.parse(readFileSync(modelsFile, "utf8")) as { models?: unknown };
      if (Array.isArray(parsed.models)) {
        fromFile = parsed.models.filter(isModelRoute);
      }
    } catch {
      // fall through to defaults
    }
  }
  const ids = new Set(fromFile.map((m) => m.id));
  return [...DEFAULT_MODEL_TABLE.filter((m) => !ids.has(m.id)), ...fromFile];
}

export function saveModelTable(modelsFile: string, models: ModelRoute[]): void {
  writeFileSync(modelsFile, JSON.stringify({ models }, null, 2));
}

export function resolveModel(table: ModelRoute[], modelId: string): ModelRoute {
  return (
    table.find((m) => m.id === modelId) ??
    { id: modelId, provider: "anthropic", upstreamModel: modelId }
  );
}

function isModelRoute(v: unknown): v is ModelRoute {
  const o = v as Record<string, unknown>;
  return (
    v != null && typeof o.id === "string" && typeof o.upstreamModel === "string" &&
    (o.provider === "anthropic" || o.provider === "openai")
  );
}
