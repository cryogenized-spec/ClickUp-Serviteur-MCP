import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthEnv } from "../src/auth/env.js";
import { handleOAuthRequest } from "../src/auth/oauth-runtime.js";

const captures = vi.hoisted(() => ({
  requests: [] as { url: string; options: unknown }[],
  providerSettings: [] as {
    requiredScopes: readonly string[] | undefined;
    scopesSupported: readonly string[] | undefined;
  }[],
}));

vi.mock("../src/mcp/handler.js", () => ({
  createProtocolHandler: () => ({
    fetch: async (request: Request, options?: unknown): Promise<Response> => {
      captures.requests.push({ url: request.url, options });
      return Response.json({ accepted: true });
    },
  }),
}));

// Faithfully enforce the pinned OAuthProvider v1.2.3 constructor's
// requiredScopes vs deprecated resourceMetadata.scopes_supported conflict.
// The fake only supplies already-validated ctx.auth for the handler boundary.
vi.mock("@cloudflare/workers-oauth-provider", () => ({
  OAuthProvider: class {
    private readonly config: {
      requiredScopes?: readonly string[];
      scopesSupported?: readonly string[];
      resourceMetadata?: { scopes_supported?: readonly string[] };
      apiHandler: {
        fetch: (request: Request, env: OAuthEnv, context: unknown) => Promise<Response>;
      };
    };

    constructor(config: {
      requiredScopes?: readonly string[];
      scopesSupported?: readonly string[];
      resourceMetadata?: { scopes_supported?: readonly string[] };
      apiHandler: {
        fetch: (request: Request, env: OAuthEnv, context: unknown) => Promise<Response>;
      };
    }) {
      if (
        config.requiredScopes !== undefined &&
        config.resourceMetadata?.scopes_supported !== undefined
      ) {
        throw new Error("Cannot configure both requiredScopes and scopes_supported");
      }
      captures.providerSettings.push({
        requiredScopes: config.requiredScopes,
        scopesSupported: config.scopesSupported,
      });
      this.config = config;
    }

    fetch(request: Request, env: OAuthEnv, context: unknown): Promise<Response> {
      return this.config.apiHandler.fetch(request, env, context);
    }
  },
  AuthorizationError: class extends Error {},
  CimdFetchError: class extends Error {},
  authorizationErrorRedirect: () => "https://client.invalid/rejected",
}));

const origin = "https://mcp.example.com";
const env = { ALLOWED_GITHUB_IDS: "11,22,33,44" } as OAuthEnv;

type TestContext = Parameters<typeof handleOAuthRequest>[2] & {
  props: { userId: string };
  auth: {
    userId: string;
    token: string;
    clientId: string;
    scope: string[];
    audience: string;
    expiresAt: number;
  };
};

function verifiedContext(id: string, overrides: Record<string, unknown> = {}): TestContext {
  return {
    props: { userId: "github:" + id },
    auth: {
      userId: "github_" + id,
      token: "secret-token-" + id,
      clientId: "client-" + id,
      scope: ["mcp:read"],
      audience: origin + "/mcp",
      expiresAt: 1990000000,
      ...overrides,
    },
  } as unknown as TestContext;
}

