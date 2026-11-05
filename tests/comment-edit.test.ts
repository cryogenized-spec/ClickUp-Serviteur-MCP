import { describe, expect, it, vi } from "vitest";
import { runCatalogOperation } from "../src/clickup/catalog-runtime.js";
import type { ReadGrant } from "../src/clickup/policy.js";

const grant = (company = true): ReadGrant => ({
  subject: "github:11",
  clickupUserId: "707",
  workspaceId: "555",
  listId: "12345",
  resourceScope: "list",
  ...(company ? { companyListTaskAccess: true } : {}),
  apiToken: "person-707",
  quota: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
  },
});

const reply = (data: unknown) =>
  Response.json(data, { status: 200, headers: { "Content-Type": "application/json" } });

describe("task comment editing is author- and List-bound", () => {
  it("changes only an authenticated user's comment and verifies the persisted text", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    let changed = false;
    const api = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = new URL(String(input)).pathname;
      calls.push({ method, path });
      if (path === "/api/v2/task/task1")
        return reply({ id: "task1", list: { id: "12345" } });
      if (path === "/api/v2/list/12345")
        return reply({ id: "12345", space: { id: "777" } });
      if (path === "/api/v2/team/555/space") return reply({ spaces: [{ id: "777" }] });
      if (path === "/api/v2/task/task1/comment")
        return reply({
          comments: [
            {
              id: "own22",
              user: { id: 707 },
              comment_text: changed ? "Please use the second tab." : "@MONISHA Please use the second tab.",
            },
          ],
        });
      if (path === "/api/v2/comment/own22" && method === "PUT") {
        expect((init?.headers as Record<string, string>)["Authorization"]).toBe("person-707");
        expect(JSON.parse(String(init?.body))).toEqual({
          comment_text: "Please use the second tab.",
        });
        changed = true;
        return reply({});
      }
      throw Error("Unexpected API request " + method + " " + path);
    });
    const result = await runCatalogOperation(
      "clickup_edit_task_comment",
      { task_id: "task1", comment_id: "own22", text: "Please use the second tab." },
      grant(),
      api as typeof fetch,
    );
    expect(result).toMatchObject({
      success: true,
      task_id: "task1",
      comment_id: "own22",
      verified_by_readback: true,
    });
    expect(calls).toEqual([
      { method: "GET", path: "/api/v2/task/task1" },
      { method: "GET", path: "/api/v2/list/12345" },
      { method: "GET", path: "/api/v2/team/555/space" },
      { method: "GET", path: "/api/v2/task/task1/comment" },
      { method: "PUT", path: "/api/v2/comment/own22" },
      { method: "GET", path: "/api/v2/task/task1/comment" },
    ]);
  });

  it.each([
    { label: "someone else's", authorId: 708, comments: true },
    { label: "unseen", authorId: 707, comments: false },
  ])("refuses editing $label comment before a PUT", async ({ authorId, comments }) => {
    const api = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "GET") throw Error("Unauthorized write");
      const path = new URL(String(input)).pathname;
      if (path === "/api/v2/task/task1")
        return reply({ id: "task1", list: { id: "12345" } });
      if (path === "/api/v2/list/12345")
        return reply({ id: "12345", space: { id: "777" } });
      if (path === "/api/v2/team/555/space") return reply({ spaces: [{ id: "777" }] });
      if (path === "/api/v2/task/task1/comment")
        return reply({
          comments: comments ? [{ id: "other22", user: { id: authorId } }] : [],
        });
      throw Error("Unexpected API request");
    });
    await expect(
      runCatalogOperation(
        "clickup_edit_task_comment",
        { task_id: "task1", comment_id: "other22", text: "Replacement" },
        grant(),
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(api.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });

  it("refuses a different List and legacy List-only grants", async () => {
    const api = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "GET") throw Error("Unauthorized write");
      const path = new URL(String(input)).pathname;
      if (path === "/api/v2/task/task1")
        return reply({ id: "task1", list: { id: "other-list" } });
      throw Error("Out-of-scope list access attempted");
    });
    const a = { task_id: "task1", comment_id: "own22", text: "Replacement" };
    await expect(
      runCatalogOperation("clickup_edit_task_comment", a, grant(), api as typeof fetch),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    await expect(
      runCatalogOperation("clickup_edit_task_comment", a, grant(false), api as typeof fetch),
    ).rejects.toThrow("CLICKUP_WORKSPACE_SCOPE_REQUIRED");
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("rejects unverified post-write content instead of reporting success", async () => {
    const api = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = new URL(String(input)).pathname;
      if (path === "/api/v2/task/task1")
        return reply({ id: "task1", list: { id: "12345" } });
      if (path === "/api/v2/list/12345")
        return reply({ id: "12345", space: { id: "777" } });
      if (path === "/api/v2/team/555/space") return reply({ spaces: [{ id: "777" }] });
      if (path === "/api/v2/task/task1/comment")
        return reply({ comments: [{ id: "own22", user: { id: 707 }, comment_text: "Old" }] });
      if (path === "/api/v2/comment/own22" && method === "PUT") return reply({});
      throw Error("Unexpected API request");
    });
    await expect(
      runCatalogOperation(
        "clickup_edit_task_comment",
        { task_id: "task1", comment_id: "own22", text: "New" },
        grant(),
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_WRITE_OUTCOME_UNKNOWN");
    expect(api.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
  });
});
