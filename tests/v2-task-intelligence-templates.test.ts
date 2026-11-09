import { describe, expect, it, vi } from "vitest";
import { runCatalogOperation } from "../src/clickup/catalog-runtime.js";
import type { ReadGrant } from "../src/clickup/policy.js";
import { CLICKUP_MODEL_TOOL_CATALOG } from "../src/mcp/tool-catalog.js";

const grant = (scope: "list" | "workspace" = "list"): ReadGrant => ({
  subject: "github:11",
  clickupUserId: "707",
  workspaceId: "555",
  listId: "12345",
  resourceScope: scope,
  apiToken: "test-token-not-for-disclosure",
  quota: {
    idFromName: (value: string) => value,
    get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
  },
});
const task = (index: number, home = "12345", priority = 2) => ({
  id: "task-" + index,
  name: "Repair " + index,
  list: { id: home },
  priority: { id: String(priority) },
});
function fakeApi(options: {
  fullFirst?: boolean;
  foreign?: boolean;
  templateMissing?: boolean;
  wrongCreatedList?: boolean;
  templates?: number;
} = {}) {
  const calls: Array<{ path: string; method: string; query: URLSearchParams; body: unknown }> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({
      path: url.pathname,
      method,
      query: new URLSearchParams(url.search),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const reply = (value: unknown) => Response.json(value);
    if (url.pathname === "/api/v2/team/555/space")
      return reply({ spaces: [{ id: "777" }] });
    if (url.pathname === "/api/v2/list/12345")
      return reply({ id: "12345", space: { id: "777" } });
    if (url.pathname === "/api/v2/list/99999")
      return reply({ id: "99999", space: { id: "888" } });
    if (url.pathname === "/api/v2/list/12345/task" || url.pathname === "/api/v2/team/555/task") {
      const page = Number(url.searchParams.get("page"));
      if (options.fullFirst) {
        return reply({
          tasks:
            page === 0
              ? Array.from({ length: 100 }, (_, i) => task(i, "12345", 3))
              : [task(100, "12345", 2)],
        });
      }
      return reply({
        tasks: options.foreign ? [task(0), task(1, "99999")] : [task(0), task(1, "12345", 3)],
      });
    }
    if (url.pathname === "/api/v2/team/555/custom_item")
      return reply({ custom_items: [{ id: 0, name: "Task" }, { id: 1300, name: "Repair" }] });
    if (url.pathname === "/api/v2/team/555/taskTemplate") {
      const count = options.templates ?? 2;
      return reply({
        templates: Array.from({ length: count }, (_, i) => ({
          id: options.templateMissing ? "irrelevant" : i === 0 ? "repair-template" : "other-" + i,
          name: "Template " + i,
        })),
      });
    }
    if (url.pathname === "/api/v2/list/12345/taskTemplate/repair-template" && method === "POST")
      return reply({ id: "newtask" });
    if (url.pathname === "/api/v2/task/newtask")
      return reply({
        id: "newtask",
        name: "Repair intake",
        list: { id: options.wrongCreatedList ? "99999" : "12345" },
      });
    throw new Error("Unexpected endpoint: " + method + " " + url.pathname);
  });
  return { fetcher, calls };
}

