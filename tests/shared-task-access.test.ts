import { describe, expect, it, vi } from "vitest";
import { runCatalogOperation } from "../src/clickup/catalog-runtime.js";
import type { ReadGrant } from "../src/clickup/policy.js";

const grant: ReadGrant = {
  subject: "github:11",
  clickupUserId: "707",
  workspaceId: "555",
  listId: "12345",
  resourceScope: "workspace",
  apiToken: "person-707",
  quota: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
  },
};

const mock = (proof: "shared" | "assigned" | "none" | "task-denied") =>
  vi.fn(async (req: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(req));
    if (url.pathname === "/api/v2/task/abc123")
      return proof === "task-denied"
        ? Response.json({ ECODE: "OAUTH_027" }, { status: 401 })
        : Response.json({ id: "abc123", list: { id: "99999" }, name: "Shared task" });
    if (url.pathname === "/api/v2/list/99999")
      return Response.json({ ECODE: "OAUTH_027" }, { status: 401 });
    if (url.pathname === "/api/v2/team/555/shared")
      return Response.json({
        shared: { tasks: proof === "shared" ? [{ id: "abc123" }] : [] },
      });
    if (url.pathname === "/api/v2/team/555/task") {
      expect(url.searchParams.get("list_ids[]")).toBe("99999");
      expect(url.searchParams.get("assignees[]")).toBe("707");
      return Response.json({
        tasks: proof === "assigned" ? [{ id: "abc123", list: { id: "99999" } }] : [],
      });
    }
    if (url.pathname === "/api/v2/task/abc123/comment")
      return init?.method === "POST"
        ? Response.json({ id: "123456" })
        : Response.json({ comments: [] });
    throw Error("Unexpected request");
  });

describe("individually accessible tasks in inaccessible Lists", () => {
  it.each(["shared", "assigned"] as const)("accepts exact %s Workspace proof", async (proof) => {
    const f = mock(proof);
    const args = { task_id: "abc123" };
    await expect(runCatalogOperation("clickup_get_task", args, grant, f)).resolves.toMatchObject({
      id: "abc123",
    });
    await expect(
      runCatalogOperation("clickup_get_task_comments", args, grant, f),
    ).resolves.toMatchObject({ comments: [] });
    await expect(
      runCatalogOperation("clickup_create_task_comment", { ...args, text: "Test" }, grant, f),
    ).resolves.toMatchObject({ id: "123456" });
    expect(f.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it.each(["none", "task-denied"] as const)("denies %s without a write", async (proof) => {
    const f = mock(proof);
    await expect(
      runCatalogOperation(
        "clickup_create_task_comment",
        { task_id: "abc123", text: "Test" },
        grant,
        f,
      ),
    ).rejects.toThrow();
    expect(f.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("does not confer access to the private List or permit structural edits", async () => {
    const f = mock("shared");
    await expect(
      runCatalogOperation("clickup_get_list", { list_id: "99999" }, grant, f),
    ).rejects.toThrow("CLICKUP_UPSTREAM_DENIED");
    await expect(
      runCatalogOperation("clickup_update_task", { task_id: "abc123", changes: {} }, grant, f),
    ).rejects.toThrow("CLICKUP_UPSTREAM_DENIED");
    expect(f.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(0);
  });
});
