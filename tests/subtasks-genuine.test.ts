import { describe, expect, it, vi } from "vitest";
import { OPERATIONAL_CATALOG_NAMES, runCatalogOperation } from "../src/clickup/catalog-runtime.js";
import { CLICKUP_MODEL_TOOL_CATALOG } from "../src/mcp/tool-catalog.js";
import { COMPANY_SAFE_WRITE_OPERATIONS, type ReadGrant } from "../src/clickup/policy.js";

const grant = (scope: "workspace" | "list" = "workspace"): ReadGrant => ({
  subject: "github:11",
  clickupUserId: "707",
  workspaceId: "555",
  listId: "12345",
  resourceScope: scope,
  companyListTaskAccess: scope === "list",
  apiToken: "test-token",
  quota: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
  },
});

const task = (id: string, parent: string | null, listId = "12345", name = id) => ({
  id,
  parent,
  list: { id: listId },
  name,
  assignees: [{ id: 707 }],
  status: { status: "open" },
});

const mockApi = (
  options: {
    foreignParent?: boolean;
    missingParent?: boolean;
    duplicate?: boolean;
    fullPage?: boolean;
    wrongCreateReadback?: boolean;
    wrongReparentReadback?: boolean;
    unknownWrite?: boolean;
    cyclic?: boolean;
  } = {},
) => {
  const state: Record<string, ReturnType<typeof task>> = {
    parent1: task("parent1", null, options.foreignParent ? "99999" : "12345", "Receiving"),
    parent2: task("parent2", options.cyclic ? "child1" : null, "12345", "Other receiving"),
    child1: task("child1", null, "12345", "Torcraft Cases"),
    sub1: task("sub1", "parent1", "12345", "Existing child"),
  };
  if (options.missingParent) delete (state["parent1"] as unknown as Record<string, unknown>).parent;
  if (options.duplicate) state["duplicate"] = task("duplicate", "parent1", "12345", "New subtask");
  const calls: Array<{ path: string; query: URLSearchParams; method: string; body: unknown }> = [];
  const fetcher = vi.fn(async (req: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(req));
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ path: url.pathname, query: url.searchParams, method, body });
    if (url.hostname !== "api.clickup.com") throw Error("foreign host");
    if (url.pathname === "/api/v2/list/12345")
      return Response.json({ id: "12345", space: { id: "777" } });
    if (url.pathname === "/api/v2/list/99999")
      return Response.json({ id: "99999", space: { id: "888" } });
    if (url.pathname === "/api/v2/team/555/space")
      return Response.json({ spaces: [{ id: "777" }] });
    if (url.pathname.startsWith("/api/v2/task/") && method === "GET") {
      const key = url.pathname.split("/").at(-1) ?? "";
      if (!state[key]) return new Response("not found", { status: 404 });
      if (key === "new-child" && options.wrongCreateReadback)
        return Response.json({ ...state[key], parent: "different" });
      if (
        key === "child1" &&
        options.wrongReparentReadback &&
        body === null &&
        state[key]?.parent === "parent2"
      )
        return Response.json({ ...state[key], parent: "parent1" });
      return Response.json(state[key]);
    }
    if (url.pathname === "/api/v2/team/555/task" && method === "GET") {
      if (options.fullPage)
        return Response.json({
          tasks: Array.from({ length: 100 }, (_, index) =>
            task("many" + index, "parent1", "12345", "Entry " + index),
          ),
        });
      const parentId = url.searchParams.get("parent");
      const filtered = Object.values(state).filter((entry) => entry.parent === parentId);
      return Response.json({ tasks: filtered });
    }
    if (url.pathname === "/api/v2/list/12345/task" && method === "POST") {
      state["new-child"] = task(
        "new-child",
        String(body?.["parent"]),
        "12345",
        String(body?.["name"]),
      );
      if (options.unknownWrite) throw Error("uncertain delivery");
      return Response.json({ id: "new-child" }, { status: 200 });
    }
    if (url.pathname === "/api/v2/task/child1" && method === "PUT") {
      state["child1"] = { ...state["child1"]!, parent: String(body?.["parent"]) };
      if (options.unknownWrite) throw Error("uncertain PUT");
      return Response.json(state["child1"]);
    }
    throw Error("unexpected path: " + method + " " + url.pathname);
  });
  const writes = () => calls.filter((c) => c.method !== "GET");
  return { fetcher, calls, writes, state };
};