describe("ClickUp v2 filtered tasks, custom types and templates", () => {
  it("exposes distinct tools and no token, secret, or dynamic execution argument", () => {
    for (const name of [
      "clickup_filter_tasks",
      "clickup_get_my_tasks",
      "clickup_get_custom_task_types",
      "clickup_get_task_templates",
      "clickup_create_task_from_template",
    ]) {
      const matches = CLICKUP_MODEL_TOOL_CATALOG.filter((x) => x.name === name);
      expect(matches).toHaveLength(1);
      for (const key of Object.keys(matches[0]!.inputSchema.properties))
        expect(key).not.toMatch(/api_token|secret|executor|operation_name/);
    }
  });

  it("scopes advanced filters to the configured List and sends server-side v2 parameters", async () => {
    const api = fakeApi();
    const result = await runCatalogOperation(
      "clickup_filter_tasks",
      {
        filter_statuses: ["In Progress"],
        filter_tag_names: ["Urgent"],
        filter_due_before_ms: 1795000000000,
        filter_assignee_ids: ["707"],
        filter_task_types: [1300],
        filter_include_closed: false,
      },
      grant(),
      api.fetcher as typeof fetch,
    );
    expect(result).toMatchObject({ scope: "list", incomplete: false });
    const query = api.calls.find((call) => call.path === "/api/v2/list/12345/task")?.query;
    expect(query?.getAll("statuses[]")).toEqual(["In Progress"]);
    expect(query?.getAll("tags[]")).toEqual(["Urgent"]);
    expect(query?.getAll("assignees[]")).toEqual(["707"]);
    expect(query?.getAll("custom_items[]")).toEqual(["1300"]);
    expect(query?.get("due_date_lt")).toBe("1795000000000");
    expect(api.calls.every((call) => call.path !== "/api/v2/team/555/task")).toBe(true);
  });

  it("uses the authenticated ClickUp user for own-task queries, never a supplied identity", async () => {
    const api = fakeApi();
    await runCatalogOperation("clickup_get_my_tasks", {}, grant("workspace"), api.fetcher as typeof fetch);
    const query = api.calls.find((call) => call.path === "/api/v2/team/555/task")?.query;
    expect(query?.getAll("assignees[]")).toEqual(["707"]);
    expect(api.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("rejects contradictory self and other-user assignment filters", async () => {
    const api = fakeApi();
    await expect(
      runCatalogOperation(
        "clickup_filter_tasks",
        { assigned_to_me: true, filter_assignee_ids: ["708"] },
        grant("workspace"),
        api.fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_INVALID_ARGUMENT");
    expect(api.calls).toEqual([]);
  });

  it("filters priority on the validated results rather than inventing an upstream parameter", async () => {
    const api = fakeApi();
    const result = await runCatalogOperation(
      "clickup_filter_tasks",
      { filter_priority: 2 },
      grant(),
      api.fetcher as typeof fetch,
    );
    expect(result).toMatchObject({ priority_filter: "client_side" });
    expect((result["tasks"] as Array<{ id: string }>).map((x) => x.id)).toEqual(["task-0"]);
    expect(api.calls.find((call) => call.path.endsWith("/task"))?.query.has("priority")).toBe(false);
  });

  it("returns bounded continuation and finds matching tasks after the first 100 results", async () => {
    const api = fakeApi({ fullFirst: true });
    const result = await runCatalogOperation(
      "clickup_filter_tasks",
      { filter_priority: 2 },
      grant(),
      api.fetcher as typeof fetch,
    );
    expect((result["tasks"] as Array<{ id: string }>).map((x) => x.id)).toEqual(["task-100"]);
    expect(result).toMatchObject({ incomplete: false, pages_scanned: 2 });
  });

  it("rejects a foreign home List in the same response before returning any data", async () => {
    const api = fakeApi({ foreign: true });
    await expect(
      runCatalogOperation("clickup_get_my_tasks", {}, grant(), api.fetcher as typeof fetch),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  });

  it("serializes typed Custom Field filters without an arbitrary URL or raw query", async () => {
    const api = fakeApi();
    await runCatalogOperation(
      "clickup_filter_tasks",
      {
        filter_custom_fields: [
          { field_id: "field-abc", operator: "=", value_text: "Repair" },
          { field_id: "field-def", operator: "IS NULL" },
        ],
      },
      grant(),
      api.fetcher as typeof fetch,
    );
    const query = api.calls.find((c) => c.path.endsWith("/task"))!.query;
    expect(JSON.parse(query.get("custom_fields")!)).toEqual([
      { field_id: "field-abc", operator: "=", value: "Repair" },
      { field_id: "field-def", operator: "IS NULL" },
    ]);
  });

  it("fails invalid filter values before making a task query", async () => {
    for (const filter of [
      { filter_due_before_ms: -1 },
      { filter_order_by: "random" },
      { filter_custom_fields: [{ field_id: "field", operator: "!", value_text: "x" }] },
      { filter_custom_fields: [{ field_id: "field", operator: "=", value_text: "x", value_number: 2 }] },
    ]) {
      const api = fakeApi();
      await expect(
        runCatalogOperation("clickup_filter_tasks", filter, grant(), api.fetcher as typeof fetch),
      ).rejects.toThrow("CLICKUP_INVALID_ARGUMENT");
      expect(api.calls.filter((c) => c.path.endsWith("/task"))).toEqual([]);
    }
  });

  it("guards Workspace custom task-type metadata against List-only grants", async () => {
    const api = fakeApi();
    await expect(
      runCatalogOperation("clickup_get_custom_task_types", {}, grant(), api.fetcher as typeof fetch),
    ).rejects.toThrow("CLICKUP_WORKSPACE_SCOPE_REQUIRED");
    const types = await runCatalogOperation(
      "clickup_get_custom_task_types", {}, grant("workspace"), api.fetcher as typeof fetch,
    );
    expect(types["custom_items"]).toMatchObject([{ id: 0 }, { id: 1300 }]);
  });

  it("lists a bounded template page, preserving in-page continuation", async () => {
    const api = fakeApi({ templates: 14 });
    const first = await runCatalogOperation(
      "clickup_get_task_templates",
      { max_results: 10 },
      grant("workspace"),
      api.fetcher as typeof fetch,
    );
    expect(first).toMatchObject({ next_template_page: 0, next_template_offset: 10, incomplete: true });
    const second = await runCatalogOperation(
      "clickup_get_task_templates",
      { template_page: 0, template_offset: 10 },
      grant("workspace"),
      api.fetcher as typeof fetch,
    );
    expect((second["templates"] as Array<unknown>).length).toBe(4);
    expect(second["incomplete"]).toBe(false);
  });

  it("blocks template discovery without Workspace authorization", async () => {
    const api = fakeApi();
    await expect(
      runCatalogOperation("clickup_get_task_templates", {}, grant(), api.fetcher as typeof fetch),
    ).rejects.toThrow("CLICKUP_WORKSPACE_SCOPE_REQUIRED");
    expect(api.calls).toEqual([]);
  });

  it("creates once from a verified Workspace template in an authorized List and checks the new task", async () => {
    const api = fakeApi();
    const result = await runCatalogOperation(
      "clickup_create_task_from_template",
      { list_id: "12345", template_id: "repair-template", task_name: "Repair intake" },
      grant("workspace"),
      api.fetcher as typeof fetch,
    );
    expect(result).toMatchObject({ success: true, task_id: "newtask", verified_by_readback: true });
    const writes = api.calls.filter((call) => call.method !== "GET");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body).toEqual({ name: "Repair intake" });
    expect(writes[0]?.path).toBe("/api/v2/list/12345/taskTemplate/repair-template");
  });

  it("rejects forged templates before POSTing anything", async () => {
    const api = fakeApi({ templateMissing: true });
    await expect(
      runCatalogOperation(
        "clickup_create_task_from_template",
        { list_id: "12345", template_id: "repair-template", task_name: "Never create" },
        grant("workspace"),
        api.fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(api.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("reports uncertain writes without repeating POST when the task is returned in a foreign List", async () => {
    const api = fakeApi({ wrongCreatedList: true });
    await expect(
      runCatalogOperation(
        "clickup_create_task_from_template",
        { list_id: "12345", template_id: "repair-template", task_name: "Verify" },
        grant("workspace"),
        api.fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_WRITE_OUTCOME_UNKNOWN");
    expect(api.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });
});
