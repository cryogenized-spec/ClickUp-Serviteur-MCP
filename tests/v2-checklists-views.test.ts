import { describe, expect, it, vi } from "vitest";
import { runCatalogOperation } from "../src/clickup/catalog-runtime.js";
import type { ReadGrant } from "../src/clickup/policy.js";
import { CLICKUP_MODEL_TOOL_CATALOG } from "../src/mcp/tool-catalog.js";

const checklistId = "b955c4dc-b8a8-48d8-a0c6-b4200788a683";
const itemId = "e491-47f5-9fd8-d1dc4cedcc6f";
const grant = (mode: "list" | "workspace" = "list", company = false): ReadGrant => ({
  subject: "github:11",
  clickupUserId: "707",
  workspaceId: "555",
  listId: "12345",
  resourceScope: mode,
  ...(company ? { companyListTaskAccess: true } : {}),
  apiToken: "synthetic-test-token",
  quota: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
  },
});

function fakeApi(options: { taskList?: string; wrongView?: boolean; foreignViewTask?: boolean } = {}) {
  const calls: Array<{ method: string; path: string; query: string; body: unknown }> = [];
  let changed = false;
  const api = vi.fn(async (req: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(req));
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, method, query: url.search, body });
    const reply = (payload: unknown) => Response.json(payload);
    if (path === "/api/v2/list/12345")
      return reply({ id: "12345", space: { id: "777" } });
    if (path === "/api/v2/team/555/space")
      return reply({ spaces: [{ id: "777" }] });
    if (path === "/api/v2/task/task1")
      return reply({
        id: "task1",
        list: { id: options.taskList ?? "12345" },
        checklists: [
          {
            id: checklistId,
            task_id: "task1",
            name: "Inspection",
            items: [{ id: itemId, name: "Check display", resolved: changed }],
          },
        ],
      });
    if (path === "/api/v2/task/task1/checklist" && method === "POST") {
      return reply({
        checklist: { id: checklistId, task_id: "task1", name: "Inspection", items: [] },
      });
    }
    if (path === "/api/v2/checklist/" + checklistId + "/checklist_item" && method === "POST")
      return reply({
        checklist: {
          id: checklistId,
          task_id: "task1",
          items: [{ id: itemId, name: "Check display" }],
        },
      });
    if (
      path === "/api/v2/checklist/" + checklistId + "/checklist_item/" + itemId &&
      method === "PUT"
    ) {
      changed = true;
      return reply({});
    }
    if (path === "/api/v2/list/12345/view")
      return reply({
        views: [
          {
            id: "vw1",
            name: "QC tasks",
            type: "list",
            parent: { type: 6, id: "12345" },
          },
        ],
      });
    if (path === "/api/v2/team/555/view")
      return reply({
        views: [
          {
            id: "workview",
            name: "Everything",
            parent: { type: 7, id: "555" },
          },
        ],
      });
    if (path === "/api/v2/view/vw1")
      return reply({
        view: {
          id: "vw1",
          type: "list",
          parent: { type: options.wrongView ? 7 : 6, id: "12345" },
        },
      });
    if (path === "/api/v2/view/vw1/task")
      return reply({
        tasks: Array.from({ length: 15 }, (_, index) => ({
          id: "task-" + index,
          list: { id: options.foreignViewTask && index === 7 ? "98765" : "12345" },
          name: "Task " + index,
        })),
      });
    throw new Error("Unexpected API route: " + method + " " + path);
  });
  return { api, calls };
}

