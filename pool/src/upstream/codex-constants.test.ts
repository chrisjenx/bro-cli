import { afterEach, expect, test } from "bun:test";
import { codexApiBaseUrl, codexModelsUrl, codexResponsesUrl, codexTokenUrl } from "./codex-constants.ts";

const saved = { base: process.env.CODEX_API_BASE_URL, token: process.env.OPENAI_OAUTH_TOKEN_URL };
afterEach(() => {
  for (const [key, value] of [["CODEX_API_BASE_URL", saved.base], ["OPENAI_OAUTH_TOKEN_URL", saved.token]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test("codex base url defaults to the chatgpt backend when unset or empty", () => {
  delete process.env.CODEX_API_BASE_URL;
  expect(codexApiBaseUrl()).toBe("https://chatgpt.com/backend-api/codex");
  expect(codexResponsesUrl()).toBe("https://chatgpt.com/backend-api/codex/responses");
  expect(codexModelsUrl()).toBe("https://chatgpt.com/backend-api/codex/models?client_version=0.200.0");
  process.env.CODEX_API_BASE_URL = "";
  expect(codexApiBaseUrl()).toBe("https://chatgpt.com/backend-api/codex");
});

test("codex base url honors env override", () => {
  process.env.CODEX_API_BASE_URL = "http://127.0.0.1:9999/fake/codex/";
  expect(codexApiBaseUrl()).toBe("http://127.0.0.1:9999/fake/codex");
  expect(codexResponsesUrl()).toBe("http://127.0.0.1:9999/fake/codex/responses");
  expect(codexModelsUrl()).toBe("http://127.0.0.1:9999/fake/codex/models?client_version=0.200.0");
});

test("oauth token url defaults to auth.openai.com when unset or empty", () => {
  delete process.env.OPENAI_OAUTH_TOKEN_URL;
  expect(codexTokenUrl()).toBe("https://auth.openai.com/oauth/token");
  process.env.OPENAI_OAUTH_TOKEN_URL = "";
  expect(codexTokenUrl()).toBe("https://auth.openai.com/oauth/token");
});

test("oauth token url honors env override", () => {
  process.env.OPENAI_OAUTH_TOKEN_URL = "http://127.0.0.1:9999/fake/oauth/token";
  expect(codexTokenUrl()).toBe("http://127.0.0.1:9999/fake/oauth/token");
});
