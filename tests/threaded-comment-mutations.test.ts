import { describe, expect, it, vi } from "vitest";
import { runCatalogOperation } from "../src/clickup/catalog-runtime.js";
import type { ReadGrant } from "../src/clickup/policy.js";

const grant: ReadGrant = {
  subject: "github:11",
  clickupUserId: "707",
  workspaceId: "555",
  listId: "12345",
  resourceScope: "workspace",
  companyCleanupAccess: true,
  apiToken: "synthetic-test-token",
  quota: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
  },
};

type FixtureOptions = {
  owner?: number;
  childReplyCount?: number | null;
  staleReadback?: boolean;
};
function fixture(options: FixtureOptions = {}) {
  const calls: Array<{ method: string; path: string }> = [];
  let body = "Original";
  let deleted = false;
  let wrote = false;
  const api = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = new URL(String(input)).pathname;
    calls.push({ method, path });
    if (method === "GET" && path === "/api/v2/task/task1")
      return Response.json({ id: "task1", list: { id: "12345" } });
    if (method === "GET" && path === "/api/v2/list/12345")
      return Response.json({ id: "12345", space: { id: "777" } });
    if (method === "GET" && path === "/api/v2/team/555/space")
      return Response.json({ spaces: [{ id: "777" }] });
    if (method === "GET" && path === "/api/v2/task/task1/comment")
      return Response.json({
        comments: [
          { id: "parent-1", date: "1795084000000", reply_count: deleted ? 0 : 1, user: { id: 708 } },
          { id: "parent-2", date: "1795083000000", reply_count: 0, user: { id: 708 } },
        ],
      });
    if (method === "GET" && path === "/api/v2/comment/parent-1/reply")
      return Response.json({
        comments: deleted
          ? []
          : [
              {
                id: "child-1",
                user: { id: options.owner ?? 707 },
                assignee: null,
                group_assignee: null,
                comment_text: options.staleReadback && wrote ? "Original" : body,
                ...(options.childReplyCount === undefined
                  ? {}
                  : { reply_count: options.childReplyCount }),
              },
            ],
      });
    if (method === "GET" && path === "/api/v2/comment/child-1/reply")
      return Response.json({
        comments:
          options.childReplyCount && options.childReplyCount > 0
            ? [{ id: "grandchild", user: { id: 708 } }]
            : [],
      });
    if (method === "PUT" && path === "/api/v2/comment/child-1") {
      expect(JSON.parse(String(init?.body))).toEqual({
        comment_text: "Corrected",
        assignee: 0,
        resolved: false,
      });
      body = "Corrected";
      wrote = true;
      return Response.json({});
    }
    if (method === "DELETE" && path === "/api/v2/comment/child-1") {
      deleted = true;
      return new Response(null, { status: 204 });
    }
    throw new Error("Unexpected API request: " + method + " " + path);
  });
  return { api, calls };
}

describe("task comment threaded-reply mutations (#145, #146)", () => {
  it("edits an own reply in place and verifies the updated text under its original parent", async () => {
    const { api, calls } = fixture();
    const response = await runCatalogOperation(
      "clickup_edit_task_comment",
      { task_id: "task1", comment_id: "child-1", text: "Corrected" },
      grant,
      api as typeof fetch,
    );
    expect(response).toMatchObject({
      success: true,
      comment_id: "child-1",
      verified_by_readback: true,
    });
    expect(calls.filter((x) => x.method === "PUT")).toEqual([
      { method: "PUT", path: "/api/v2/comment/child-1" },
    ]);
    expect(calls.filter((x) => x.path === "/api/v2/comment/parent-1/reply")).toHaveLength(2);
  });

  it("deletes a confirmed own leaf reply, not its parent, and verifies absence from the thread", async () => {
    const { api, calls } = fixture();
    const response = await runCatalogOperation(
      "clickup_delete_task_comment",
      { task_id: "task1", comment_id: "child-1", confirm_delete: true },
      grant,
      api as typeof fetch,
    );
    expect(response).toMatchObject({
      success: true,
      comment_id: "child-1",
      action: "deleted_own_comment",
      verified_by_readback: true,
    });
    expect(calls.filter((x) => x.method === "DELETE")).toEqual([
      { method: "DELETE", path: "/api/v2/comment/child-1" },
    ]);
    expect(calls).toContainEqual({ method: "GET", path: "/api/v2/comment/child-1/reply" });
  });

  it.each(["clickup_edit_task_comment", "clickup_delete_task_comment"])(
    "refuses mutation of another user's threaded reply through %s",
    async (operation) => {
      const { api, calls } = fixture({ owner: 708 });
      const args =
        operation === "clickup_edit_task_comment"
          ? { task_id: "task1", comment_id: "child-1", text: "Corrected" }
          : { task_id: "task1", comment_id: "child-1", confirm_delete: true };
      await expect(runCatalogOperation(operation, args, grant, api as typeof fetch)).rejects.toThrow(
        "CLICKUP_SCOPE_OR_SCHEMA_REJECTED",
      );
      expect(calls.every((x) => x.method === "GET")).toBe(true);
    },
  );

  it("refuses a reply on a different parent when an explicit parent was supplied", async () => {
    const { api, calls } = fixture();
    await expect(
      runCatalogOperation(
        "clickup_edit_task_comment",
        {
          task_id: "task1",
          comment_id: "child-1",
          parent_comment_id: "parent-2",
          text: "Corrected",
        },
        grant,
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(calls.every((x) => x.method === "GET")).toBe(true);
  });

  it("refuses to delete a threaded reply that itself has replies", async () => {
    const { api, calls } = fixture({ childReplyCount: 1 });
    await expect(
      runCatalogOperation(
        "clickup_delete_task_comment",
        { task_id: "task1", comment_id: "child-1", confirm_delete: true },
        grant,
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(calls.every((x) => x.method === "GET")).toBe(true);
  });

  it("does not report a successful edit when the threaded readback remains stale", async () => {
    const { api, calls } = fixture({ staleReadback: true });
    await expect(
      runCatalogOperation(
        "clickup_edit_task_comment",
        { task_id: "task1", comment_id: "child-1", text: "Corrected" },
        grant,
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_WRITE_OUTCOME_UNKNOWN");
    expect(calls.filter((x) => x.method === "PUT")).toHaveLength(1);
  });
});