describe("Issue #139 — genuine ClickUp subtask relations", () => {
  it("advertises three typed real tools in the one Serviteur catalogue", () => {
    expect(OPERATIONAL_CATALOG_NAMES).toContain("clickup_create_subtask");
    expect(OPERATIONAL_CATALOG_NAMES).toContain("clickup_list_direct_subtasks");
    expect(OPERATIONAL_CATALOG_NAMES).toContain("clickup_reparent_task");
    for (const name of ["clickup_create_subtask", "clickup_reparent_task"])
      expect(COMPANY_SAFE_WRITE_OPERATIONS.has(name)).toBe(true);
    expect(
      CLICKUP_MODEL_TOOL_CATALOG.find((x) => x.name === "clickup_list_direct_subtasks")?.effect,
    ).toBe("read");
  });

  it("creates an actual child with verified parent and preserved details, never a related link", async () => {
    const api = mockApi();
    const result = await runCatalogOperation(
      "clickup_create_subtask",
      {
        parent_task_id: "parent1",
        new_task: {
          name: "New subtask",
          description_markdown: "**Please inspect**",
          status: "open",
          priority: 2,
          due_date_ms: 1794574800000,
          assignee_ids: ["707"],
        },
      },
      grant(),
      api.fetcher as typeof fetch,
    );
    expect(result).toMatchObject({
      task_id: "new-child",
      parent_task_id: "parent1",
      verified_by_readback: true,
    });
    expect(api.writes()).toHaveLength(1);
    expect(api.writes()[0]?.body).toMatchObject({
      name: "New subtask",
      parent: "parent1",
      markdown_content: "**Please inspect**",
      status: "open",
      priority: 2,
      due_date: 1794574800000,
      due_date_time: true,
      assignees: [707],
      notify_all: false,
    });
    expect(
      api.calls.find((call) => call.path === "/api/v2/team/555/task")?.query.get("parent"),
    ).toBe("parent1");
    expect(
      api.calls.find((call) => call.path === "/api/v2/team/555/task")?.query.get("list_ids[]"),
    ).toBe("12345");
    expect(api.state["new-child"]?.parent).toBe("parent1");
  });

  it("refuses name collision, uncertain complete preflight, and a foreign home List before POST", async () => {
    for (const config of [
      { duplicate: true },
      { fullPage: true },
      { foreignParent: true },
      { missingParent: true },
    ]) {
      const api = mockApi(config);
      await expect(
        runCatalogOperation(
          "clickup_create_subtask",
          { parent_task_id: "parent1", new_task: { name: "New subtask" } },
          grant(),
          api.fetcher as typeof fetch,
        ),
      ).rejects.toThrow();
      expect(api.writes()).toHaveLength(0);
    }
  });

  it("never duplicates a child after unknown POST or unverified created-parent readback", async () => {
    for (const config of [{ unknownWrite: true }, { wrongCreateReadback: true }]) {
      const api = mockApi(config);
      await expect(
        runCatalogOperation(
          "clickup_create_subtask",
          { parent_task_id: "parent1", new_task: { name: "New subtask" } },
          grant(),
          api.fetcher as typeof fetch,
        ),
      ).rejects.toThrow("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      expect(api.writes()).toHaveLength(1);
    }
  });

  it("lists only immediate children and exposes exact bounded page metadata", async () => {
    const api = mockApi();
    const result = await runCatalogOperation(
      "clickup_list_direct_subtasks",
      { parent_task_id: "parent1", max_results: 1, task_page: 0, task_offset: 0 },
      grant("list"),
      api.fetcher as typeof fetch,
    );
    expect(result).toMatchObject({
      source: "clickup-api-v2",
      parent_task_id: "parent1",
      incomplete: false,
      next_task_page: null,
      next_task_offset: null,
    });
    expect(result["subtasks"]).toHaveLength(1);
    expect((result["subtasks"] as Array<{ parent: string }>)[0]?.parent).toBe("parent1");
    expect(api.writes()).toHaveLength(0);
  });

  it("does not conceal pagination when a full 100-item provider page might have successors", async () => {
    const api = mockApi({ fullPage: true });
    const result = await runCatalogOperation(
      "clickup_list_direct_subtasks",
      { parent_task_id: "parent1", max_results: 50, task_page: 0, task_offset: 50 },
      grant(),
      api.fetcher as typeof fetch,
    );
    expect(result).toMatchObject({ next_task_page: 1, next_task_offset: 0, incomplete: true });
    expect(result["subtasks"]).toHaveLength(50);
  });

  it("reparents a top-level existing task in place, preserving its ID and title", async () => {
    const api = mockApi();
    const result = await runCatalogOperation(
      "clickup_reparent_task",
      {
        task_id: "child1",
        parent_task_id: "parent2",
        expected_task_name: "Torcraft Cases",
        expected_current_parent_id: "none",
      },
      grant(),
      api.fetcher as typeof fetch,
    );
    expect(result).toMatchObject({
      task_id: "child1",
      parent_task_id: "parent2",
      previous_parent_id: null,
      verified_by_readback: true,
    });
    expect(api.writes()).toHaveLength(1);
    expect(api.writes()[0]?.method).toBe("PUT");
    expect(api.writes()[0]?.body).toEqual({ parent: "parent2" });
  });

  it("supports idempotent no-write reparent when already under the requested parent", async () => {
    const api = mockApi();
    api.state["child1"]!.parent = "parent2";
    const result = await runCatalogOperation(
      "clickup_reparent_task",
      {
        task_id: "child1",
        parent_task_id: "parent2",
        expected_task_name: "Torcraft Cases",
        expected_current_parent_id: "parent2",
      },
      grant(),
      api.fetcher as typeof fetch,
    );
    expect(result["already_under_parent"]).toBe(true);
    expect(api.writes()).toHaveLength(0);
  });

  it("rejects wrong source state, mismatched task name, self-parent and ancestry cycle before PUT", async () => {
    for (const entry of [
      { expected_current_parent_id: "parent1" },
      { expected_task_name: "Wrong current title" },
      { parent_task_id: "child1" },
    ]) {
      const api = mockApi();
      await expect(
        runCatalogOperation(
          "clickup_reparent_task",
          {
            task_id: "child1",
            parent_task_id: "parent2",
            expected_task_name: "Torcraft Cases",
            expected_current_parent_id: "none",
            ...entry,
          },
          grant(),
          api.fetcher as typeof fetch,
        ),
      ).rejects.toThrow();
      expect(api.writes()).toHaveLength(0);
    }
    const cycle = mockApi({ cyclic: true });
    await expect(
      runCatalogOperation(
        "clickup_reparent_task",
        {
          task_id: "child1",
          parent_task_id: "parent2",
          expected_task_name: "Torcraft Cases",
          expected_current_parent_id: "none",
        },
        grant(),
        cycle.fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(cycle.writes()).toHaveLength(0);
  });

  it("never repeats uncertain PUT and verifies persisted parent after response errors", async () => {
    const api = mockApi({ unknownWrite: true });
    const result = await runCatalogOperation(
      "clickup_reparent_task",
      {
        task_id: "child1",
        parent_task_id: "parent2",
        expected_task_name: "Torcraft Cases",
        expected_current_parent_id: "none",
      },
      grant(),
      api.fetcher as typeof fetch,
    );
    expect(result["verified_by_readback"]).toBe(true);
    expect(api.writes()).toHaveLength(1);
  });

  it("returns unknown without repeating when update did not persist expected parent", async () => {
    const api = mockApi({ wrongReparentReadback: true });
    await expect(
      runCatalogOperation(
        "clickup_reparent_task",
        {
          task_id: "child1",
          parent_task_id: "parent2",
          expected_task_name: "Torcraft Cases",
          expected_current_parent_id: "none",
        },
        grant(),
        api.fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_WRITE_OUTCOME_UNKNOWN");
    expect(api.writes()).toHaveLength(1);
  });
});
