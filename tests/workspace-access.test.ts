import { describe, expect, it } from "vitest";
import { requireReadGrant } from "../src/clickup/policy.js";
import {
  clickUpConnectionStatus,
  setClickUpWorkspaceAccess,
} from "../src/clickup/per-user-oauth.js";

const oauthKey = btoa(String.fromCharCode(...new Uint8Array(32)));
const auth = (id: string, write = true) => ({
  scopes: write ? ["mcp:read", "mcp:write"] : ["mcp:read"],
  extra: { subject: "github:" + id },
});
function testRig() {
  const flags = new Map<string, { enabled: boolean; exclusive: boolean }>([
    ["github:11", { enabled: false, exclusive: true }],
    ["github:22", { enabled: false, exclusive: true }],
  ]);
  const calls: string[] = [];
  const bindings = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      fetch: async (request: Request) => {
        const body = (await request.json()) as Record<string, unknown>;
        const subject = String(body["subject"]);
        const state = flags.get(subject);
        const endpoint = new URL(request.url).pathname;
        calls.push(subject + endpoint);
        if (name !== "staff-clickup:" + subject || !state)
          return new Response(null, { status: 403 });
        const clickupUserId = subject === "github:11" ? "707" : "809";
        if (endpoint === "/credential")
          return Response.json({
            connected: true,
            clickupUserId,
            workspaceId: "555",
            accessToken: "a-dummy-OAuth-token",
            workspaceExclusive: state.exclusive,
            workspaceEnabled: state.enabled,
          });
        if (endpoint === "/status")
          return Response.json({
            connected: true,
            clickupUserId,
            workspaceId: "555",
            workspaceExclusive: state.exclusive,
            workspaceEnabled: state.enabled,
          });
        if (endpoint === "/workspace-access") {
          if (body["workspaceId"] !== "555" || (body["enabled"] && !state.exclusive))
            return new Response(null, { status: 403 });
          state.enabled = body["enabled"] === true;
          return Response.json({ workspaceEnabled: state.enabled });
        }
        return new Response(null, { status: 404 });
      },
    }),
  };
  const env = {
    ALLOWED_GITHUB_IDS: "11,22",
    CLICKUP_READ_GITHUB_IDS: "11,22",
    CLICKUP_WORKSPACE_GITHUB_IDS: "11",
    CLICKUP_LIVE_ENABLED: "true",
    CLICKUP_LIST_ID: "12345",
    CLICKUP_OAUTH_ENABLED: "true",
    CLICKUP_CLIENT_ID: "dummy-client",
    CLICKUP_CLIENT_SECRET: "dummy-secret",
    CLICKUP_STATE_KEY: oauthKey,
    CLICKUP_TOKEN_KEY: oauthKey,
    CLICKUP_WORKSPACE_ID: "555",
    CLICKUP_STAFF_USER_MAP: JSON.stringify({ "11": "707", "22": "809" }),
    MCP_PUBLIC_ORIGIN: "https://stage.example",
    CLICKUP_CONNECTIONS: bindings,
    CLICKUP_QUOTA: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
    },
  };
  return { env, flags, calls };
}
describe("explicit per-user Workspace operations", () => {
  it("starts in List mode, activates only the approved user and revokes independently", async () => {
    const { env, flags } = testRig();
    expect((await requireReadGrant(auth("11"), env)).resourceScope).toBe("list");
    expect((await requireReadGrant(auth("22"), env)).resourceScope).toBe("list");
    expect(await clickUpConnectionStatus(auth("11"), env)).toMatchObject({
      workspace_exclusive: true,
      workspace_scope_approved: true,
      workspace_scope_enabled: false,
    });
    expect(await setClickUpWorkspaceAccess(auth("11"), env, "555", true)).toMatchObject({
      workspace_id: "555",
      workspace_scope_enabled: true,
    });
    expect((await requireReadGrant(auth("11"), env)).resourceScope).toBe("workspace");
    expect((await requireReadGrant(auth("22"), env)).resourceScope).toBe("list");
    expect((await clickUpConnectionStatus(auth("11"), env))["workspace_scope_enabled"]).toBe(true);
    await setClickUpWorkspaceAccess(auth("11"), env, "555", false);
    expect(flags.get("github:11")?.enabled).toBe(false);
    expect((await requireReadGrant(auth("11"), env)).resourceScope).toBe("list");
  });

  it("enables the staging owner only without changing another user or bypassing OAuth proof", async () => {
    const { env, flags } = testRig();
    const stage = { ...env, CLICKUP_RESOURCE_SCOPE: "workspace" };
    const ownerGrant = await requireReadGrant(auth("11"), stage);
    expect(ownerGrant.resourceScope).toBe("workspace");
    const ownerStatus = await clickUpConnectionStatus(auth("11"), stage);
    expect(ownerStatus["workspace_scope_enabled"]).toBe(true);
    const otherGrant = await requireReadGrant(auth("22"), stage);
    expect(otherGrant.resourceScope).toBe("list");
    const otherStatus = await clickUpConnectionStatus(auth("22"), stage);
    expect(otherStatus["workspace_scope_enabled"]).toBe(false);

    flags.get("github:11")!.exclusive = false;
    await expect(requireReadGrant(auth("11"), stage)).rejects.toThrow(
      "CLICKUP_WORKSPACE_RECONSENT_REQUIRED",
    );
    const revokedStatus = await clickUpConnectionStatus(auth("11"), stage);
    expect(revokedStatus["workspace_scope_enabled"]).toBe(false);
    const unapproved = await requireReadGrant(auth("11"), {
      ...stage,
      CLICKUP_WORKSPACE_GITHUB_IDS: undefined,
    });
    expect(unapproved.resourceScope).toBe("list");
  });

  it("rejects extra permissions without owner approval, valid write scope and one-Workspace OAuth", async () => {
    const { env, flags, calls } = testRig();
    for (const [identity, config, workspace, code] of [
      [auth("22"), env, "555", "CLICKUP_WORKSPACE_OWNER_APPROVAL_REQUIRED"],
      [auth("11", false), env, "555", "CLICKUP_WRITE_SCOPE_REQUIRED"],
      [auth("11"), env, "666", "CLICKUP_SCOPE_OR_SCHEMA_REJECTED"],
      [
        auth("11"),
        { ...env, CLICKUP_WORKSPACE_GITHUB_IDS: undefined },
        "555",
        "CLICKUP_WORKSPACE_OWNER_APPROVAL_REQUIRED",
      ],
    ] as const) {
      await expect(setClickUpWorkspaceAccess(identity, config, workspace, true)).rejects.toThrow(
        code,
      );
    }
    expect(calls.filter((x) => x.endsWith("/workspace-access"))).toHaveLength(0);
    flags.get("github:11")!.exclusive = false;
    await expect(setClickUpWorkspaceAccess(auth("11"), env, "555", true)).rejects.toThrow(
      "CLICKUP_WORKSPACE_RECONSENT_REQUIRED",
    );
    expect(flags.get("github:11")?.enabled).toBe(false);
  });

  it("stops effective workspace access immediately when owner revokes the allowlist", async () => {
    const { env } = testRig();
    await setClickUpWorkspaceAccess(auth("11"), env, "555", true);
    expect((await requireReadGrant(auth("11"), env)).resourceScope).toBe("workspace");
    expect(
      (await requireReadGrant(auth("11"), { ...env, CLICKUP_WORKSPACE_GITHUB_IDS: "22" }))
        .resourceScope,
    ).toBe("list");
  });
});
