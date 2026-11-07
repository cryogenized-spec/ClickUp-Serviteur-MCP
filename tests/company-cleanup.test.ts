import { describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { runCatalogOperation } from "../src/clickup/catalog-runtime.js";
import { createProtocolHandler } from "../src/mcp/handler.js";
import { COMPANY_OWNER_CLEANUP_OPERATIONS, type ReadGrant } from "../src/clickup/policy.js";
import { CLICKUP_MODEL_TOOL_CATALOG } from "../src/mcp/tool-catalog.js";

const grant: ReadGrant = {
  subject: "github:11",
  clickupUserId: "707",
  workspaceId: "555",
  listId: "12345",
  resourceScope: "workspace",
  companyCleanupAccess: true,
  apiToken: "synthetic-no-real-token",
  quota: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
  },
};

type MockOptions = {
  taskName?: string;
  subtasks?: unknown[];
  commentAuthor?: number;
  commentReplies?: number;
};
function mockApi(options: MockOptions = {}) {
  const requests: Array<{ method: string; path: string; query: string }> = [];
  const fetcher = vi.fn(async (target: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(target));
    const method = init?.method ?? "GET";
    requests.push({ method, path: url.pathname, query: url.search });
    if (url.pathname === "/api/v2/task/abc123" && method === "GET")
      return Response.json({
        id: "abc123",
        name: options.taskName ?? "Markdown formatting test",
        list: { id: "12345" },
        subtasks: options.subtasks ?? [],
      });
    if (url.pathname === "/api/v2/list/12345" && method === "GET")
      return Response.json({ id: "12345", space: { id: "777" } });
    if (url.pathname === "/api/v2/team/555/space" && method === "GET")
      return Response.json({ spaces: [{ id: "777" }] });
    if (url.pathname === "/api/v2/task/abc123/comment" && method === "GET")
      return Response.json({
        comments: [
          {
            id: "123456",
            user: { id: options.commentAuthor ?? 707 },
            reply_count: options.commentReplies ?? 0,
            comment_text: "Formatting verification",
          },
        ],
      });
    if (
      method === "DELETE" &&
      (url.pathname === "/api/v2/task/abc123" || url.pathname === "/api/v2/comment/123456")
    )
      return new Response(null, { status: 204 });
    throw Error("Unexpected API request: " + method + " " + url.pathname);
  });
  return { fetcher, requests };
}

