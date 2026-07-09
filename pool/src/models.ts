/** Model-id → provider routing table, persisted at <poolDir>/models.json. */
import { existsSync, readFileSync, writeFileSync } from "fs";
import type { Provider } from "./accounts/types.ts";
import type { AccountManager } from "./accounts/manager.ts";

export interface ModelRoute {
  id: string;
  provider: Provider;
  upstreamModel: string;
}

const claude = (id: string): ModelRoute => ({ id, provider: "anthropic", upstreamModel: id });
const openai = (id: string): ModelRoute => ({ id, provider: "openai", upstreamModel: id });

export const DEFAULT_MODEL_TABLE: ModelRoute[] = [
  claude("opus"), claude("sonnet"), claude("haiku"), claude("fable"),
  claude("claude-opus-4-8"), claude("claude-sonnet-5"), claude("claude-haiku-4-5"), claude("claude-fable-5"),
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

/**
 * Refreshes the `openai` entries in `table` from an authenticated OpenAI
 * (ChatGPT-subscription) account, if one exists. There is no documented Codex
 * Responses-API model-listing endpoint in the open-source Codex CLI (verified
 * during Task 1/8 research — codex-rs has no `GET .../models` call in its
 * client), so this currently keeps the existing `openai` entries unchanged and
 * prints a notice; it's structured so a real endpoint can be wired in later
 * without changing the `models update` CLI contract.
 */
export async function updateOpenAIModels(mgr: AccountManager, table: ModelRoute[]): Promise<ModelRoute[]> {
  const names = mgr.listNames().filter((n) => mgr.providerFor(n) === "openai");
  const account = names.find((n) => mgr.getOpenAICreds(n)?.accessToken);
  if (!account) {
    console.log("No authenticated OpenAI account found — skipping models update.");
    return table;
  }
  console.log(
    "Codex has no documented model-list endpoint; keeping existing openai entries. " +
      "Edit models.json manually to add/remove OpenAI model ids.",
  );
  return table;
}

function isModelRoute(v: unknown): v is ModelRoute {
  const o = v as Record<string, unknown>;
  return (
    v != null && typeof o.id === "string" && typeof o.upstreamModel === "string" &&
    (o.provider === "anthropic" || o.provider === "openai")
  );
}