describe("Codex P1 OAuth integration regressions", () => {
  beforeEach(() => {
    captures.requests.length = 0;
    captures.providerSettings.length = 0;
  });

  it("advertises only read as the baseline, and write as a supported opt-in", async () => {
    await handleOAuthRequest(
      new Request(origin + "/mcp", { method: "POST" }),
      env,
      verifiedContext("11"),
      origin,
    );
    expect(captures.providerSettings).toEqual([
      {
        requiredScopes: ["mcp:read"],
        scopesSupported: ["mcp:read", "mcp:write"],
      },
    ]);
  });

  it("advertises read-only scopes on the isolated company Worker", async () => {
    await handleOAuthRequest(
      new Request(origin + "/mcp", { method: "POST" }),
      { ...env, CLICKUP_COMPANY_READ_ONLY: "true" },
      verifiedContext("11"),
      origin,
    );
    expect(captures.providerSettings).toEqual([
      {
        requiredScopes: ["mcp:read"],
        scopesSupported: ["mcp:read"],
      },
    ]);
  });

  it("advertises read and write as separately consented scopes on the non-destructive company profile", async () => {
    await handleOAuthRequest(
      new Request(origin + "/mcp", { method: "POST" }),
      {
        ...env,
        CLICKUP_COMPANY_PROFILE: "true",
        CLICKUP_COMPANY_WRITE_MODE: "non_destructive",
      },
      verifiedContext("11"),
      origin,
    );
    expect(captures.providerSettings).toEqual([
      {
        requiredScopes: ["mcp:read"],
        scopesSupported: ["mcp:read", "mcp:write"],
      },
    ]);
  });

  it("constructs the pinned OAuth provider without conflicting resource scope settings", async () => {
    const response = await handleOAuthRequest(
      new Request(origin + "/mcp", { method: "POST" }),
      env,
      verifiedContext("11"),
      origin,
    );
    expect(response.status).toBe(200);
  });

  it("forwards the verified human principal and token facts to the MCP SDK request", async () => {
    await handleOAuthRequest(
      new Request(origin + "/mcp", {
        method: "POST",
        headers: { "X-User": "github:99", "X-Forwarded-User": "github:99" },
      }),
      env,
      verifiedContext("22"),
      origin,
    );
    expect(captures.requests).toHaveLength(1);
    expect(captures.requests[0]?.options).toEqual({
      authInfo: expect.objectContaining({
        token: "secret-token-22",
        clientId: "client-22",
        scopes: ["mcp:read"],
        expiresAt: 1990000000,
        resource: new URL(origin + "/mcp"),
        extra: expect.objectContaining({ subject: "github:22", githubId: "22" }),
      }),
    });
  });

  it("forwards a separately authorized write scope without accepting spoofed headers", async () => {
    const response = await handleOAuthRequest(
      new Request(origin + "/mcp", { method: "POST", headers: { "X-User": "github:99" } }),
      env,
      verifiedContext("11", { scope: ["mcp:read", "mcp:write"] }),
      origin,
    );
    expect(response.status).toBe(200);
    expect(captures.requests[0]?.options).toEqual({
      authInfo: expect.objectContaining({ scopes: ["mcp:read", "mcp:write"] }),
    });
  });

  it("forwards four concurrent staff requests with distinct verified identities", async () => {
    await Promise.all(
      ["11", "22", "33", "44"].map((id) =>
        handleOAuthRequest(
          new Request(origin + "/mcp", { method: "POST" }),
          env,
          verifiedContext(id),
          origin,
        ),
      ),
    );
    expect(captures.requests).toHaveLength(4);
    expect(
      captures.requests.map(
        ({ options }) =>
          (options as { authInfo?: { extra?: { subject?: string } } })?.authInfo?.extra?.subject,
      ),
    ).toEqual(["github:11", "github:22", "github:33", "github:44"]);
  });

  it.each([
    ["wrong audience", { audience: origin + "/other" }],
    ["untrusted issuer host", { audience: "https://impostor.example/mcp" }],
    ["missing access token", { token: "" }],
    ["missing client ID", { clientId: "" }],
    ["invalid token expiry", { expiresAt: Number.NaN }],
    ["infinite token expiry", { expiresAt: Number.POSITIVE_INFINITY }],
    ["string token expiry", { expiresAt: "1990000000" }],
    ["missing read scope", { scope: [] }],
    ["unexpected scopes", { scope: ["mcp:read", "admin"] }],
    ["duplicate read scope", { scope: ["mcp:read", "mcp:read"] }],
    ["non-string scope", { scope: ["mcp:read", 1] }],
    ["incorrect token identity", { userId: "github_44" }],
  ])("rejects %s before dispatching an MCP request", async (_name, overrides) => {
    const response = await handleOAuthRequest(
      new Request(origin + "/mcp", { method: "POST" }),
      env,
      verifiedContext("11", overrides),
      origin,
    );
    expect(response.status).toBe(403);
    expect(captures.requests).toHaveLength(0);
    expect(await response.text()).toBe("Forbidden");
  });

  it("enforces a changed allowlist for an existing authenticated context", async () => {
    const request = () => new Request(origin + "/mcp", { method: "POST" });
    const previouslyAuthorized = verifiedContext("22");
    const accepted = await handleOAuthRequest(request(), env, previouslyAuthorized, origin);
    expect(accepted.status).toBe(200);
    const revokedEnv = { ...env, ALLOWED_GITHUB_IDS: "11,33,44" } as OAuthEnv;
    const rejected = await handleOAuthRequest(request(), revokedEnv, previouslyAuthorized, origin);
    expect(rejected.status).toBe(403);
    expect(captures.requests).toHaveLength(1);
    const retained = await handleOAuthRequest(request(), revokedEnv, verifiedContext("11"), origin);
    expect(retained.status).toBe(200);
    expect(captures.requests).toHaveLength(2);
  });

  it("rejects expired provider token facts even for an allowlisted staff member", async () => {
    const response = await handleOAuthRequest(
      new Request(origin + "/mcp", { method: "POST" }),
      env,
      verifiedContext("11", { expiresAt: 1 }),
      origin,
    );
    expect(response.status).toBe(403);
    expect(captures.requests).toHaveLength(0);
  });

  it("denies unallowlisted and mismatched principal before calling the SDK", async () => {
    const outsider = await handleOAuthRequest(
      new Request(origin + "/mcp", { method: "POST" }),
      env,
      verifiedContext("99"),
      origin,
    );
    const mixed = await handleOAuthRequest(
      new Request(origin + "/mcp", { method: "POST" }),
      env,
      { ...verifiedContext("22"), props: { userId: "github:11" } },
      origin,
    );
    expect([outsider.status, mixed.status]).toEqual([403, 403]);
    expect(captures.requests).toHaveLength(0);
  });
});
