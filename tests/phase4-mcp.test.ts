import { OPERATIONAL_CATALOG_NAMES } from "../src/clickup/catalog-runtime.js";
import { describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createProtocolHandler } from "../src/mcp/handler.js";

function configuration() {
  return {
    CLICKUP_LIVE_ENABLED: "true",
    CLICKUP_LIST_ID: "12345",
    CLICKUP_OAUTH_ENABLED: "true",
    CLICKUP_CLIENT_ID: "fixture-client",
    CLICKUP_CLIENT_SECRET: "fixture-secret",
    CLICKUP_STATE_KEY: btoa(String.fromCharCode(...new Uint8Array(32))),
    CLICKUP_TOKEN_KEY: btoa(String.fromCharCode(...new Uint8Array(32))),
    CLICKUP_WORKSPACE_ID: "555",
    CLICKUP_STAFF_USER_MAP: JSON.stringify({ "11": "456", "22": "654" }),
    MCP_PUBLIC_ORIGIN: "https://staging.example",
    CLICKUP_CONNECTIONS: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () =>
          Response.json({
            connected: true,
            clickupUserId: "456",
            workspaceId: "555",
            accessToken: "nonworking-personal-fixture",
          }),
      }),
    },
    CLICKUP_READ_GITHUB_IDS: "11",
    ALLOWED_GITHUB_IDS: "11,22",
    CLICKUP_QUOTA: {
      idFromName: () => "same-token",
      get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
    },
  };
}