describe("ClickUp v2 dedicated checklists and saved Views", () => {
  it("registers only dedicated named tools and no credentials in input schemas", () => {
    for (const name of [
      "clickup_create_task_checklist",
      "clickup_create_checklist_item",
      "clickup_update_checklist_item",
      "clickup_get_list_views",
      "clickup_get_workspace_views",
      "clickup_get_view_tasks",
    ]) {
      const tools = CLICKUP_MODEL_TOOL_CATALOG.filter((tool) => tool.name === name);
      expect(tools).toHaveLength(1);
      expect(tools[0]?.inputSchema.properties).not.toHaveProperty("api_token");
      expect(tools[0]?.inputSchema.properties).not.toHaveProperty("operation_id");
    }
  });

  it("forbids checklist task-ID writes for a normal restricted List grant", async () => {
    const { api, calls } = fakeApi();
    await expect(
      runCatalogOperation(
        "clickup_create_task_checklist",
        { task_id: "task1", name: "Inspection" },
        grant(),
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_WORKSPACE_SCOPE_REQUIRED");
    expect(calls).toEqual([]);
  });

  it("creates one checklist after validating the task against company List scope", async () => {
    const { api, calls } = fakeApi();
    const created = await runCatalogOperation(
      "clickup_create_task_checklist",
      { task_id: "task1", name: "Inspection" },
      grant("list", true),
      api as typeof fetch,
    );
    expect(created).toMatchObject({
      checklist: { id: checklistId, task_id: "task1" },
    });
    expect(calls.filter((entry) => entry.method === "POST")).toEqual([
      {
        method: "POST",
        path: "/api/v2/task/task1/checklist",
        query: "",
        body: { name: "Inspection" },
      },
    ]);
  });

  it("refuses any checklist write for a task in a foreign home List", async () => {
    const { api, calls } = fakeApi({ taskList: "98765" });
    await expect(
      runCatalogOperation(
        "clickup_create_task_checklist",
        { task_id: "task1", name: "Foreign" },
        grant("list", true),
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(calls.every((entry) => entry.method === "GET")).toBe(true);
  });

  it("creates a checklist item only after its checklist and task are verified", async () => {
    const { api, calls } = fakeApi();
    const created = await runCatalogOperation(
      "clickup_create_checklist_item",
      { task_id: "task1", checklist_id: checklistId, name: "Check display" },
      grant("list", true),
      api as typeof fetch,
    );
    expect(created["checklist"]).toMatchObject({ id: checklistId });
    expect(calls.find((entry) => entry.method === "POST")?.path).toBe(
      "/api/v2/checklist/" + checklistId + "/checklist_item",
    );
  });

  it("rejects an unrelated checklist ID without making a write request", async () => {
    const { api, calls } = fakeApi();
    await expect(
      runCatalogOperation(
        "clickup_create_checklist_item",
        {
          task_id: "task1",
          checklist_id: "d1111111-1111-4111-8111-111111111111",
          name: "Never post",
        },
        grant("list", true),
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(calls.every((entry) => entry.method === "GET")).toBe(true);
  });

  it("marks only the verified checklist item complete and reads back the change", async () => {
    const { api, calls } = fakeApi();
    const updated = await runCatalogOperation(
      "clickup_update_checklist_item",
      {
        task_id: "task1",
        checklist_id: checklistId,
        checklist_item_id: itemId,
        resolved: true,
      },
      grant("list", true),
      api as typeof fetch,
    );
    expect(updated).toMatchObject({ success: true, verified_by_readback: true });
    expect(calls.filter((entry) => entry.method === "PUT")).toHaveLength(1);
    expect(calls.filter((entry) => entry.method === "PUT")[0]?.body).toEqual({
      resolved: true,
    });
  });

  it("rejects an unverified item ID before any mutation", async () => {
    const { api, calls } = fakeApi();
    await expect(
      runCatalogOperation(
        "clickup_update_checklist_item",
        {
          task_id: "task1",
          checklist_id: checklistId,
          checklist_item_id: "d1111111-1111-4111-8111-111111111111",
          resolved: true,
        },
        grant("list", true),
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(calls.every((entry) => entry.method === "GET")).toBe(true);
  });

  it("lists only saved Views under the explicitly authorized List", async () => {
    const { api } = fakeApi();
    const output = await runCatalogOperation(
      "clickup_get_list_views",
      { list_id: "12345" },
      grant("list"),
      api as typeof fetch,
    );
    expect(output["views"]).toMatchObject([
      { id: "vw1", parent: { type: 6, id: "12345" } },
    ]);
  });

  it("blocks Workspace view listing unless Workspace authorization exists", async () => {
    const { api, calls } = fakeApi();
    await expect(
      runCatalogOperation("clickup_get_workspace_views", {}, grant("list"), api as typeof fetch),
    ).rejects.toThrow("CLICKUP_WORKSPACE_SCOPE_REQUIRED");
    expect(calls).toEqual([]);
    const allowed = await runCatalogOperation(
      "clickup_get_workspace_views",
      {},
      grant("workspace"),
      api as typeof fetch,
    );
    expect(allowed["views"]).toMatchObject([
      { id: "workview", parent: { type: 7, id: "555" } },
    ]);
  });

  it("paginates saved View tasks without skipping dense results", async () => {
    const { api } = fakeApi();
    const first = await runCatalogOperation(
      "clickup_get_view_tasks",
      { view_id: "vw1", list_id: "12345", max_results: 10 },
      grant("list"),
      api as typeof fetch,
    );
    expect(first).toMatchObject({
      next_view_page: 0,
      next_view_offset: 10,
      incomplete: true,
    });
    const second = await runCatalogOperation(
      "clickup_get_view_tasks",
      { view_id: "vw1", list_id: "12345", view_page: 0, view_offset: 10 },
      grant("list"),
      api as typeof fetch,
    );
    expect(second).toMatchObject({ incomplete: false, next_view_page: null });
    expect(
      [...(first["tasks"] as Array<{ id: string }>), ...(second["tasks"] as Array<{ id: string }>)]
        .map((task) => task.id),
    ).toEqual(Array.from({ length: 15 }, (_, index) => "task-" + index));
  });

  it("rejects cross-scope saved Views before fetching their tasks", async () => {
    const { api, calls } = fakeApi({ wrongView: true });
    await expect(
      runCatalogOperation(
        "clickup_get_view_tasks",
        { view_id: "vw1", list_id: "12345" },
        grant("list"),
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(calls.some((entry) => entry.path === "/api/v2/view/vw1/task")).toBe(false);
  });

  it("rejects a foreign-home task even when the View itself is authorized", async () => {
    const { api } = fakeApi({ foreignViewTask: true });
    await expect(
      runCatalogOperation(
        "clickup_get_view_tasks",
        { view_id: "vw1", list_id: "12345" },
        grant("list"),
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  });
});
