import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { validatedOAuthOrigin } from "../src/auth/env.js";

const origin = "https://serviteur-mcp.example.org";
function configuration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    OAUTH_KV: { get: async () => null, put: async () => {} },
    MCP_PUBLIC_ORIGIN: origin,
    ALLOWED_GITHUB_IDS: "11,22,33,44",
    GITHUB_CLIENT_ID: "client-placeholder",
    GITHUB_CLIENT_SECRET: "secret-placeholder",
    ...overrides,
  };
}

describe("OAuth deployment configuration adversarial boundary", () => {
  it("accepts only the exact configured public HTTPS origin", () => {
    expect(validatedOAuthOrigin(configuration(), new Request(origin + "/mcp"))).toBe(origin);
    expect(
      validatedOAuthOrigin(
        configuration(),
        new Request("https://other.example.org/mcp", {
          headers: { "X-Forwarded-Host": "serviteur-mcp.example.org" },
        }),
      ),
    ).toBeNull();
  });

  it.each([
    { MCP_PUBLIC_ORIGIN: "http://serviteur-mcp.example.org" },
    { MCP_PUBLIC_ORIGIN: "https://serviteur-mcp.example.org/authorize" },
    { MCP_PUBLIC_ORIGIN: "https://serviteur-mcp.example.org/?debug=true" },
    { ALLOWED_GITHUB_IDS: "11,11" },
    { ALLOWED_GITHUB_IDS: "11,22,33,44,55" },
    { OAUTH_KV: {} },
    { GITHUB_CLIENT_SECRET: "" },
    { GITHUB_CLIENT_ID: "" },
  ])("refuses incomplete or unsafe deployment bindings %j", (change) => {
    expect(validatedOAuthOrigin(configuration(change), new Request(origin + "/mcp"))).toBeNull();
  });

  it("four forged staff requests never activate OAuth without a verified runtime context", async () => {
    const ids = ["11", "22", "33", "44"];
    const responses = await Promise.all(
      ids.map((id) =>
        worker.fetch(
          new Request(origin + "/mcp", {
            method: "POST",
            headers: { "X-User": id, Authorization: "Bearer forged-" + id },
            body: "{}",
          }),
        ),
      ),
    );
    expect(responses.map((x) => x.status)).toEqual([503, 503, 503, 503]);
    for (const response of responses) {
      expect(await response.json()).toEqual({ code: "AUTH_NOT_CONFIGURED" });
    }
  });
});
