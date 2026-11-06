import { describe, expect, it, vi } from "vitest";
import { runCatalogOperation } from "../src/clickup/catalog-runtime.js";
import type { ReadGrant } from "../src/clickup/policy.js";
import { CLICKUP_MODEL_TOOL_CATALOG } from "../src/mcp/tool-catalog.js";

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

function fixtureApi(
  taskComments: (method: string, path: string, init: RequestInit | undefined) => Response,
) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    if (path === "/api/v2/task/task1" && method === "GET")
      return reply({ id: "task1", list: { id: "12345" } });
    if (path === "/api/v2/list/12345" && method === "GET")
      return reply({ id: "12345", space: { id: "777" } });
    if (path === "/api/v2/team/555/space" && method === "GET")
      return reply({ spaces: [{ id: "777" }] });
    if (path === "/api/v2/team" && method === "GET")
      return reply({
        teams: [
          {
            id: "555",
            members: [{ user: { id: 707 } }, { user: { id: 708 } }],
          },
        ],
      });
    return taskComments(method, path, init);
  });
}

describe("comment assignment, reassignment and resolution", () => {
  it("exposes assignment in the real create and edit tool schemas", () => {
    const create = CLICKUP_MODEL_TOOL_CATALOG.find(
      (item) => item.name === "clickup_create_task_comment",
    );
    const edit = CLICKUP_MODEL_TOOL_CATALOG.find(
      (item) => item.name === "clickup_edit_task_comment",
    );
    expect(create?.inputSchema.properties).toHaveProperty("assignee_id");
    expect(create?.inputSchema.required).toEqual(["task_id", "text"]);
    expect(edit?.inputSchema.properties).toHaveProperty("assignee_id");
    expect(edit?.inputSchema.properties).toHaveProperty("resolved");
    expect(edit?.inputSchema.required).toEqual(["task_id", "comment_id"]);
  });

  it("creates an assigned comment only for an authorized member and verifies readback", async () => {
    const api = fixtureApi((method, path, init) => {
      if (path === "/api/v2/task/task1/comment" && method === "POST") {
        expect(JSON.parse(String(init?.body))).toEqual({
          comment_text: "Ask Sameer to check with suppliers",
          notify_all: false,
          assignee: 708,
        });
        return reply({ id: 190 });
      }
      if (path === "/api/v2/task/task1/comment" && method === "GET")
        return reply({
          comments: [
            {
              id: "190",
              user: { id: 707 },
              assignee: { id: 708 },
              comment_text: "Ask Sameer to check with suppliers",
            },
          ],
        });
      throw Error("Unexpected request " + method + " " + path);
    });
    const result = await runCatalogOperation(
      "clickup_create_task_comment",
      { task_id: "task1", text: "Ask Sameer to check with suppliers", assignee_id: "708" },
      grant(),
      api as typeof fetch,
    );
    expect(result).toMatchObject({
      id: 190,
      assignee_id: "708",
      verified_by_readback: true,
    });
    expect(api.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("assigns an existing own comment without rewriting its text or changing the parent task", async () => {
    let changed = false;
    const api = fixtureApi((method, path, init) => {
      if (path === "/api/v2/task/task1/comment" && method === "GET")
        return reply({
          comments: [
            {
              id: "own22",
              user: { id: 707 },
              assignee: changed ? { id: 708 } : null,
              group_assignee: null,
              comment_text: "Please check replacement barrel availability.",
            },
          ],
        });
      if (path === "/api/v2/comment/own22" && method === "PUT") {
        expect(JSON.parse(String(init?.body))).toEqual({
          comment_text: "Please check replacement barrel availability.",
          assignee: 708,
          resolved: false,
        });
        changed = true;
        return reply({});
      }
      throw Error("Unexpected request " + method + " " + path);
    });
    const result = await runCatalogOperation(
      "clickup_edit_task_comment",
      { task_id: "task1", comment_id: "own22", assignee_id: "708" },
      grant(),
      api as typeof fetch,
    );
    expect(result).toMatchObject({
      success: true,
      verified_by_readback: true,
      comment_id: "own22",
    });
    expect(api.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
    expect(
      api.mock.calls.some(
        ([req, init]) =>
          new URL(String(req)).pathname === "/api/v2/task/task1" && init?.method === "PUT",
      ),
    ).toBe(false);
  });

  it("resolves a comment while preserving its current assignee", async () => {
    let changed = false;
    const api = fixtureApi((method, path, init) => {
      if (path === "/api/v2/task/task1/comment" && method === "GET")
        return reply({
          comments: [
            {
              id: "own22",
              user: { id: 707 },
              assignee: { id: 708 },
              resolved: changed,
              comment_text: "Supplier contacted",
            },
          ],
        });
      if (path === "/api/v2/comment/own22" && method === "PUT") {
        expect(JSON.parse(String(init?.body))).toEqual({
          comment_text: "Supplier contacted",
          assignee: 708,
          resolved: true,
        });
        changed = true;
        return reply({});
      }
      throw Error("Unexpected request " + method + " " + path);
    });
    const result = await runCatalogOperation(
      "clickup_edit_task_comment",
      { task_id: "task1", comment_id: "own22", resolved: true },
      grant(),
      api as typeof fetch,
    );
    expect(result["verified_by_readback"]).toBe(true);
    expect(api.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(true);
  });

  it("rejects unknown members before writing anything", async () => {
    const api = fixtureApi((method, path) => {
      if (path === "/api/v2/task/task1/comment" && method === "GET")
        return reply({
          comments: [{ id: "own22", user: { id: 707 }, assignee: null, comment_text: "Original" }],
        });
      throw Error("Unexpected request " + method + " " + path);
    });
    await expect(
      runCatalogOperation(
        "clickup_edit_task_comment",
        { task_id: "task1", comment_id: "own22", assignee_id: "999" },
        grant(),
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(api.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
  });

  it("rejects assignment on comments written by someone else", async () => {
    const api = fixtureApi((method, path) => {
      if (path === "/api/v2/task/task1/comment" && method === "GET")
        return reply({
          comments: [
            { id: "other22", user: { id: 709 }, assignee: null, comment_text: "Original" },
          ],
        });
      throw Error("Unexpected request " + method + " " + path);
    });
    await expect(
      runCatalogOperation(
        "clickup_edit_task_comment",
        { task_id: "task1", comment_id: "other22", assignee_id: "708" },
        grant(),
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(api.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
  });

  it("rejects ambiguous rich-text-only comments before assignment", async () => {
    const api = fixtureApi((method, path) => {
      if (path === "/api/v2/task/task1/comment" && method === "GET")
        return reply({
          comments: [
            { id: "own22", user: { id: 707 }, assignee: null, comment: [{ text: "image.png" }] },
          ],
        });
      throw Error("Unexpected request " + method + " " + path);
    });
    await expect(
      runCatalogOperation(
        "clickup_edit_task_comment",
        { task_id: "task1", comment_id: "own22", assignee_id: "708" },
        grant(),
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_INVALID_ARGUMENT");
    expect(api.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
  });

  it("does not claim success when ClickUp ignores the assignment", async () => {
    const api = fixtureApi((method, path) => {
      if (path === "/api/v2/task/task1/comment" && method === "GET")
        return reply({
          comments: [{ id: "own22", user: { id: 707 }, assignee: null, comment_text: "Original" }],
        });
      if (path === "/api/v2/comment/own22" && method === "PUT") return reply({});
      throw Error("Unexpected request " + method + " " + path);
    });
    await expect(
      runCatalogOperation(
        "clickup_edit_task_comment",
        { task_id: "task1", comment_id: "own22", assignee_id: "708" },
        grant(),
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_WRITE_OUTCOME_UNKNOWN");
    expect(api.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
  });

  it("does not silently assign threaded replies or operate without a company grant", async () => {
    const api = fixtureApi(() => {
      throw Error("No write should happen");
    });
    await expect(
      runCatalogOperation(
        "clickup_create_task_comment",
        { task_id: "task1", text: "Reply", parent_comment_id: "190", assignee_id: "708" },
        grant(),
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_INVALID_ARGUMENT");
    await expect(
      runCatalogOperation(
        "clickup_edit_task_comment",
        { task_id: "task1", comment_id: "own22", assignee_id: "708" },
        grant(false),
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_WORKSPACE_SCOPE_REQUIRED");
    expect(api.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
  });
});