describe("Phase 4 official SDK integration", () => {
  it("advertises three operational read tools plus catalogue and diagnostic", async () => {
    const outbound = vi.fn(async (url: RequestInfo | URL) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("/list/12345"))
        return Response.json({
          id: "12345",
          name: "Workshop",
          statuses: [{ status: "Open" }],
          space: { id: "765" },
        });
      if (pathname.endsWith("/team/555/space")) return Response.json({ spaces: [{ id: "765" }] });
      return Response.json({ tasks: [] });
    });
    const handler = createProtocolHandler({
      bindings: configuration(),
      fetcher: outbound as typeof fetch,
    });
    const client = new Client({ name: "scoped-test", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL("http://local.test/mcp"), {
      fetch: async (input, init) =>
        handler.fetch(new Request(input, init), {
          authInfo: {
            token: "verified-internal-only",
            clientId: "mcp-test",
            scopes: ["mcp:read"],
            extra: { subject: "github:11" },
          },
        }),
    });
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools;
      expect(tools.map((tool) => tool.name).sort()).toEqual(
        [
          ...[
            "clickup_tool_catalog",
            "connect_clickup_account",
            "clickup_set_workspace_access",
            "clickup_preview_target",
            "clickup_select_target",
            "create_scoped_task",
            "disconnect_clickup_account",
            "find_scoped_tasks",
            "get_attention_report",
            "get_clickup_connection_status",
            "get_scoped_list",
            "get_scoped_task",
            "service_info",
          ],
          ...OPERATIONAL_CATALOG_NAMES,
        ].sort(),
      );
      for (const tool of tools.filter((t) => !OPERATIONAL_CATALOG_NAMES.includes(t.name))) {
        expect(tool.annotations?.readOnlyHint).toBe(
          ![
            "connect_clickup_account",
            "disconnect_clickup_account",
            "create_scoped_task",
            "clickup_set_workspace_access",
            "clickup_select_target",
          ].includes(tool.name),
        );
        expect(tool.annotations?.destructiveHint).toBe(
          tool.name === "disconnect_clickup_account" ||
            tool.name === "clickup_set_workspace_access",
        );
      }
      const diagnostic = await client.callTool({ name: "service_info", arguments: {} });
      expect(diagnostic.structuredContent).toMatchObject({
        phase: 6,
        liveClickUp: true,
        authentication: "github-oauth-plus-individual-clickup-oauth",
      });
      await expect(
        client.callTool({
          name: "create_scoped_task",
          arguments: { name: "No write scope" },
        }),
      ).rejects.toThrow();
      expect(outbound).not.toHaveBeenCalled();
      const scope = await client.callTool({ name: "get_scoped_list", arguments: {} });
      expect(scope.structuredContent).toMatchObject({
        name: "Workshop",
        resource_scope: "list",
        task_id_operations_enabled: false,
      });
      const response = await client.callTool({
        name: "find_scoped_tasks",
        arguments: { max_results: 4 },
      });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({
        source: "clickup-api-v2",
        list_id: "12345",
        incomplete: false,
        pages_scanned: 1,
      });
      // Both read tools independently verify the home List and its Workspace.
      expect(outbound).toHaveBeenCalledTimes(6);
    } finally {
      await client.close();
      await handler.close();
    }
  });

  it("exposes List-bound company task creation and editing while withholding destructive tools", async () => {
    const outbound = vi.fn(async () => {
      throw Error("No real company requests permitted in this test");
    });
    const handler = createProtocolHandler({
      bindings: {
        ...configuration(),
        CLICKUP_COMPANY_PROFILE: "true",
        CLICKUP_COMPANY_WRITE_MODE: "non_destructive",
        CLICKUP_RESOURCE_SCOPE: "list",
      },
      fetcher: outbound as typeof fetch,
    });
    const client = new Client({ name: "company-safe-tools", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL("http://local.test/mcp"), {
      fetch: async (input, init) =>
        handler.fetch(new Request(input, init), {
          authInfo: {
            token: "synthetic-mcp-token",
            clientId: "test",
            scopes: ["mcp:read", "mcp:write"],
            extra: { subject: "github:11" },
          },
        }),
    });
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools;
      const names = tools.map((tool) => tool.name);
      for (const name of [
        "create_scoped_task",
        "clickup_create_task",
        "clickup_create_bulk_tasks",
        "clickup_update_task",
        "clickup_set_custom_field",
        "clickup_update_bulk_tasks",
        "clickup_create_task_comment",
        "clickup_attach_file_to_task",
        "clickup_add_tag_to_task",
        "clickup_add_dependency",
      ]) {
        expect(names).toContain(name);
        expect(tools.find((tool) => tool.name === name)?.annotations?.destructiveHint).toBe(false);
      }
      for (const name of [
        "clickup_delete_task",
        "clickup_remove_tag_from_task",
        "clickup_remove_dependency",
        "clickup_move_task_to_list",
        "clickup_update_document_page",
        "clickup_set_workspace_access",
        "clickup_select_target",
      ])
        expect(names).not.toContain(name);
      expect(
        (await client.callTool({ name: "service_info", arguments: {} })).structuredContent,
      ).toMatchObject({
        company_write_mode: "non_destructive",
        destructive_actions_enabled: false,
      });
      const page = await client.callTool({
        name: "clickup_tool_catalog",
        arguments: { group: "tasks", max_results: 20 },
      });
      expect(JSON.stringify(page.structuredContent)).toContain("company_disabled");
      expect(outbound).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await handler.close();
    }
  });

  it("updates an existing company task through the actual MCP protocol with an OAuth write grant", async () => {
    const outbound = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/v2/task/task42" && init?.method === "GET")
        return Response.json({ id: "task42", list: { id: "12345" } });
      if (path === "/api/v2/list/12345")
        return Response.json({ id: "12345", space: { id: "765" } });
      if (path === "/api/v2/team/555/space")
        return Response.json({ spaces: [{ id: "765" }] });
      if (path === "/api/v2/task/task42" && init?.method === "PUT") {
        expect(init?.headers).toMatchObject({ Authorization: "nonworking-personal-fixture" });
        expect(JSON.parse(String(init.body))).toMatchObject({
          status: "in progress",
          priority: 2,
          assignees: { add: [707], rem: [] },
        });
        return Response.json({ id: "task42", status: { status: "in progress" } });
      }
      throw Error("Unexpected ClickUp operation: " + (init?.method ?? "GET") + " " + path);
    });
    const handler = createProtocolHandler({
      bindings: {
        ...configuration(),
        CLICKUP_COMPANY_PROFILE: "true",
        CLICKUP_COMPANY_WRITE_MODE: "non_destructive",
        CLICKUP_RESOURCE_SCOPE: "list",
      },
      fetcher: outbound as typeof fetch,
    });
    const client = new Client({ name: "company-task-edit", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL("http://local.test/mcp"), {
      fetch: async (input, init) =>
        handler.fetch(new Request(input, init), {
          authInfo: {
            token: "test-mcp-oauth",
            clientId: "company-client",
            scopes: ["mcp:read", "mcp:write"],
            extra: { subject: "github:11" },
          },
        }),
    });
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "clickup_update_task",
        arguments: {
          task_id: "task42",
          changes: { status: "in progress", priority: 2, assignee_ids: ["707"] },
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ id: "task42" });
      expect(outbound.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
        "/api/v2/task/task42",
        "/api/v2/list/12345",
        "/api/v2/team/555/space",
        "/api/v2/task/task42",
      ]);
      expect(outbound.mock.calls.at(-1)?.[1]?.method).toBe("PUT");
    } finally {
      await client.close();
      await handler.close();
    }
  });

  it("reports verified write scope without exposing any OAuth token", async () => {
    const handler = createProtocolHandler({ bindings: configuration() });
    const client = new Client({ name: "write-scope-diagnostic", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL("http://local.test/mcp"), {
      fetch: async (input, init) =>
        handler.fetch(new Request(input, init), {
          authInfo: {
            token: "verified-internal-only",
            clientId: "mcp-test",
            scopes: ["mcp:read", "mcp:write"],
            extra: { subject: "github:11" },
          },
        }),
    });
    try {
      await client.connect(transport);
      const status = await client.callTool({
        name: "get_clickup_connection_status",
        arguments: {},
      });
      expect(status.structuredContent).toMatchObject({
        connected: true,
        mcp_read_scope_granted: true,
        mcp_write_scope_granted: true,
      });
      expect(JSON.stringify(status.structuredContent)).not.toContain("nonworking-personal-fixture");
    } finally {
      await client.close();
      await handler.close();
    }
  });

  it("rejects user header spoofing and unapproved subject before touching ClickUp", async () => {
    const outbound = vi.fn(async () =>
      Response.json({ tasks: [] }, { headers: { "content-type": "application/json" } }),
    );
    const handler = createProtocolHandler({
      bindings: configuration(),
      fetcher: outbound as typeof fetch,
    });
    const client = new Client({ name: "forger", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL("http://local.test/mcp"), {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        request.headers.set("X-User", "github:11");
        return handler.fetch(request, {
          authInfo: {
            token: "verified-internal-only",
            clientId: "mcp-test",
            scopes: ["mcp:read"],
            extra: { subject: "github:22" },
          },
        });
      },
    });
    try {
      await client.connect(transport);
      const response = await client.callTool({ name: "get_attention_report", arguments: {} });
      expect(response.isError).toBe(true);
      expect(response.content).toMatchObject([
        { type: "text", text: '{"code":"CLICKUP_ACCESS_DENIED"}' },
      ]);
      expect(outbound).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await handler.close();
    }
  });

  it("executes a native create task through the official MCP protocol only with separately consented write scope", async () => {
    const outbound = vi.fn(async (url: RequestInfo | URL, options?: RequestInit) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("/list/12345") && options?.method === "GET")
        return Response.json({ id: "12345", space: { id: 765 } });
      if (pathname.endsWith("/team/555/space") && options?.method === "GET")
        return Response.json({ spaces: [{ id: 765 }] });
      expect(String(url)).toBe("https://api.clickup.com/api/v2/list/12345/task");
      expect(options?.method).toBe("POST");
      expect(options?.headers).toMatchObject({
        Authorization: "nonworking-personal-fixture",
      });
      return Response.json({ id: "new123", list: { id: "12345" } });
    });
    const handler = createProtocolHandler({
      bindings: configuration(),
      fetcher: outbound as typeof fetch,
    });
    const client = new Client({ name: "write-integration-test", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL("http://local.test/mcp"), {
      fetch: async (input, init) =>
        handler.fetch(new Request(input, init), {
          authInfo: {
            token: "verified-client-token",
            clientId: "client-test",
            scopes: ["mcp:read", "mcp:write"],
            extra: { subject: "github:11" },
          },
        }),
    });
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "create_scoped_task",
        arguments: { name: "Synthetic task" },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        action: "task_created",
        task_id: "new123",
        accepted: true,
      });
      expect(outbound).toHaveBeenCalledTimes(3);
    } finally {
      await client.close();
      await handler.close();
    }
  });

  it("rejects a List in a different Workspace before any ClickUp POST", async () => {
    const outbound = vi.fn(async (url: RequestInfo | URL, options?: RequestInit) => {
      const target = String(url);
      if (options?.method === "POST") throw new Error("FORBIDDEN_WRITE");
      if (target.endsWith("/list/12345")) return Response.json({ id: "12345", space: { id: 999 } });
      if (target.includes("/team/555/space")) return Response.json({ spaces: [{ id: 765 }] });
      if (target.endsWith("/team/555/shared")) return Response.json({ shared: { lists: [] } });
      throw new Error("unexpected request");
    });
    const handler = createProtocolHandler({
      bindings: configuration(),
      fetcher: outbound as typeof fetch,
    });
    const client = new Client({ name: "workspace-isolation-test", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL("http://local.test/mcp"), {
      fetch: async (input, init) =>
        handler.fetch(new Request(input, init), {
          authInfo: {
            token: "write-grant",
            clientId: "test",
            scopes: ["mcp:read", "mcp:write"],
            extra: { subject: "github:11" },
          },
        }),
    });
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "create_scoped_task",
        arguments: { name: "Must not be created" },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      expect(outbound).toHaveBeenCalledTimes(3);
      expect(outbound.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).not.toContain("update_scoped_task");
      expect(names).not.toContain("comment_on_scoped_task");
      expect(names).not.toContain("get_scoped_task_comments");
    } finally {
      await client.close();
      await handler.close();
    }
  });
});
