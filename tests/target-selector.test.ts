import { describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createProtocolHandler } from "../src/mcp/handler.js";

function targetRig() {
  const selected = new Map<string, string>();
  const calls: string[] = [];
  const oauthKey = btoa(String.fromCharCode(...new Uint8Array(32)));
  const bindings = {
    ALLOWED_GITHUB_IDS: "11,22",
    CLICKUP_READ_GITHUB_IDS: "11,22",
    CLICKUP_WORKSPACE_GITHUB_IDS: "11",
    CLICKUP_RESOURCE_SCOPE: "workspace",
    CLICKUP_LIVE_ENABLED: "true",
    CLICKUP_OAUTH_ENABLED: "true",
    CLICKUP_CLIENT_ID: "fixture-client",
    CLICKUP_CLIENT_SECRET: "fixture-secret",
    CLICKUP_STATE_KEY: oauthKey,
    CLICKUP_TOKEN_KEY: oauthKey,
    CLICKUP_WORKSPACE_ID: "555",
    CLICKUP_LIST_ID: "12345",
    CLICKUP_STAFF_USER_MAP: JSON.stringify({ "11": "707", "22": "809" }),
    MCP_PUBLIC_ORIGIN: "https://stage.example",
    CLICKUP_CONNECTIONS: {
      idFromName: (name: string) => name,
      get: (key: string) => ({
        fetch: async (request: Request) => {
          const body = (await request.json()) as Record<string, unknown>;
          const subject = String(body["subject"]);
          const path = new URL(request.url).pathname;
          if (key !== "staff-clickup:" + subject) return new Response(null, { status: 403 });
          if (path === "/target-list") {
            if (subject !== "github:11" || body["workspaceId"] !== "555")
              return new Response(null, { status: 403 });
            selected.set(subject, String(body["listId"]));
            return Response.json({ selected: true, workspaceId: "555", listId: body["listId"] });
          }
          if (path === "/credential" || path === "/status")
            return Response.json({
              connected: true,
              clickupUserId: subject === "github:11" ? "707" : "809",
              workspaceId: "555",
              accessToken: "synthetic-personal-user-token",
              workspaceExclusive: true,
              workspaceEnabled: subject === "github:11",
              targetListId: selected.get(subject) ?? null,
            });
          return new Response(null, { status: 404 });
        },
      }),
    },
    CLICKUP_QUOTA: {
      idFromName: () => "quota",
      get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
    },
  };
  const fetcher = vi.fn(async (request: RequestInfo | URL) => {
    const path = new URL(String(request)).pathname;
    calls.push(path);
    if (path === "/api/v2/list/12345")
      return Response.json({ id: "12345", name: "Sandbox", space: { id: "765" }, statuses: [] });
    if (path === "/api/v2/list/23456")
      return Response.json({ id: "23456", name: "MCP QA Alternate", space: { id: "765" }, statuses: [{ status: "Open" }] });
    if (path === "/api/v2/list/99999")
      return Response.json({ id: "99999", name: "Foreign", space: { id: "999" } });
    if (path === "/api/v2/team/555/space")
      return Response.json({ spaces: [{ id: "765" }] });
    throw Error("Unexpected ClickUp path: " + path);
  });
  const connect = async (subject: "11" | "22", write = true) => {
    const handler = createProtocolHandler({ bindings, fetcher: fetcher as typeof fetch });
    const client = new Client({ name: "target-test-" + subject, version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL("http://local.test/mcp"), {
      fetch: async (input, init) =>
        handler.fetch(new Request(input, init), {
          authInfo: {
            token: "test-verified",
            clientId: "fixture-client",
            scopes: write ? ["mcp:read", "mcp:write"] : ["mcp:read"],
            extra: { subject: "github:" + subject },
          },
        }),
    });
    await client.connect(transport);
    return { client, async close() { await client.close(); await handler.close(); } };
  };
  return { connect, selected, calls };
}

describe("owner-controlled ClickUp target selector, no production Workspace leakage", () => {
  it("previews a verified List and changes only this principal's active scoped List", async () => {
    const rig = targetRig();
    const owner = await rig.connect("11");
    const coworker = await rig.connect("22");
    try {
      const advertised = (await owner.client.listTools()).tools;
      expect(advertised.find((t) => t.name === "clickup_preview_target")?.annotations?.readOnlyHint).toBe(true);
      expect(advertised.find((t) => t.name === "clickup_select_target")?.annotations?.readOnlyHint).toBe(false);
      const preview = await owner.client.callTool({
        name: "clickup_preview_target",
        arguments: { workspace_id: "555", list_id: "23456" },
      });
      expect(preview.isError).not.toBe(true);
      expect(preview.structuredContent).toMatchObject({
        workspace_id: "555",
        list_id: "23456",
        list_name: "MCP QA Alternate",
        current_list_id: "12345",
        would_change: true,
      });
      expect(rig.selected.size).toBe(0);
      const unsafe = await owner.client.callTool({
        name: "clickup_select_target",
        arguments: { workspace_id: "555", list_id: "23456", expected_list_name: "MCP QA Alternate", confirm: false },
      });
      expect(unsafe.isError).toBe(true);
      expect(rig.selected.size).toBe(0);
      const wrongName = await owner.client.callTool({
        name: "clickup_select_target",
        arguments: { workspace_id: "555", list_id: "23456", expected_list_name: "Company Tasks", confirm: true },
      });
      expect(wrongName.isError).toBe(true);
      expect(rig.selected.size).toBe(0);
      const changed = await owner.client.callTool({
        name: "clickup_select_target",
        arguments: { workspace_id: "555", list_id: "23456", expected_list_name: "MCP QA Alternate", confirm: true },
      });
      expect(changed.isError).not.toBe(true);
      expect(changed.structuredContent).toMatchObject({ persisted: true, selected_list_id: "23456", list_name: "MCP QA Alternate" });
      const current = await owner.client.callTool({ name: "get_scoped_list", arguments: {} });
      expect(current.structuredContent).toMatchObject({ list_id: "23456", name: "MCP QA Alternate" });
      const status = await owner.client.callTool({ name: "get_clickup_connection_status", arguments: {} });
      expect(status.structuredContent).toMatchObject({ selected_list_id: "23456", selected_list_is_override: true });
      const colleagueList = await coworker.client.callTool({ name: "get_scoped_list", arguments: {} });
      expect(colleagueList.structuredContent).toMatchObject({ list_id: "12345", name: "Sandbox", resource_scope: "list" });
    } finally {
      await owner.close();
      await coworker.close();
    }
  });

  it("denies a foreign Workspace or List and unapproved coworker without saving any target", async () => {
    const rig = targetRig();
    const owner = await rig.connect("11");
    const coworker = await rig.connect("22");
    try {
      for (const [workspace_id, list_id] of [
        ["777", "23456"],
        ["555", "99999"],
      ]) {
        const response = await owner.client.callTool({ name: "clickup_preview_target", arguments: { workspace_id, list_id } });
        expect(response.isError).toBe(true);
      }
      const forbidden = await owner.client.callTool({
        name: "clickup_select_target",
        arguments: { workspace_id: "777", list_id: "23456", expected_list_name: "MCP QA Alternate", confirm: true },
      });
      expect(forbidden.isError).toBe(true);
      const coworkerPreview = await coworker.client.callTool({
        name: "clickup_preview_target",
        arguments: { workspace_id: "555", list_id: "23456" },
      });
      expect(coworkerPreview.isError).toBe(true);
      expect(rig.selected.size).toBe(0);
    } finally {
      await owner.close();
      await coworker.close();
    }
  });
});