describe("sole-owner ClickUp cleanup", () => {
  it("registers explicit cleanup operations and confirms destructive metadata", () => {
    expect([...COMPANY_OWNER_CLEANUP_OPERATIONS].sort()).toEqual([
      "clickup_delete_task",
      "clickup_delete_task_comment",
      "clickup_remove_dependency",
      "clickup_remove_tag_from_task",
      "clickup_remove_task_link",
    ]);
    for (const name of ["clickup_delete_task", "clickup_delete_task_comment"]) {
      const spec = CLICKUP_MODEL_TOOL_CATALOG.find((item) => item.name === name);
      expect(spec?.effect).toBe("destructive");
      expect(spec?.inputSchema.properties["confirm_delete"]?.type).toBe("boolean");
    }
  });

  it("sends exactly one confirmed task to Trash after verifying current title, List and no subtasks", async () => {
    const api = mockApi();
    const response = await runCatalogOperation(
      "clickup_delete_task",
      { task_id: "abc123", expected_task_name: "Markdown formatting test", confirm_delete: true },
      grant,
      api.fetcher as typeof fetch,
    );
    expect(response).toMatchObject({
      success: true,
      task_id: "abc123",
      action: "sent_to_trash",
    });
    expect(api.requests.map((r) => r.method + " " + r.path)).toEqual([
      "GET /api/v2/task/abc123",
      "GET /api/v2/list/12345",
      "GET /api/v2/team/555/space",
      "GET /api/v2/task/abc123",
      "DELETE /api/v2/task/abc123",
    ]);
    expect(api.requests[3]?.query).toContain("include_subtasks=true");
  });

  it("rejects stale titles, missing confirmation and nonempty subtasks before deleting", async () => {
    const cases = [
      { options: { taskName: "Existing repair task" }, args: { confirm_delete: true } },
      { options: { subtasks: [{ id: "child-1" }] }, args: { confirm_delete: true } },
      { options: {}, args: { confirm_delete: false } },
      { options: {}, args: { confirm_delete: true, expected_task_name: "Wrong title" } },
    ];
    for (const entry of cases) {
      const api = mockApi(entry.options);
      await expect(
        runCatalogOperation(
          "clickup_delete_task",
          {
            task_id: "abc123",
            expected_task_name: "Markdown formatting test",
            ...entry.args,
          },
          grant,
          api.fetcher as typeof fetch,
        ),
      ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      expect(api.requests.some((r) => r.method === "DELETE")).toBe(false);
    }
  });

  it("deletes exactly one of this user's comments on a verified task", async () => {
    const api = mockApi();
    const response = await runCatalogOperation(
      "clickup_delete_task_comment",
      { task_id: "abc123", comment_id: "123456", confirm_delete: true },
      grant,
      api.fetcher as typeof fetch,
    );
    expect(response).toMatchObject({
      success: true,
      task_id: "abc123",
      comment_id: "123456",
      action: "deleted_own_comment",
    });
    expect(api.requests.filter((r) => r.method === "DELETE")).toEqual([
      { method: "DELETE", path: "/api/v2/comment/123456", query: "" },
    ]);
  });

  it("refuses to remove another person's comment, a reply thread, or unknown comment", async () => {
    for (const [opts, id] of [
      [{ commentAuthor: 999 }, "123456"],
      [{ commentReplies: 2 }, "123456"],
      [{}, "999999"],
    ] as const) {
      const api = mockApi(opts);
      await expect(
        runCatalogOperation(
          "clickup_delete_task_comment",
          { task_id: "abc123", comment_id: id, confirm_delete: true },
          grant,
          api.fetcher as typeof fetch,
        ),
      ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      expect(api.requests.some((r) => r.method === "DELETE")).toBe(false);
    }
  });

  it("advertises cleanup only when owner profile has an explicit cleanup flag", async () => {
    for (const enable of ["true", "false"]) {
      const handler = createProtocolHandler({
        bindings: {
          CLICKUP_LIVE_ENABLED: "true",
          CLICKUP_OAUTH_ENABLED: "true",
          CLICKUP_COMPANY_PROFILE: "true",
          CLICKUP_COMPANY_WRITE_MODE: "non_destructive",
          CLICKUP_COMPANY_CLEANUP_ENABLED: enable,
          CLICKUP_RESOURCE_SCOPE: "workspace",
          CLICKUP_LIST_ID: "12345",
          CLICKUP_WORKSPACE_ID: "555",
        },
      });
      const client = new Client({ name: "company-cleanup-fixture", version: "0.1.0" });
      const transport = new StreamableHTTPClientTransport(new URL("http://local.test/mcp"), {
        fetch: async (url, init) =>
          handler.fetch(new Request(url, init), {
            authInfo: {
              token: "synthetic",
              clientId: "fixture",
              scopes: ["mcp:read", "mcp:write"],
              extra: { subject: "github:11" },
            },
          }),
      });
      try {
        await client.connect(transport);
        const listed = (await client.listTools()).tools;
        for (const name of COMPANY_OWNER_CLEANUP_OPERATIONS) {
          expect(listed.some((item) => item.name === name)).toBe(enable === "true");
          if (enable === "true" && name.startsWith("clickup_delete_")) {
            expect(listed.find((item) => item.name === name)?.annotations?.destructiveHint).toBe(
              true,
            );
          }
        }
        const info = await client.callTool({ name: "service_info", arguments: {} });
        expect(info.structuredContent).toMatchObject({
          destructive_actions_enabled: enable === "true",
          cleanup_scope: enable === "true" ? "owner_verified_objects" : "disabled",
        });
      } finally {
        await client.close();
        await handler.close();
      }
    }
  });
});
