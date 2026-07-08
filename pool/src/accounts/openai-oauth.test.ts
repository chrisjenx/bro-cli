import { describe, expect, test } from "bun:test";
import { normalizeCodexAuthJson, refreshOpenAIToken } from "./openai-oauth.ts";

describe("normalizeCodexAuthJson", () => {
  test("maps the Codex CLI auth.json token block", () => {
    const creds = normalizeCodexAuthJson({
      tokens: { access_token: "at1", refresh_token: "rt1", account_id: "acc_1" },
      last_refresh: "2026-07-08T00:00:00Z",
    });
    expect(creds).toEqual(
      expect.objectContaining({ accessToken: "at1", refreshToken: "rt1", accountId: "acc_1" }),
    );
  });

  test("returns null when there is no access token", () => {
    expect(normalizeCodexAuthJson({})).toBeNull();
    expect(normalizeCodexAuthJson(null)).toBeNull();
  });

  test("derives accountId and planType from id_token claims when tokens.account_id is absent (browser login)", () => {
    const payload = {
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acc_from_jwt",
        chatgpt_plan_type: "pro",
      },
    };
    const idToken = `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
    const creds = normalizeCodexAuthJson({
      tokens: { access_token: "at1", refresh_token: "rt1", id_token: idToken },
    });
    expect(creds).toEqual(
      expect.objectContaining({
        accessToken: "at1",
        refreshToken: "rt1",
        accountId: "acc_from_jwt",
        planType: "pro",
      }),
    );
  });

  test("bare tokens.account_id still wins over id_token claims", () => {
    const payload = {
      "https://api.openai.com/auth": { chatgpt_account_id: "acc_from_jwt", chatgpt_plan_type: "pro" },
    };
    const idToken = `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
    const creds = normalizeCodexAuthJson({
      tokens: { access_token: "at1", account_id: "acc_bare", id_token: idToken },
    });
    expect(creds).toEqual(expect.objectContaining({ accountId: "acc_bare" }));
  });
});

describe("refreshOpenAIToken", () => {
  test("posts refresh_token grant and returns rotated creds", async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    const fakeFetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      captured = { url: String(url), body: JSON.parse(String(init?.body)) };
      return new Response(
        JSON.stringify({ access_token: "at2", refresh_token: "rt2", expires_in: 3600 }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const next = await refreshOpenAIToken(
      { accessToken: "at1", refreshToken: "rt1", accountId: "acc_1" },
      fakeFetch,
    );
    expect(captured!.body.grant_type).toBe("refresh_token");
    expect(captured!.body.refresh_token).toBe("rt1");
    expect(next.accessToken).toBe("at2");
    expect(next.refreshToken).toBe("rt2");
    expect(next.accountId).toBe("acc_1"); // preserved
    expect(next.expiresAt).toBeGreaterThan(Date.now());
  });

  test("throws on non-2xx", async () => {
    const fakeFetch = (async () => new Response("nope", { status: 400 })) as unknown as typeof fetch;
    await expect(refreshOpenAIToken({ refreshToken: "rt1" }, fakeFetch)).rejects.toThrow();
  });
});
