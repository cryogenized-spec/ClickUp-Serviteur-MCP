import { describe, expect, it, vi } from "vitest";
import { OPERATIONAL_CATALOG_NAMES, runCatalogOperation } from "../src/clickup/catalog-runtime.js";
import type { ReadGrant } from "../src/clickup/policy.js";
import { CLICKUP_MODEL_TOOL_CATALOG } from "../src/mcp/tool-catalog.js";

const makeGrant = (
  subject = "github:11",
  clickupUserId = "707",
  apiToken = "person-707",
): ReadGrant => ({
  subject,
  clickupUserId,
  workspaceId: "555",
  listId: "12345",
  resourceScope: "workspace",
  apiToken,
  quota: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
  },
});
const makeListGrant = (): ReadGrant => ({ ...makeGrant(), resourceScope: "list" });
const makeCompanyListGrant = (): ReadGrant => ({ ...makeListGrant(), companyListTaskAccess: true });
const reply = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Content-Type": "application/json" } });
const fixture = (path: string) => {
  if (path === "/api/v2/list/12345") return { id: "12345", space: { id: "777" } };
  if (path === "/api/v2/list/99999") return { id: "99999", space: { id: "888" } };
  if (path === "/api/v2/list/12346") return { id: "12346", space: { id: "777" } };
  if (path === "/api/v2/team/555/space") return { spaces: [{ id: "777", name: "Operations" }] };
  if (path === "/api/v2/task/abc123") return { id: "abc123", list: { id: "12345" }, name: "Order" };
  return { id: "new123", name: "Test" };
};
const fakeApi = () =>
  vi.fn(async (req: RequestInfo | URL, _init?: RequestInit) => {
    const u = new URL(String(req));
    if (u.host !== "api.clickup.com") throw Error("wrong host");
    const p = u.pathname;
    return reply(fixture(p), 200);
  });

describe("Phase 7 individual OAuth and native catalogue - adversarial tests", () => {
  it("registers all 50 REST backed capabilities including the read-only PDF job-card tool", () => {
    expect(OPERATIONAL_CATALOG_NAMES).toHaveLength(57);
    expect(new Set(OPERATIONAL_CATALOG_NAMES).size).toBe(57);
    expect(
      OPERATIONAL_CATALOG_NAMES.every((n) => CLICKUP_MODEL_TOOL_CATALOG.some((s) => s.name === n)),
    ).toBe(true);
    expect(OPERATIONAL_CATALOG_NAMES).toContain("clickup_attach_file_to_task");
  });

  it("creates a task in a verified Workspace List using solely the connected employee OAuth token", async () => {
    const fetched = fakeApi();
    const response = await runCatalogOperation(
      "clickup_create_task",
      { list_id: "12345", new_task: { name: "Sales request" } },
      makeGrant(),
      fetched as typeof fetch,
    );
    expect(response).toMatchObject({ id: "new123" });
    expect(fetched).toHaveBeenCalledTimes(3);
    const calls = fetched.mock.calls;
    expect(calls.map(([r]) => new URL(String(r)).pathname)).toEqual([
      "/api/v2/list/12345",
      "/api/v2/team/555/space",
      "/api/v2/list/12345/task",
    ]);
    expect(
      calls.every(
        ([, i]) => (i?.headers as Record<string, string>)["Authorization"] === "person-707",
      ),
    ).toBe(true);
    expect(calls[2]?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(calls[2]?.[1]?.body))).toMatchObject({ name: "Sales request" });
  });

  it("preserves exact UTC milliseconds and time-enabled due dates for create, update and bulk", async () => {
    // 15:00 South Africa local (UTC+02:00); never normalise to date-only 04:00.
    const due = Date.parse("2026-10-28T13:00:00.000Z");
    const requests = fakeApi();
    await runCatalogOperation(
      "clickup_create_task",
      { list_id: "12345", new_task: { name: "Precise deadline", due_date_ms: due } },
      makeGrant(),
      requests as typeof fetch,
    );
    await runCatalogOperation(
      "clickup_update_task",
      { task_id: "abc123", changes: { due_date_ms: due } },
      makeGrant(),
      requests as typeof fetch,
    );
    await runCatalogOperation(
      "clickup_create_bulk_tasks",
      { list_id: "12345", tasks: [{ name: "Precise bulk deadline", due_date_ms: due }] },
      makeGrant(),
      requests as typeof fetch,
    );
    const writes = requests.mock.calls
      .map(([, init]) => init)
      .filter((init) => init?.method === "POST" || init?.method === "PUT");
    expect(writes).toHaveLength(3);
    for (const init of writes) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({ due_date: due, due_date_time: true });
    }
  });

  it("keeps legacy List-scoped search inside its approved home List", async () => {
    const requests: string[] = [];
    const f = vi.fn(async (req: RequestInfo | URL) => {
      const url = new URL(String(req));
      requests.push(url.pathname);
      if (url.pathname === "/api/v2/list/12345")
        return reply({ id: "12345", space: { id: "777" } });
      if (url.pathname === "/api/v2/team/555/space") return reply({ spaces: [{ id: "777" }] });
      if (url.pathname === "/api/v2/list/12345/task")
        return reply({ tasks: [{ id: "own1", name: "Stocktake", list: { id: "12345" } }] });
      throw Error("unexpected wider Workspace fetch: " + url.pathname);
    });
    const result = await runCatalogOperation(
      "clickup_search_workspace",
      { query: "Stocktake" },
      makeListGrant(),
      f as typeof fetch,
    );
    expect(result).toMatchObject({
      scope: "list",
      incomplete: false,
      docs: [],
      folders: [],
      lists: [],
    });
    expect(result["tasks"]).toHaveLength(1);
    expect(requests).toEqual([
      "/api/v2/list/12345",
      "/api/v2/team/555/space",
      "/api/v2/list/12345/task",
    ]);
  });

  it("accepts direct company List sharing consistently for catalogue reads", async () => {
    const requests: string[] = [];
    const f = vi.fn(async (req: RequestInfo | URL) => {
      const path = new URL(String(req)).pathname;
      requests.push(path);
      if (path === "/api/v2/list/12345") return reply({ id: "12345", space: { id: "777" } });
      if (path === "/api/v2/team/555/space") return reply({ spaces: [] });
      if (path === "/api/v2/team/555/shared")
        return reply({ shared: { lists: [{ id: "12345" }], tasks: [] } });
      if (path === "/api/v2/task/abc123")
        return reply({ id: "abc123", list: { id: "12345" }, name: "Order" });
      if (path === "/api/v2/list/12345/task")
        return reply({
          tasks: [
            {
              id: "abc123",
              name: "Order",
              list: { id: "12345" },
              custom_item_id: 9,
              tags: [{ name: "QC" }],
            },
          ],
        });
      throw Error("Unexpected out-of-scope API request: " + path);
    });
    const g = makeListGrant();
    const listing = await runCatalogOperation(
      "clickup_get_list",
      { list_id: "12345", include_custom_fields: false },
      g,
      f as typeof fetch,
    );
    expect(listing["id"]).toBe("12345");
    const task = await runCatalogOperation(
      "clickup_get_task",
      { task_id: "abc123" },
      g,
      f as typeof fetch,
    );
    expect(task["id"]).toBe("abc123");
    const search = await runCatalogOperation(
      "clickup_search_workspace",
      { query: "Order" },
      g,
      f as typeof fetch,
    );
    expect(search["tasks"]).toHaveLength(1);
    const byTag = await runCatalogOperation(
      "clickup_search_tasks_by_tag",
      { tag: "QC" },
      g,
      f as typeof fetch,
    );
    expect(byTag["tasks"]).toHaveLength(1);
    const byType = await runCatalogOperation(
      "clickup_search_tasks_by_type",
      { task_type: 9 },
      g,
      f as typeof fetch,
    );
    expect(byType["tasks"]).toHaveLength(1);
    expect(requests.filter((path) => path === "/api/v2/team/555/shared")).toHaveLength(5);
  });

  it("edits a directly shared company List task, including status, assignees, priority and due time", async () => {
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      requests.push({
        path,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (path === "/api/v2/task/abc123" && method === "GET")
        return reply({ id: "abc123", list: { id: "12345" }, name: "Old title" });
      if (path === "/api/v2/list/12345") return reply({ id: "12345", space: { id: "777" } });
      if (path === "/api/v2/team/555/space") return reply({ spaces: [] });
      if (path === "/api/v2/team/555/shared")
        return reply({ shared: { lists: [{ id: "12345" }], tasks: [] } });
      if (path === "/api/v2/task/abc123" && method === "PUT")
        return reply({ id: "abc123", name: "Updated task", status: { status: "in progress" } });
      throw Error("Unexpected request: " + method + " " + path);
    });
    const due = Date.parse("2026-11-06T13:45:00.000Z");
    const result = await runCatalogOperation(
      "clickup_update_task",
      {
        task_id: "abc123",
        changes: {
          name: "Updated task",
          status: "in progress",
          priority: 2,
          due_date_ms: due,
          assignee_ids: ["707"],
        },
      },
      makeCompanyListGrant(),
      f as typeof fetch,
    );
    expect(result).toMatchObject({ id: "abc123", name: "Updated task" });
    expect(requests.map((call) => call.path)).toEqual([
      "/api/v2/task/abc123",
      "/api/v2/list/12345",
      "/api/v2/team/555/space",
      "/api/v2/team/555/shared",
      "/api/v2/task/abc123",
    ]);
    expect(requests.at(-1)).toMatchObject({
      method: "PUT",
      body: {
        name: "Updated task",
        status: "in progress",
        priority: 2,
        due_date: due,
        due_date_time: true,
        assignees: { add: [707], rem: [] },
      },
    });
    expect(
      f.mock.calls.every(
        ([, init]) => (init?.headers as Record<string, string>)["Authorization"] === "person-707",
      ),
    ).toBe(true);
  });

  it("allows company List task comments, tag changes, custom fields and bulk updates", async () => {
    const requests: Array<{ path: string; method: string }> = [];
    const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      requests.push({ path, method });
      if (path === "/api/v2/task/abc123" && method === "GET")
        return reply({ id: "abc123", list: { id: "12345" } });
      if (path === "/api/v2/list/12345") return reply({ id: "12345", space: { id: "777" } });
      if (path === "/api/v2/team/555/space") return reply({ spaces: [{ id: "777" }] });
      if (path === "/api/v2/list/12345/field")
        return reply({ fields: [{ id: "custom11", type: "text" }] });
      if (path === "/api/v2/task/abc123/comment" && method === "POST")
        return reply({ id: "comment1" });
      if (path === "/api/v2/task/abc123/comment" && method === "GET")
        return reply({ comments: [{ id: "comment1" }] });
      if (path === "/api/v2/task/abc123/field/custom11" && method === "POST")
        return reply({ success: true });
      if (path === "/api/v2/task/abc123/tag/Reviewed" && method === "POST")
        return reply({ success: true });
      if (path === "/api/v2/task/abc123" && method === "PUT")
        return reply({ id: "abc123", name: "Renamed" });
      throw Error("Unexpected request: " + method + " " + path);
    });
    const g = makeCompanyListGrant();
    await runCatalogOperation(
      "clickup_create_task_comment",
      { task_id: "abc123", text: "Progress reviewed" },
      g,
      f as typeof fetch,
    );
    await runCatalogOperation(
      "clickup_add_tag_to_task",
      { task_id: "abc123", tag: "Reviewed" },
      g,
      f as typeof fetch,
    );
    await runCatalogOperation(
      "clickup_set_custom_field",
      {
        task_id: "abc123",
        field_id: "custom11",
        field_value: { text: "Approved" },
      },
      g,
      f as typeof fetch,
    );
    const bulk = await runCatalogOperation(
      "clickup_update_bulk_tasks",
      {
        task_updates: [{ task_id: "abc123", changes: { name: "Renamed" } }],
      },
      g,
      f as typeof fetch,
    );
    expect(bulk["partial"]).toBe(false);
    const comments = await runCatalogOperation(
      "clickup_get_task_comments",
      { task_id: "abc123" },
      g,
      f as typeof fetch,
    );
    expect(comments["comments"]).toHaveLength(1);
    expect(requests.filter((item) => item.method === "PUT")).toHaveLength(1);
    expect(requests.filter((item) => item.method === "POST")).toHaveLength(3);
    expect(
      requests.filter((item) => item.path === "/api/v2/task/abc123" && item.method === "GET"),
    ).toHaveLength(5);
    expect(requests.every((item) => item.method !== "DELETE")).toBe(true);
  });

  it("rejects foreign-home edits before any ClickUp write, including company List mode", async () => {
    const api = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "GET") throw Error("A foreign task must never be mutated");
      const path = new URL(String(input)).pathname;
      if (path === "/api/v2/task/foreign") return reply({ id: "foreign", list: { id: "99999" } });
      return reply({ id: "99999", space: { id: "888" } });
    });
    await expect(
      runCatalogOperation(
        "clickup_update_task",
        { task_id: "foreign", changes: { status: "done" } },
        makeCompanyListGrant(),
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    await expect(
      runCatalogOperation(
        "clickup_update_task",
        { task_id: "abc123", changes: { status: "done" } },
        makeListGrant(),
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_WORKSPACE_SCOPE_REQUIRED");
    expect(api.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });

  it("rejects unrelated or task-only shares and cannot expand the configured List", async () => {
    for (const shared of [
      { lists: [{ id: "99999" }] },
      { lists: [], tasks: [{ id: "abc123" }] },
      { lists: "12345" },
      null,
    ]) {
      const f = vi.fn(async (req: RequestInfo | URL) => {
        const path = new URL(String(req)).pathname;
        if (path === "/api/v2/list/12345") return reply({ id: "12345", space: { id: "777" } });
        if (path === "/api/v2/team/555/space") return reply({ spaces: [] });
        if (path === "/api/v2/team/555/shared") return reply({ shared });
        if (path === "/api/v2/task/abc123") return reply({ id: "abc123", list: { id: "12345" } });
        throw Error("Should fail before reading task list");
      });
      await expect(
        runCatalogOperation(
          "clickup_get_list",
          { list_id: "12345" },
          makeListGrant(),
          f as typeof fetch,
        ),
      ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      await expect(
        runCatalogOperation(
          "clickup_get_task",
          { task_id: "abc123" },
          makeListGrant(),
          f as typeof fetch,
        ),
      ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      await expect(
        runCatalogOperation(
          "clickup_search_workspace",
          { query: "Order" },
          makeListGrant(),
          f as typeof fetch,
        ),
      ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    }
    const f = vi.fn(async () => {
      throw Error("Unexpected OAuth fetch");
    });
    await expect(
      runCatalogOperation(
        "clickup_get_list",
        { list_id: "99999" },
        makeListGrant(),
        f as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(f).not.toHaveBeenCalled();
  });

  it("requires explicit Workspace authority for out-of-List actions", async () => {
    const f = fakeApi();
    for (const name of [
      "clickup_get_workspace_hierarchy",
      "clickup_create_list",
      "clickup_create_folder",
      "clickup_get_folder",
      "clickup_get_chat_channels",
      "clickup_send_chat_message",
      "clickup_create_document",
      "clickup_get_document_pages",
      "clickup_stop_time_tracking",
      "clickup_get_current_time_entry",
    ]) {
      await expect(
        runCatalogOperation(name, {}, makeListGrant(), f as typeof fetch),
      ).rejects.toThrow("CLICKUP_WORKSPACE_SCOPE_REQUIRED");
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("rejects invalid task drafts before POST and retains all fields for valid drafts", async () => {
    for (const bad of [
      { name: "Bad", priority: 9 },
      { name: "Bad", description: 123 },
      { name: "Bad", due_date_ms: 0 },
      { name: "Bad", assignee_ids: ["not-a-user"] },
      { name: "Bad", assignee_ids: ["0"] },
      { name: "Bad", assignee_ids: ["1e2"] },
      { name: "Bad", assignee_ids: [12.5] },
      { name: "Bad", unknown_property: "should not silently disappear" },
    ]) {
      const api = fakeApi();
      await expect(
        runCatalogOperation(
          "clickup_create_task",
          { list_id: "12345", new_task: bad },
          makeGrant(),
          api as typeof fetch,
        ),
      ).rejects.toThrow("CLICKUP_INVALID_ARGUMENT");
      expect(api.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    }
    const api = fakeApi();
    await runCatalogOperation(
      "clickup_create_task",
      {
        list_id: "12345",
        new_task: {
          name: "Valid",
          priority: 2,
          assignee_ids: ["707"],
          due_date_ms: 1793192400000,
        },
      },
      makeGrant(),
      api as typeof fetch,
    );
    const sent = api.mock.calls.find(([, init]) => init?.method === "POST");
    const body = JSON.parse(String(sent?.[1]?.body));
    expect(body).toMatchObject({
      name: "Valid",
      priority: 2,
      assignees: [707],
      due_date: 1793192400000,
      due_date_time: true,
    });
  });

  it("advertises decimal-string member IDs and decimal custom field values", () => {
    const create = CLICKUP_MODEL_TOOL_CATALOG.find((tool) => tool.name === "clickup_create_task")!;
    const draft = create.inputSchema.properties["new_task"]!;
    expect(draft.properties?.["assignee_ids"]?.items?.type).toBe("string");
    const update = CLICKUP_MODEL_TOOL_CATALOG.find((tool) => tool.name === "clickup_update_task")!;
    expect(
      update.inputSchema.properties["changes"]?.properties?.["assignee_ids"]?.items?.type,
    ).toBe("string");
    const custom = CLICKUP_MODEL_TOOL_CATALOG.find(
      (tool) => tool.name === "clickup_set_custom_field",
    )!;
    expect(custom.inputSchema.properties["field_value"]?.properties?.["number"]?.type).toBe(
      "number",
    );
  });

  it("sends numeric ClickUp member IDs after validating decimal-string IDs for task updates and bulk tasks", async () => {
    const api = fakeApi();
    await runCatalogOperation(
      "clickup_update_task",
      { task_id: "abc123", changes: { assignee_ids: ["707"] } },
      makeGrant(),
      api as typeof fetch,
    );
    await runCatalogOperation(
      "clickup_create_bulk_tasks",
      { list_id: "12345", tasks: [{ name: "QA assigned", assignee_ids: ["707"] }] },
      makeGrant(),
      api as typeof fetch,
    );
    const writes = api.mock.calls
      .filter(([, init]) => init?.method === "PUT" || init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    expect(writes).toContainEqual(expect.objectContaining({ assignees: { add: [707], rem: [] } }));
    expect(writes).toContainEqual(expect.objectContaining({ assignees: [707] }));
  });

  it("discovers Custom Field metadata with legacy list_id-only clients, with explicit opt-out", async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (request: RequestInfo | URL) => {
      const path = new URL(String(request)).pathname;
      calls.push(path);
      if (path === "/api/v2/list/12345/field")
        return reply({ fields: [{ id: "field-1", name: "Estimate", type: "number" }] });
      return reply(fixture(path));
    });
    const plain = await runCatalogOperation(
      "clickup_get_list",
      { list_id: "12345" },
      makeGrant(),
      fetcher as typeof fetch,
    );
    expect(plain["custom_fields"]).toMatchObject([{ id: "field-1" }]);
    expect(calls).toContain("/api/v2/list/12345/field");
    const enriched = await runCatalogOperation(
      "clickup_get_list",
      { list_id: "12345", include_custom_fields: false },
      makeGrant(),
      fetcher as typeof fetch,
    );
    expect(enriched["custom_fields"]).toBeUndefined();
    expect(plain["custom_fields_count"]).toBe(1);
    expect(calls.filter((path) => path === "/api/v2/list/12345/field")).toHaveLength(1);
    const schema = CLICKUP_MODEL_TOOL_CATALOG.find((item) => item.name === "clickup_get_list")!;
    expect(schema.inputSchema.properties["include_custom_fields"]?.type).toBe("boolean");
  });

  it("preserves old List metadata when upstream Custom Field discovery is forbidden", async () => {
    const fetcher = vi.fn(async (request: RequestInfo | URL) => {
      const path = new URL(String(request)).pathname;
      if (path === "/api/v2/list/12345/field") return reply({ err: "Forbidden" }, 403);
      return reply(fixture(path));
    });
    const result = await runCatalogOperation(
      "clickup_get_list",
      { list_id: "12345" },
      makeGrant(),
      fetcher as typeof fetch,
    );
    expect(result).toMatchObject({ id: "12345", custom_fields_unavailable: true });
    expect(result["custom_fields"]).toBeUndefined();
  });

  it("validates Custom Field type, options and task-type applicability before spending a write", async () => {
    const definitions = [
      { id: "field-text", type: "text" },
      { id: "field-money", type: "currency" },
      {
        id: "field-choice",
        type: "drop_down",
        type_config: { options: [{ id: "option-a" }, { id: "option-b" }] },
      },
      {
        id: "field-labels",
        type: "labels",
        type_config: { options: [{ id: "label-a" }, { id: "label-b" }] },
      },
      { id: "field-date", type: "date" },
      { id: "field-check", type: "checkbox" },
      {
        id: "field-other-type",
        type: "text",
        applied_objects: [{ object_type: 19, object_id: 8 }],
      },
    ];
    const writes: Record<string, unknown>[] = [];
    const fetcher = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(request)).pathname;
      if (path === "/api/v2/list/12345/field") return reply({ fields: definitions });
      if (init?.method === "POST") {
        writes.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return reply({});
      }
      return reply(fixture(path));
    });
    const scenarios = [
      ["field-text", { text: "QA text" }, "QA text"],
      ["field-money", { number: -17.25 }, -17.25],
      ["field-choice", { option_id: "option-a" }, "option-a"],
      ["field-labels", { selected_option_ids: ["label-b"] }, ["label-b"]],
      ["field-check", { checked: false }, false],
      ["field-date", { timestamp_ms: 1793647200000 }, 1793647200000],
    ] as const;
    for (const [field_id, field_value, value] of scenarios) {
      const result = await runCatalogOperation(
        "clickup_set_custom_field",
        { task_id: "abc123", field_id, field_value },
        makeGrant(),
        fetcher as typeof fetch,
      );
      expect(result).toMatchObject({ success: true, response_empty: true });
      expect(writes.at(-1)).toMatchObject({
        value,
        ...(field_id === "field-date" ? { value_options: { time: true } } : {}),
      });
    }
    const wrote = writes.length;
    for (const [field_id, field_value] of [
      ["field-absent", { text: "No" }],
      ["field-other-type", { text: "Wrong type" }],
      ["field-money", { text: "Not a number" }],
      ["field-choice", { option_id: "not-an-option" }],
      ["field-labels", { selected_option_ids: ["not-a-label"] }],
      ["field-date", { timestamp_ms: -1 }],
    ] as const) {
      await expect(
        runCatalogOperation(
          "clickup_set_custom_field",
          { task_id: "abc123", field_id, field_value },
          makeGrant(),
          fetcher as typeof fetch,
        ),
      ).rejects.toThrow(/CLICKUP_(INVALID_ARGUMENT|SCOPE_OR_SCHEMA_REJECTED)/);
    }
    expect(writes).toHaveLength(wrote);
  });

  it("rejects malformed Custom Field dropdown and label option IDs without consuming a write", async () => {
    for (const [type, variant] of [
      ["drop_down", { option_id: "undefined" }],
      ["labels", { selected_option_ids: ["undefined"] }],
    ] as const) {
      for (const malformedOption of [{}, null, { id: null }, { id: 9 }, { id: " " }]) {
        const fetcher = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
          const path = new URL(String(request)).pathname;
          if (path === "/api/v2/list/12345/field")
            return reply({
              fields: [
                {
                  id: "field-select",
                  type,
                  type_config: { options: [malformedOption] },
                },
              ],
            });
          if (init?.method === "POST") throw Error("must not consume a field write");
          return reply(fixture(path));
        });
        await expect(
          runCatalogOperation(
            "clickup_set_custom_field",
            { task_id: "abc123", field_id: "field-select", field_value: variant },
            makeGrant(),
            fetcher as typeof fetch,
          ),
        ).rejects.toThrow("CLICKUP_BAD_RESPONSE");
        expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
      }
    }
  });

  it("fails closed when Custom Field metadata is malformed or cannot be verified", async () => {
    for (const payload of [{}, { fields: {} }, { fields: ["garbled"] }]) {
      const fetcher = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(request)).pathname;
        if (path === "/api/v2/list/12345/field") return reply(payload);
        if (init?.method === "POST") throw Error("unsafe Custom Field mutation");
        return reply(fixture(path));
      });
      await expect(
        runCatalogOperation(
          "clickup_set_custom_field",
          { task_id: "abc123", field_id: "field-1", field_value: { number: 2.5 } },
          makeGrant(),
          fetcher as typeof fetch,
        ),
      ).rejects.toThrow(/CLICKUP_(BAD_RESPONSE|SCOPE_OR_SCHEMA_REJECTED)/);
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    }
  });

  it("accepts Workspace tag and type results from multiple home Lists", async () => {
    const requests: string[] = [];
    const f = vi.fn(async (req: RequestInfo | URL) => {
      const url = new URL(String(req));
      requests.push(url.pathname);
      if (url.pathname === "/api/v2/team/555/task") {
        return reply({
          tasks: [
            { id: "a1", list: { id: "12345" }, custom_item_id: 7, tags: [{ name: "Urgent" }] },
            { id: "b2", list: { id: "12346" }, custom_item_id: 7, tags: [{ name: "Urgent" }] },
          ],
        });
      }
      throw Error("unexpected endpoint " + url.pathname);
    });
    for (const [name, args] of [
      ["clickup_search_tasks_by_tag", { tag: "Urgent" }],
      ["clickup_search_tasks_by_type", { task_type: "7" }],
    ] as const) {
      const result = await runCatalogOperation(name, args, makeGrant(), f as typeof fetch);
      expect(result["tasks"]).toHaveLength(2);
    }
    expect(requests).toEqual(["/api/v2/team/555/task", "/api/v2/team/555/task"]);
  });

  it("accepts additional-List tasks with a different home List", async () => {
    const f = vi.fn(async (req: RequestInfo | URL) => {
      const url = new URL(String(req));
      if (url.pathname === "/api/v2/list/12346") return reply(fixture(url.pathname));
      if (url.pathname === "/api/v2/team/555/space") return reply(fixture(url.pathname));
      if (url.pathname === "/api/v2/list/12346/task") {
        if (url.searchParams.get("include_timl") !== "true") return reply({ tasks: [] });
        return reply({ tasks: [{ id: "t1", list: { id: "12347" }, tags: [{ name: "Urgent" }] }] });
      }
      throw Error("unexpected endpoint " + url.pathname);
    });
    const result = await runCatalogOperation(
      "clickup_search_tasks_by_tag",
      { list_id: "12346", tag: "Urgent" },
      makeGrant(),
      f as typeof fetch,
    );
    expect(result["tasks"]).toHaveLength(1);
  });

  it("rejects malformed Workspace home Lists in tag and type searches", async () => {
    for (const badId of [null, {}, [], "", 0]) {
      const f = vi.fn(async (req: RequestInfo | URL) => {
        const url = new URL(String(req));
        if (url.pathname === "/api/v2/team/555/task") {
          return reply({
            tasks: [
              { id: "bad", list: { id: badId }, tags: [{ name: "Urgent" }], custom_item_id: 7 },
            ],
          });
        }
        throw Error("unexpected endpoint " + url.pathname);
      });
      for (const [name, args] of [
        ["clickup_search_tasks_by_tag", { tag: "Urgent" }],
        ["clickup_search_tasks_by_type", { task_type: "7" }],
      ] as const) {
        const operation = runCatalogOperation(name, args, makeGrant(), f as typeof fetch);
        await expect(operation).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      }
    }
  });

  it("still rejects foreign-home search results under a single-List grant", async () => {
    const f = vi.fn(async (req: RequestInfo | URL) => {
      const url = new URL(String(req));
      if (url.pathname === "/api/v2/list/12345") return reply(fixture(url.pathname));
      if (url.pathname === "/api/v2/team/555/space") return reply(fixture(url.pathname));
      if (url.pathname === "/api/v2/list/12345/task") {
        return reply({
          tasks: [{ id: "foreign", list: { id: "12346" }, tags: [{ name: "Urgent" }] }],
        });
      }
      throw Error("unexpected endpoint " + url.pathname);
    });
    await expect(
      runCatalogOperation(
        "clickup_search_tasks_by_tag",
        { tag: "Urgent" },
        makeListGrant(),
        f as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  });

  it("refuses cross-workspace List configuration before a write reaches ClickUp", async () => {
    const api = fakeApi();
    await expect(
      runCatalogOperation(
        "clickup_create_task",
        { list_id: "99999", new_task: { name: "Bad target" } },
        makeListGrant(),
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(api.mock.calls.every(([, i]) => i?.method === "GET")).toBe(true);
    // The configured List grant denies mismatched IDs BEFORE a network call.
    expect(api).not.toHaveBeenCalled();
  });

  it("denies a different List even when it belongs to the same ClickUp Workspace", async () => {
    const api = fakeApi();
    await expect(
      runCatalogOperation(
        "clickup_create_task",
        {
          list_id: "12346",
          new_task: { name: "Not this List" },
        },
        makeListGrant(),
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(api).not.toHaveBeenCalled();
    await expect(
      runCatalogOperation(
        "clickup_get_list",
        { list_id: "12346" },
        makeListGrant(),
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(api).not.toHaveBeenCalled();
  });

  it("validates ALL bulk task drafts before writing, even if the second draft is invalid", async () => {
    const api = fakeApi();
    await expect(
      runCatalogOperation(
        "clickup_create_bulk_tasks",
        { list_id: "12345", tasks: [{ name: "Valid first" }, { name: "   " }] },
        makeGrant(),
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_INVALID_ARGUMENT");
    expect(api.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
  });

  it("validates ALL bulk task updates before mutating the first task", async () => {
    const api = fakeApi();
    await expect(
      runCatalogOperation(
        "clickup_update_bulk_tasks",
        {
          task_updates: [
            { task_id: "abc123", changes: { name: "Valid first" } },
            { task_id: "../../invalid", changes: { name: "Invalid second" } },
          ],
        },
        makeGrant(),
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_INVALID_ARGUMENT");
    expect(api).not.toHaveBeenCalled();
  });

  it("keeps credentials separate across employees in parallel, never a shared API token", async () => {
    const seen: string[] = [];
    const f = vi.fn(async (req: RequestInfo | URL, opts?: RequestInit) => {
      seen.push((opts?.headers as Record<string, string>)["Authorization"] ?? "");
      return reply({ channels: [] });
    });
    await Promise.all([
      runCatalogOperation(
        "clickup_get_chat_channels",
        { workspace_id: "555" },
        makeGrant(),
        f as typeof fetch,
      ),
      runCatalogOperation(
        "clickup_get_chat_channels",
        { workspace_id: "555" },
        makeGrant("github:22", "809", "person-809"),
        f as typeof fetch,
      ),
    ]);
    expect(seen.sort()).toEqual(["person-707", "person-809"]);
  });

  it("never accesses a model-selected foreign workspace even with a valid credential", async () => {
    const outbound = vi.fn(async () => reply({ channels: [] }));
    await expect(
      runCatalogOperation(
        "clickup_get_chat_channels",
        { workspace_id: "666" },
        makeGrant(),
        outbound as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(outbound).not.toHaveBeenCalled();
  });

  it("blocks arbitrary URL/path injection before contacting ClickUp", async () => {
    const outbound = fakeApi();
    for (const task_id of ["../../evil", "https://evil.invalid", "?token=steal"]) {
      await expect(
        runCatalogOperation("clickup_get_task", { task_id }, makeGrant(), outbound as typeof fetch),
      ).rejects.toThrow("CLICKUP_INVALID_ARGUMENT");
    }
    expect(outbound).not.toHaveBeenCalled();
  });

  it("never automatically retries an ambiguous upstream write", async () => {
    const records: string[] = [];
    const f = vi.fn(async (req: RequestInfo | URL, opts?: RequestInit) => {
      const url = new URL(String(req));
      records.push(opts?.method + " " + url.pathname);
      if (opts?.method === "POST") throw Error("synthetic dropped response after ClickUp commit");
      return reply(fixture(url.pathname));
    });
    await expect(
      runCatalogOperation(
        "clickup_create_task",
        { list_id: "12345", new_task: { name: "Potential duplicate" } },
        makeGrant(),
        f as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_WRITE_OUTCOME_UNKNOWN");
    expect(records.filter((x) => x.startsWith("POST"))).toHaveLength(1);
  });

  it("does not leak arbitrary upstream fields indicating secret tokens", async () => {
    const f = vi.fn(async () =>
      reply({ channels: [{ id: "c1", access_token: "never-return" }], secret: "never-return" }),
    );
    const result = await runCatalogOperation(
      "clickup_get_chat_channels",
      {},
      makeGrant(),
      f as typeof fetch,
    );
    expect(JSON.stringify(result)).not.toContain("never-return");
  });

  it("uses a real v3 ClickUp Chat API message endpoint with the employee token", async () => {
    const f = vi.fn(async (_req: RequestInfo | URL, _init?: RequestInit) =>
      reply({ id: "message-1" }),
    );
    const result = await runCatalogOperation(
      "clickup_send_chat_message",
      { channel_id: "chan-123", text: "Test dispatch status" },
      makeGrant(),
      f as typeof fetch,
    );
    expect(result).toMatchObject({ id: "message-1" });
    const [url, options] = f.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://api.clickup.com/api/v3/workspaces/555/chat/channels/chan-123/messages",
    );
    expect(options?.method).toBe("POST");
    expect(JSON.parse(String(options?.body))).toEqual({
      type: "message",
      content: "Test dispatch status",
      content_format: "text/md",
    });
  });

  it("reports HTTP 429 without further retries and does not make the write falsely successful", async () => {
    const f = vi.fn(async () => reply({ error: "rate limit" }, 429));
    await expect(
      runCatalogOperation(
        "clickup_send_chat_message",
        { channel_id: "chan-123", text: "Test" },
        makeGrant(),
        f as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_RATE_LIMITED");
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("sends actual provided file bytes as multipart to ClickUp, never fetches a file URL", async () => {
    let sent: FormData | null = null;
    const f = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(request));
      if (init?.method === "POST") {
        expect(u.href).toBe("https://api.clickup.com/api/v2/task/abc123/attachment");
        expect((init.headers as Record<string, string>)["Authorization"]).toBe("person-707");
        expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
        sent = init.body as FormData;
        return reply({ id: "attachment-1" });
      }
      return reply(fixture(u.pathname));
    });
    const output = await runCatalogOperation(
      "clickup_attach_file_to_task",
      {
        task_id: "abc123",
        file_name: "note.txt",
        file_base64: btoa("hello"),
        media_type: "text/plain",
      },
      makeGrant(),
      f as typeof fetch,
    );
    expect(output).toMatchObject({ id: "attachment-1" });
    expect(sent).not.toBeNull();
    const blob = sent!.get("attachment") as File;
    expect(sent!.get("attachment[0]")).toBeNull();
    expect(blob.name).toBe("note.txt");
    expect(await blob.text()).toBe("hello");
    expect(f).toHaveBeenCalledTimes(4);
  });

  it("does not misattribute an ambiguous attachment upload from a concurrent same-name writer", async () => {
    for (const response of [
      new Response(null, { status: 204 }),
      new Response("OK", { status: 200, headers: { "content-type": "text/plain" } }),
      reply({}),
    ]) {
      let posted = false;
      const fetcher = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(request)).pathname;
        if (path === "/api/v2/task/abc123/attachment" && init?.method === "POST") {
          posted = true;
          return response;
        }
        if (path === "/api/v2/task/abc123")
          return reply({
            id: "abc123",
            list: { id: "12345" },
            attachments: [
              { id: "old", title: "note.txt" },
              ...(posted ? [{ id: "concurrent-upload", title: "note.txt" }] : []),
            ],
          });
        return reply(fixture(path));
      });
      await expect(
        runCatalogOperation(
          "clickup_attach_file_to_task",
          { task_id: "abc123", file_name: "note.txt", file_base64: btoa("hello") },
          makeGrant(),
          fetcher as typeof fetch,
        ),
      ).rejects.toThrow("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    }
  });

  it("refuses false success when an attachment POST returns a JSON object without an ID", async () => {
    const fetcher = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(request)).pathname;
      if (path === "/api/v2/task/abc123/attachment" && init?.method === "POST")
        return reply({ title: "note.txt", url: "https://example.com/same-name.txt" });
      return reply(fixture(path));
    });
    await expect(
      runCatalogOperation(
        "clickup_attach_file_to_task",
        { task_id: "abc123", file_name: "note.txt", file_base64: btoa("hello") },
        makeGrant(),
        fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_WRITE_OUTCOME_UNKNOWN");
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("refuses oversized, malformed or path-style attachment input before any upload", async () => {
    const outbound = fakeApi();
    for (const [file_name, file_base64] of [
      ["../bad.txt", btoa("hello")],
      ["good.txt", "not valid==="],
      ["good.txt", "Z".repeat(700100)],
    ]) {
      await expect(
        runCatalogOperation(
          "clickup_attach_file_to_task",
          { task_id: "abc123", file_name, file_base64 },
          makeGrant(),
          outbound as typeof fetch,
        ),
      ).rejects.toThrow("CLICKUP_INVALID_ARGUMENT");
    }
    expect(outbound.mock.calls.every(([, opts]) => opts?.method !== "POST")).toBe(true);
  });
  it("encodes multiword ClickUp tag names without accepting path injection", async () => {
    const f = vi.fn(async (req: RequestInfo | URL, _init?: RequestInit) =>
      reply(fixture(new URL(String(req)).pathname)),
    );
    await runCatalogOperation(
      "clickup_add_tag_to_task",
      { task_id: "abc123", tag: "Needs Attention" },
      makeGrant(),
      f as typeof fetch,
    );
    const writes = f.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(writes).toHaveLength(1);
    expect(String(writes[0]?.[0])).toContain("/tag/Needs%20Attention");
  });

  it("rejects a move when the task's current home List does not equal source_list_id", async () => {
    const f = fakeApi();
    await expect(
      runCatalogOperation(
        "clickup_move_task_to_list",
        { task_id: "abc123", source_list_id: "99999", destination_list_id: "12345" },
        makeGrant(),
        f as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(f.mock.calls.every(([, init]) => init?.method !== "PUT")).toBe(true);
  });

  it("verifies committed dependencies after 204, empty JSON and unusable ClickUp POST acknowledgements", async () => {
    for (const response of [
      new Response(null, { status: 204 }),
      reply({}),
      new Response("OK", { status: 200, headers: { "Content-Type": "text/plain" } }),
    ]) {
      let persisted = false;
      const fetcher = vi.fn(async (req: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(req)).pathname;
        if (path === "/api/v2/task/wait123/dependency" && init?.method === "POST") {
          persisted = true;
          return response;
        }
        if (path === "/api/v2/list/12345") return reply(fixture(path));
        if (path === "/api/v2/team/555/space") return reply(fixture(path));
        if (path === "/api/v2/task/block123")
          return reply({ id: "block123", list: { id: "12345" } });
        if (path === "/api/v2/task/wait123")
          return reply({
            id: "wait123",
            list: { id: "12345" },
            dependencies: persisted ? [{ task_id: "wait123", depends_on: "block123" }] : [],
          });
        throw Error("Unexpected request: " + path);
      });
      const result = await runCatalogOperation(
        "clickup_add_dependency",
        { blocking_task_id: "block123", waiting_task_id: "wait123" },
        makeGrant(),
        fetcher as typeof fetch,
      );
      expect(result).toMatchObject({ success: true, verified_by_readback: true });
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    }
  });

  it("does not falsely certify a dependency if POST returns success but readback lacks the link", async () => {
    const fetcher = vi.fn(async (req: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(req)).pathname;
      if (path === "/api/v2/task/wait123/dependency" && init?.method === "POST") return reply({});
      if (path === "/api/v2/list/12345") return reply(fixture(path));
      if (path === "/api/v2/team/555/space") return reply(fixture(path));
      if (path === "/api/v2/task/block123") return reply({ id: "block123", list: { id: "12345" } });
      if (path === "/api/v2/task/wait123")
        return reply({ id: "wait123", list: { id: "12345" }, dependencies: [] });
      throw Error("Unexpected request: " + path);
    });
    await expect(
      runCatalogOperation(
        "clickup_add_dependency",
        { blocking_task_id: "block123", waiting_task_id: "wait123" },
        makeGrant(),
        fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_WRITE_OUTCOME_UNKNOWN");
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("preserves definitive dependency permission denial without retry or extra read", async () => {
    const fetcher = vi.fn(async (req: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(req)).pathname;
      if (path === "/api/v2/task/wait123/dependency" && init?.method === "POST")
        return reply({ err: "no permission" }, 403);
      if (path === "/api/v2/list/12345") return reply(fixture(path));
      if (path === "/api/v2/team/555/space") return reply(fixture(path));
      if (path === "/api/v2/task/block123") return reply({ id: "block123", list: { id: "12345" } });
      if (path === "/api/v2/task/wait123")
        return reply({ id: "wait123", list: { id: "12345" }, dependencies: [] });
      throw Error("Unexpected request: " + path);
    });
    await expect(
      runCatalogOperation(
        "clickup_add_dependency",
        { blocking_task_id: "block123", waiting_task_id: "wait123" },
        makeGrant(),
        fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_UPSTREAM_DENIED");
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(7);
  });

  it("uses query parameters for deletion of dependencies rather than a DELETE JSON body", async () => {
    const f = vi.fn(async (req: RequestInfo | URL, _init?: RequestInit) => {
      const path = new URL(String(req)).pathname;
      if (path === "/api/v2/task/block123") return reply({ id: "block123", list: { id: "12345" } });
      if (path === "/api/v2/task/wait123") return reply({ id: "wait123", list: { id: "12345" } });
      return reply(fixture(path));
    });
    await runCatalogOperation(
      "clickup_remove_dependency",
      {
        blocking_task_id: "block123",
        waiting_task_id: "wait123",
      },
      makeGrant(),
      f as typeof fetch,
    );
    const deletion = f.mock.calls.find(([, init]) => init?.method === "DELETE");
    expect(String(deletion?.[0])).toBe(
      "https://api.clickup.com/api/v2/task/wait123/dependency?depends_on=block123",
    );
    expect(deletion?.[1]?.body).toBeUndefined();
  });
  it("rejects threaded replies from unverified or foreign parent comments", async () => {
    const seen: string[] = [];
    const fetcher = vi.fn(async (req: RequestInfo | URL) => {
      const p = new URL(String(req)).pathname;
      seen.push(p);
      if (p === "/api/v2/task/abc123/comment") return reply({ comments: [{ id: "safe-c1" }] });
      if (p === "/api/v2/comment/safe-c1/reply")
        return reply({ replies: [{ id: "reply1", text: "same workspace" }] });
      return reply(fixture(p));
    });
    await expect(
      runCatalogOperation(
        "clickup_get_threaded_replies",
        { task_id: "abc123", comment_id: "foreign-c2" },
        makeGrant(),
        fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(seen).not.toContain("/api/v2/comment/foreign-c2/reply");
    const allowed = await runCatalogOperation(
      "clickup_get_threaded_replies",
      { task_id: "abc123", comment_id: "safe-c1" },
      makeGrant(),
      fetcher as typeof fetch,
    );
    expect(allowed).toMatchObject({ replies: [{ id: "reply1" }] });
  });

  it("validates threaded-reply payloads and never reports zero replies for a known nonempty thread", async () => {
    for (const response of [reply({}), reply({ comments: [] })]) {
      const fetcher = vi.fn(async (request: RequestInfo | URL) => {
        const path = new URL(String(request)).pathname;
        if (path === "/api/v2/task/abc123/comment")
          return reply({ comments: [{ id: "parent-1", reply_count: 2 }] });
        if (path === "/api/v2/comment/parent-1/reply") return response;
        return reply(fixture(path));
      });
      await expect(
        runCatalogOperation(
          "clickup_get_threaded_replies",
          { task_id: "abc123", comment_id: "parent-1" },
          makeGrant(),
          fetcher as typeof fetch,
        ),
      ).rejects.toThrow("CLICKUP_BAD_RESPONSE");
    }
    const fetcher = vi.fn(async (request: RequestInfo | URL) => {
      const path = new URL(String(request)).pathname;
      if (path === "/api/v2/task/abc123/comment")
        return reply({ comments: [{ id: "parent-1", reply_count: 2 }] });
      if (path === "/api/v2/comment/parent-1/reply")
        return reply({
          replies: [
            { id: "reply-1", comment_text: "one" },
            { id: "reply-2", comment_text: "two" },
          ],
        });
      return reply(fixture(path));
    });
    const result = await runCatalogOperation(
      "clickup_get_threaded_replies",
      { task_id: "abc123", comment_id: "parent-1" },
      makeGrant(),
      fetcher as typeof fetch,
    );
    expect(result).toMatchObject({
      parent_comment_id: "parent-1",
      parent_reply_count: 2,
      incomplete: false,
    });
    expect(result["comments"]).toMatchObject([{ id: "reply-1" }, { id: "reply-2" }]);
  });

  it("accepts ClickUp's documented string reply_count and rejects malformed counts", async () => {
    for (const count of ["1", "0"]) {
      const fetcher = vi.fn(async (request: RequestInfo | URL) => {
        const path = new URL(String(request)).pathname;
        if (path === "/api/v2/task/abc123/comment")
          return reply({ comments: [{ id: "parent", reply_count: count }] });
        if (path === "/api/v2/comment/parent/reply")
          return reply({ comments: count === "1" ? [{ id: "reply", comment_text: "hello" }] : [] });
        return reply(fixture(path));
      });
      const result = await runCatalogOperation(
        "clickup_get_threaded_replies",
        { task_id: "abc123", comment_id: "parent" },
        makeGrant(),
        fetcher as typeof fetch,
      );
      expect(result["parent_reply_count"]).toBe(Number(count));
      expect(result["incomplete"]).toBe(false);
    }
    const f = vi.fn(async (request: RequestInfo | URL) => {
      const path = new URL(String(request)).pathname;
      if (path === "/api/v2/task/abc123/comment")
        return reply({ comments: [{ id: "parent", reply_count: "Infinity" }] });
      if (path === "/api/v2/comment/parent/reply") return reply({ comments: [{ id: "reply" }] });
      return reply(fixture(path));
    });
    await expect(
      runCatalogOperation(
        "clickup_get_threaded_replies",
        { task_id: "abc123", comment_id: "parent" },
        makeGrant(),
        f as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_BAD_RESPONSE");
  });

  it("never claims verified threaded write when reply matches are duplicated or only partial", async () => {
    for (const replyArray of [
      [
        { id: "new-1", comment_text: "QA reply" },
        { id: "new-2", comment_text: "QA reply" },
      ],
      [{ id: "new-1", comment: [{ text: "QA reply" }, { text: " unexpected suffix" }] }],
    ]) {
      let posted = false;
      const fetcher = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(request)).pathname;
        if (path === "/api/v2/task/abc123/comment")
          return reply({ comments: [{ id: "parent-1", reply_count: 0 }] });
        if (path === "/api/v2/comment/parent-1/reply") {
          if (init?.method === "POST") {
            posted = true;
            return reply({});
          }
          return reply({ comments: posted ? replyArray : [] });
        }
        return reply(fixture(path));
      });
      await expect(
        runCatalogOperation(
          "clickup_create_task_comment",
          { task_id: "abc123", parent_comment_id: "parent-1", text: "QA reply" },
          makeGrant(),
          fetcher as typeof fetch,
        ),
      ).rejects.toThrow("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    }
  });

  it("does not certify a reply written by another ClickUp author after an uncertain POST", async () => {
    let attempted = false;
    const fetcher = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(request)).pathname;
      if (path === "/api/v2/task/abc123/comment")
        return reply({ comments: [{ id: "parent-1", reply_count: 0 }] });
      if (path === "/api/v2/comment/parent-1/reply") {
        if (init?.method === "POST") {
          attempted = true;
          return reply({});
        }
        return reply({
          comments: attempted
            ? [{ id: "other-reply", comment_text: "QA reply", user: { id: 808 } }]
            : [],
        });
      }
      return reply(fixture(path));
    });
    await expect(
      runCatalogOperation(
        "clickup_create_task_comment",
        { task_id: "abc123", parent_comment_id: "parent-1", text: "QA reply" },
        makeGrant(),
        fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_WRITE_OUTCOME_UNKNOWN");
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("creates a threaded reply only beneath an independently verified same-task parent", async () => {
    let wrote = false;
    const fetcher = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(request)).pathname;
      if (path === "/api/v2/task/abc123/comment")
        return reply({ comments: [{ id: "parent-1", reply_count: wrote ? 1 : 0 }] });
      if (path === "/api/v2/comment/parent-1/reply") {
        if (init?.method === "POST") {
          wrote = true;
          expect(JSON.parse(String(init.body))).toMatchObject({
            comment_text: "QA reply",
            notify_all: false,
          });
          return reply({});
        }
        return reply({
          comments: wrote ? [{ id: "reply-1", comment_text: "QA reply", user: { id: 707 } }] : [],
        });
      }
      return reply(fixture(path));
    });
    const output = await runCatalogOperation(
      "clickup_create_task_comment",
      { task_id: "abc123", parent_comment_id: "parent-1", text: "QA reply" },
      makeGrant(),
      fetcher as typeof fetch,
    );
    expect(output).toMatchObject({
      success: true,
      reply_id: "reply-1",
      verified_by_readback: true,
    });
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    const schema = CLICKUP_MODEL_TOOL_CATALOG.find(
      (t) => t.name === "clickup_create_task_comment",
    )!;
    expect(schema.inputSchema.properties["parent_comment_id"]?.type).toBe("string");
    await expect(
      runCatalogOperation(
        "clickup_create_task_comment",
        { task_id: "abc123", parent_comment_id: "foreign-parent", text: "unsafe" },
        makeGrant(),
        fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("accepts native Docs page_listing root arrays but still rejects arrays on unrelated endpoints", async () => {
    const f = vi.fn(async () => reply([{ id: "page1", name: "Test page" }]));
    const pages = await runCatalogOperation(
      "clickup_list_document_pages",
      { document_id: "doc1" },
      makeGrant(),
      f as typeof fetch,
    );
    expect(pages).toMatchObject({
      pages: [{ id: "page1", name: "Test page" }],
      incomplete: false,
      first_page_only: true,
    });

    await expect(
      runCatalogOperation("clickup_get_chat_channels", {}, makeGrant(), f as typeof fetch),
    ).rejects.toThrow("CLICKUP_BAD_RESPONSE");
  });

  it("bounds Docs page listings to 50 entries and discloses truncation", async () => {
    const f = vi.fn(async () => reply(Array.from({ length: 60 }, (_, i) => ({ id: "page" + i }))));
    const result = await runCatalogOperation(
      "clickup_list_document_pages",
      { document_id: "doc1" },
      makeGrant(),
      f as typeof fetch,
    );
    expect(result["pages"]).toHaveLength(50);
    expect(result).toMatchObject({ incomplete: true, first_page_only: true });
  });

  it("discloses when a Docs page contains more than 50 nested subpages", async () => {
    const children = Array.from({ length: 60 }, (_, i) => ({ id: "child" + i }));
    const f = vi.fn(async () => reply([{ id: "parent", pages: children }]));
    const result = await runCatalogOperation(
      "clickup_list_document_pages",
      { document_id: "doc1" },
      makeGrant(),
      f as typeof fetch,
    );
    const root = result["pages"] as Array<{ pages: unknown[] }>;
    expect(root).toHaveLength(1);
    expect(root[0]?.pages).toHaveLength(50);
    expect(result).toMatchObject({ incomplete: true, first_page_only: true });
  });

  it("accepts successful empty tag-add acknowledgements without weakening task creation", async () => {
    for (const outcome of [new Response(null, { status: 204 }), reply({})]) {
      const f = vi.fn(async (req: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "POST" ? outcome : reply(fixture(new URL(String(req)).pathname)),
      );
      const result = await runCatalogOperation(
        "clickup_add_tag_to_task",
        { task_id: "abc123", tag: "mcp-qa" },
        makeGrant(),
        f as typeof fetch,
      );
      expect(result).toMatchObject({
        success: true,
        source: "clickup-api",
        response_empty: true,
      });
      expect(f.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    }
  });

  it("accepts successful empty Docs page-update acknowledgements without retrying", async () => {
    for (const outcome of [new Response(null, { status: 204 }), reply({})]) {
      const f = vi.fn(async (_req: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.method).toBe("PUT");
        return outcome;
      });
      const result = await runCatalogOperation(
        "clickup_update_document_page",
        { document_id: "doc1", page_id: "page1", doc_content: "QA content" },
        makeGrant(),
        f as typeof fetch,
      );
      expect(result).toMatchObject({
        success: true,
        source: "clickup-api",
        response_empty: true,
      });
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it("verifies a committed Docs page edit after an unusable upstream write response", async () => {
    const calls: string[] = [];
    const f = vi.fn(async (req: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(req)).pathname;
      calls.push(String(init?.method) + " " + path);
      if (init?.method === "PUT")
        return new Response("OK", { status: 200, headers: { "Content-Type": "text/plain" } });
      return reply({ id: "page1", content: "New QA content" });
    });
    const result = await runCatalogOperation(
      "clickup_update_document_page",
      { document_id: "doc1", page_id: "page1", doc_content: "New QA content" },
      makeGrant(),
      f as typeof fetch,
    );
    expect(result).toMatchObject({ success: true, verified_by_readback: true });
    expect(calls).toEqual([
      "PUT /api/v3/workspaces/555/docs/doc1/pages/page1",
      "GET /api/v3/workspaces/555/docs/doc1/pages/page1",
    ]);
  });

  it("reports provider-normalized Markdown brackets on an otherwise verified Docs write", async () => {
    const calls: string[] = [];
    const content = "QA baseline\n[disposable test]";
    const f = vi.fn(async (req: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push(method);
      if (method === "PUT")
        return new Response("OK", { status: 200, headers: { "Content-Type": "text/plain" } });
      // Actual live ClickUp Docs round-tripped [test] as \\[test\\].
      return reply({ id: "page1", content: "QA baseline\n\\[disposable test\\]" });
    });
    const result = await runCatalogOperation(
      "clickup_update_document_page",
      { document_id: "doc1", page_id: "page1", doc_content: content },
      makeGrant(),
      f as typeof fetch,
    );
    expect(result).toMatchObject({
      success: true,
      source: "clickup-api",
      verified_by_readback: true,
      provider_normalized: true,
    });
    expect(result["warning"]).toContain("differs");
    expect(calls).toEqual(["PUT", "GET"]);
  });

  it("preserves uncertain writes when bracket escaping alters Markdown syntax or code", async () => {
    const requests = [
      "[Guide](https://example.test)",
      "Code arr[0] value",
      String.fromCharCode(96) + "arr[0]" + String.fromCharCode(96),
      "![image]",
      "# [heading]",
      "- [x] checked",
      "[^footnote]",
      "[Guide][reference]",
      "[QA note]\n---",
      "- item\n[QA note]",
      "1. item\n[QA note]",
      "QA baseline\n[QA note]\nFollowing paragraph",
    ];
    for (const content of requests) {
      const stored = content.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
      const f = vi.fn(async (_req: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PUT")
          return new Response("OK", { status: 200, headers: { "Content-Type": "text/plain" } });
        return reply({ id: "page1", content: stored });
      });
      await expect(
        runCatalogOperation(
          "clickup_update_document_page",
          { document_id: "doc1", page_id: "page1", doc_content: content },
          makeGrant(),
          f as typeof fetch,
        ),
      ).rejects.toThrow("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      expect(f.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
    }
  });

  it("does not accept other upstream Markdown transformations as exact confirmation", async () => {
    const f = vi.fn(async (_req: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT")
        return new Response("OK", { status: 200, headers: { "Content-Type": "text/plain" } });
      return reply({ id: "page1", content: "QA baseline\n[unrelated content]" });
    });
    await expect(
      runCatalogOperation(
        "clickup_update_document_page",
        { document_id: "doc1", page_id: "page1", doc_content: "QA baseline\n[disposable test]" },
        makeGrant(),
        f as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_WRITE_OUTCOME_UNKNOWN");
    expect(f.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
  });

  it("does not misreport a Docs edit when independent readback differs", async () => {
    const f = vi.fn(async (_req: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT")
        return new Response("OK", { status: 200, headers: { "Content-Type": "text/plain" } });
      return reply({ id: "page1", content: "Previous content" });
    });
    await expect(
      runCatalogOperation(
        "clickup_update_document_page",
        { document_id: "doc1", page_id: "page1", doc_content: "Requested content" },
        makeGrant(),
        f as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_WRITE_OUTCOME_UNKNOWN");
    expect(f.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
  });

  it("preserves upstream Docs permission denial without retrying or readback", async () => {
    const f = vi.fn(async () => reply({ err: "denied" }, 403));
    await expect(
      runCatalogOperation(
        "clickup_update_document_page",
        { document_id: "doc1", page_id: "page1", doc_content: "Requested content" },
        makeGrant(),
        f as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_UPSTREAM_DENIED");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("creates a Doc in an authorized Folder using ClickUp numeric parent type 5", async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const api = vi.fn(async (req: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(req)).pathname;
      requests.push({
        method: String(init?.method),
        path,
        ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}),
      });
      if (path === "/api/v2/folder/folder1") return reply({ id: "folder1", space: { id: "777" } });
      if (path === "/api/v2/team/555/space") return reply({ spaces: [{ id: "777" }] });
      if (init?.method === "POST") return reply({ id: "doc-1", name: "QA placed Doc" }, 201);
      throw Error("Unexpected request: " + path);
    });
    const doc = await runCatalogOperation(
      "clickup_create_document",
      { workspace_id: "555", name: "QA placed Doc", folder_id: "folder1" },
      makeGrant(),
      api as typeof fetch,
    );
    expect(doc).toMatchObject({ id: "doc-1" });
    expect(requests.filter((x) => x.method === "POST")).toEqual([
      {
        method: "POST",
        path: "/api/v3/workspaces/555/docs",
        body: {
          name: "QA placed Doc",
          create_page: true,
          parent: { id: "folder1", type: 5 },
        },
      },
    ]);
  });

  it("treats ambiguous 204 and empty-200 task creations as unknown writes", async () => {
    for (const response of [new Response(null, { status: 204 }), reply({})]) {
      const f = vi.fn(async (req: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "POST" ? response : reply(fixture(new URL(String(req)).pathname)),
      );
      await expect(
        runCatalogOperation(
          "clickup_create_task",
          { list_id: "12345", new_task: { name: "Possible duplicate" } },
          makeGrant(),
          f as typeof fetch,
        ),
      ).rejects.toThrow("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      expect(f.mock.calls.filter(([, opts]) => opts?.method === "POST")).toHaveLength(1);
    }
  });

  it("rejects malformed granted-List task and Workspace Docs responses", async () => {
    for (const malformed of ["tasks", "docs"]) {
      const f = vi.fn(async (req: RequestInfo | URL) => {
        const p = new URL(String(req)).pathname;
        if (p === "/api/v2/list/12345") return reply(fixture(p));
        if (p === "/api/v2/team/555/space") return reply(fixture(p));
        if (p === "/api/v2/list/12345/task" || p === "/api/v2/team/555/task")
          return reply(malformed === "tasks" ? {} : { tasks: [] });
        if (p === "/api/v3/workspaces/555/docs")
          return reply(malformed === "docs" ? {} : { docs: [] });
        return reply({ folders: [], lists: [] });
      });
      await expect(
        runCatalogOperation(
          "clickup_search_workspace",
          { query: "Stocktake" },
          malformed === "docs" ? makeGrant() : makeListGrant(),
          f as typeof fetch,
        ),
      ).rejects.toThrow("CLICKUP_BAD_RESPONSE");
    }
  });

  it("searches later task pages in an approved Workspace", async () => {
    const requestedPages: number[] = [];
    const f = vi.fn(async (req: RequestInfo | URL) => {
      const u = new URL(String(req));
      if (u.pathname === "/api/v2/team/555/task") {
        const page = Number(u.searchParams.get("page"));
        requestedPages.push(page);
        if (page === 0) {
          return reply({
            tasks: Array.from({ length: 100 }, (_, i) => ({
              id: "older-" + i,
              name: "Unrelated",
              list: { id: "12345" },
            })),
          });
        }
        if (page === 1) {
          return reply({
            tasks: [
              {
                id: "legacy-repair",
                name: "Legacy workshop repair",
                list: { id: "12346" },
              },
            ],
          });
        }
        throw Error("unexpected extra task page");
      }
      if (u.pathname === "/api/v3/workspaces/555/docs") return reply({ docs: [] });
      if (u.pathname === "/api/v2/team/555/space") return reply({ spaces: [] });
      throw Error("unexpected endpoint " + u.pathname);
    });
    const result = await runCatalogOperation(
      "clickup_search_workspace",
      { query: "Legacy workshop", max_results: 10 },
      makeGrant(),
      f as typeof fetch,
    );
    expect(result).toMatchObject({
      scope: "workspace",
      incomplete: false,
      pages_scanned: 2,
      next_task_page: null,
    });
    expect(result["tasks"]).toEqual([
      {
        id: "legacy-repair",
        name: "Legacy workshop repair",
        list: { id: "12346" },
      },
    ]);
    expect(requestedPages).toEqual([0, 1]);
  });

  it("provides a continuation page for large Workspace searches", async () => {
    const requestedPages: number[] = [];
    const f = vi.fn(async (req: RequestInfo | URL) => {
      const u = new URL(String(req));
      if (u.pathname === "/api/v2/team/555/task") {
        const page = Number(u.searchParams.get("page"));
        requestedPages.push(page);
        if (page < 10) {
          return reply({
            tasks: Array.from({ length: 100 }, (_, i) => ({
              id: "task-" + page + "-" + i,
              name: "Other repair",
              list: { id: "12345" },
            })),
          });
        }
        if (page === 10) {
          return reply({
            tasks: [
              {
                id: "legacy-repair",
                name: "Legacy workshop",
                list: { id: "12346" },
              },
            ],
          });
        }
        throw Error("unexpected task page");
      }
      if (u.pathname === "/api/v3/workspaces/555/docs") return reply({ docs: [] });
      if (u.pathname === "/api/v2/team/555/space") return reply({ spaces: [] });
      throw Error("unexpected endpoint " + u.pathname);
    });
    const first = await runCatalogOperation(
      "clickup_search_workspace",
      { query: "Legacy workshop" },
      makeGrant(),
      f as typeof fetch,
    );
    expect(first).toMatchObject({
      scope: "workspace",
      incomplete: true,
      pages_scanned: 10,
      next_task_page: 10,
    });
    expect(first["tasks"]).toEqual([]);
    const next = await runCatalogOperation(
      "clickup_search_workspace",
      { query: "Legacy workshop", task_page: 10 },
      makeGrant(),
      f as typeof fetch,
    );
    expect(next).toMatchObject({
      scope: "workspace",
      incomplete: false,
      pages_scanned: 1,
      next_task_page: null,
    });
    expect(next["tasks"]).toEqual([
      {
        id: "legacy-repair",
        name: "Legacy workshop",
        list: { id: "12346" },
      },
    ]);
    expect(requestedPages).toEqual(Array.from({ length: 11 }, (_, page) => page));
  });

  it("restricts workspace task search to granted List and rejects foreign-home tasks", async () => {
    const urls: string[] = [];
    const f = vi.fn(async (req: RequestInfo | URL) => {
      const u = new URL(String(req));
      urls.push(u.pathname);
      if (u.pathname === "/api/v2/list/12345/task")
        return reply({ tasks: [{ id: "wrong", name: "Sensitive", list: { id: "12346" } }] });
      if (u.pathname === "/api/v2/list/12345") return reply(fixture(u.pathname));
      if (u.pathname === "/api/v2/team/555/space") return reply(fixture(u.pathname));
      throw Error("unexpected request");
    });
    await expect(
      runCatalogOperation(
        "clickup_search_workspace",
        { query: "Sensitive" },
        makeListGrant(),
        f as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(urls).not.toContain("/api/v2/team/555/task");
    expect(urls).not.toContain("/api/v3/workspaces/555/docs");
  });

  it("removes tags with spaces through a single URL-encoded native delete", async () => {
    const f = fakeApi();
    await runCatalogOperation(
      "clickup_remove_tag_from_task",
      { task_id: "abc123", tag: "Needs Attention" },
      makeGrant(),
      f as typeof fetch,
    );
    const deletes = f.mock.calls.filter(([, init]) => init?.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(String(deletes[0]?.[0])).toContain("/tag/Needs%20Attention");
  });

  it("discloses truncation and possible additional comment pages", async () => {
    const f = vi.fn(async (req: RequestInfo | URL) => {
      const p = new URL(String(req)).pathname;
      if (p === "/api/v2/task/abc123/comment") {
        return reply({ comments: Array.from({ length: 25 }, (_, i) => ({ id: "c" + i })) });
      }
      return reply(fixture(p));
    });
    const result = await runCatalogOperation(
      "clickup_get_task_comments",
      { task_id: "abc123", max_results: 10 },
      makeGrant(),
      f as typeof fetch,
    );
    expect(result["comments"]).toHaveLength(10);
    expect(result).toMatchObject({ incomplete: true, first_page_only: true });
  });

  it("propagates attachment 429 cooldown to the per-user quota", async () => {
    const events: string[] = [];
    const grant: ReadGrant = {
      ...makeGrant(),
      quota: {
        idFromName: (n: string) => n,
        get: () => ({
          fetch: async (request: Request) => {
            events.push(new URL(request.url).pathname);
            return reply({ allowed: true });
          },
        }),
      },
    };
    const f = vi.fn(async (req: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST")
        return new Response(JSON.stringify({}), {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 45),
          },
        });
      return reply(fixture(new URL(String(req)).pathname));
    });
    await expect(
      runCatalogOperation(
        "clickup_attach_file_to_task",
        {
          task_id: "abc123",
          file_name: "test.txt",
          file_base64: btoa("hello"),
        },
        grant,
        f as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_RATE_LIMITED");
    expect(events).toContain("/cooldown");
  });

  it("returns matching Workspace Folders and Lists, including folder children", async () => {
    const f = vi.fn(async (req: RequestInfo | URL) => {
      const p = new URL(String(req)).pathname;
      if (p === "/api/v2/list/12345") return reply(fixture(p));
      if (p === "/api/v2/team/555/task") return reply({ tasks: [] });
      if (p === "/api/v3/workspaces/555/docs") return reply({ docs: [] });
      if (p === "/api/v2/team/555/space") return reply({ spaces: [{ id: "777", name: "Sales" }] });
      if (p === "/api/v2/space/777/folder")
        return reply({ folders: [{ id: "f1", name: "Stocktake Folder" }] });
      if (p === "/api/v2/space/777/list")
        return reply({ lists: [{ id: "l1", name: "Stocktake List" }] });
      if (p === "/api/v2/folder/f1/list")
        return reply({ lists: [{ id: "l2", name: "Stocktake Extra List" }] });
      throw Error("unexpected mocked path " + p);
    });
    const output = await runCatalogOperation(
      "clickup_search_workspace",
      { query: "Stocktake" },
      makeGrant(),
      f as typeof fetch,
    );
    expect(output["lists"]).toHaveLength(2);
    expect(output["folders"]).toHaveLength(1);
    expect(output["incomplete"]).toBe(false);
  });
  it("reads one task in legacy List scope using its atomic home-List metadata", async () => {
    const api = fakeApi();
    const result = await runCatalogOperation(
      "clickup_get_task",
      { task_id: "abc123" },
      makeListGrant(),
      api as typeof fetch,
    );
    expect(result).toMatchObject({
      id: "abc123",
      list: { id: "12345" },
    });
    expect(api.mock.calls.map(([req]) => new URL(String(req)).pathname)).toEqual([
      "/api/v2/task/abc123",
      "/api/v2/list/12345",
      "/api/v2/team/555/space",
    ]);
  });

  it("rejects foreign-List task metadata before any further API request", async () => {
    const api = vi.fn(async (_req: RequestInfo | URL) =>
      reply({ id: "foreign1", name: "Private", list: { id: "12346" } }),
    );
    await expect(
      runCatalogOperation(
        "clickup_get_task",
        { task_id: "foreign1" },
        makeListGrant(),
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(api).toHaveBeenCalledTimes(1);
    expect(String(api.mock.calls[0]?.[0])).toContain("/api/v2/task/foreign1");
  });

  it("denies unsafe task-ID operations in legacy single-List mode", async () => {
    const f = fakeApi();
    for (const name of [
      "clickup_update_task",
      "clickup_update_bulk_tasks",
      "clickup_get_list_time_in_status",
      "clickup_stop_time_tracking",
      "clickup_move_task_to_list",
    ]) {
      await expect(
        runCatalogOperation(name, { task_id: "abc123" }, makeListGrant(), f as typeof fetch),
      ).rejects.toThrow("CLICKUP_WORKSPACE_SCOPE_REQUIRED");
    }
    expect(f).not.toHaveBeenCalled();
    expect(OPERATIONAL_CATALOG_NAMES).toHaveLength(57);
  });

  it("permits cross-List moves in the explicitly authorised Workspace", async () => {
    const f = fakeApi();
    await runCatalogOperation(
      "clickup_move_task_to_list",
      { task_id: "abc123", source_list_id: "12345", destination_list_id: "12346" },
      makeGrant(),
      f as typeof fetch,
    );
    const moved = f.mock.calls.filter(([, init]) => init?.method === "PUT");
    expect(moved).toHaveLength(1);
    expect(String(moved[0]?.[0])).toContain("/workspaces/555/tasks/abc123/home_list/12346");
  });

  it("blocks cross-Workspace destinations before issuing a mutation", async () => {
    const f = fakeApi();
    await expect(
      runCatalogOperation(
        "clickup_move_task_to_list",
        { task_id: "abc123", source_list_id: "12345", destination_list_id: "99999" },
        makeGrant(),
        f as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(f.mock.calls.every(([, init]) => init?.method !== "PUT")).toBe(true);
  });

  it("rejects absent time-in-status data instead of returning a false empty success", async () => {
    const requests: string[] = [];
    const api = vi.fn(async (req: RequestInfo | URL) => {
      const path = new URL(String(req)).pathname;
      requests.push(path);
      if (path === "/api/v2/list/12345/task")
        return reply({ tasks: [{ id: "abc123" }, { id: "abc124" }] });
      if (path.endsWith("/time_in_status") || path.includes("/bulk_time_in_status/"))
        return reply({});
      return reply(fixture(path));
    });
    await expect(
      runCatalogOperation(
        "clickup_get_task_time_in_status",
        { task_id: "abc123" },
        makeGrant(),
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_STATUS_TIME_DATA_UNAVAILABLE");
    await expect(
      runCatalogOperation(
        "clickup_get_list_time_in_status",
        { list_id: "12345", max_results: 2 },
        makeGrant(),
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_STATUS_TIME_DATA_UNAVAILABLE");
    expect(requests).toContain("/api/v2/task/bulk_time_in_status/task_ids");
  });

  it("rejects status-only envelopes instead of presenting plan-restricted data as success", async () => {
    const api = vi.fn(async (req: RequestInfo | URL) => {
      const path = new URL(String(req)).pathname;
      if (path === "/api/v2/list/12345/task") return reply({ tasks: [{ id: "abc123" }] });
      if (path.endsWith("/time_in_status") || path.includes("/bulk_time_in_status/"))
        return reply({ incomplete: false, first_page_only: true });
      return reply(fixture(path));
    });
    await expect(
      runCatalogOperation(
        "clickup_get_task_time_in_status",
        { task_id: "abc123" },
        makeGrant(),
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_STATUS_TIME_DATA_UNAVAILABLE");
    await expect(
      runCatalogOperation(
        "clickup_get_list_time_in_status",
        { list_id: "12345" },
        makeGrant(),
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_STATUS_TIME_DATA_UNAVAILABLE");
  });

  it("requires actual status records for every requested task in a bulk response", async () => {
    const api = vi.fn(async (req: RequestInfo | URL) => {
      const path = new URL(String(req)).pathname;
      if (path === "/api/v2/list/12345/task")
        return reply({ tasks: [{ id: "abc123" }, { id: "abc124" }] });
      if (path.includes("/bulk_time_in_status/"))
        return reply({ abc123: { current_status: { status: "Open" } } });
      return reply(fixture(path));
    });
    await expect(
      runCatalogOperation(
        "clickup_get_list_time_in_status",
        { list_id: "12345" },
        makeGrant(),
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_STATUS_TIME_DATA_UNAVAILABLE");
  });

  it("rejects partially malformed or duplicate List task rows before requesting status data", async () => {
    for (const rows of [
      [{ id: "abc123" }, { name: "Missing ID" }],
      [{ id: "abc123" }, { id: "abc123" }],
    ]) {
      const requests: string[] = [];
      const api = vi.fn(async (req: RequestInfo | URL) => {
        const path = new URL(String(req)).pathname;
        requests.push(path);
        if (path === "/api/v2/list/12345/task") return reply({ tasks: rows });
        return reply(fixture(path));
      });
      await expect(
        runCatalogOperation(
          "clickup_get_list_time_in_status",
          { list_id: "12345", max_results: 2 },
          makeGrant(),
          api as typeof fetch,
        ),
      ).rejects.toThrow("CLICKUP_BAD_RESPONSE");
      expect(requests.some((path) => path.includes("bulk_time_in_status"))).toBe(false);
    }
  });

  it("flags first-page and max-results caps when reporting valid status data", async () => {
    for (const { rows, maxResults, lastPage } of [
      { rows: [{ id: "abc123" }, { id: "abc124" }, { id: "abc125" }], maxResults: 2 },
      { rows: [{ id: "abc123" }], maxResults: 5, lastPage: false },
    ]) {
      const api = vi.fn(async (req: RequestInfo | URL) => {
        const url = new URL(String(req));
        if (url.pathname === "/api/v2/list/12345/task")
          return reply({
            tasks: rows,
            ...(lastPage === undefined ? {} : { last_page: lastPage }),
          });
        if (url.pathname.includes("/bulk_time_in_status/"))
          return reply(
            Object.fromEntries(
              url.searchParams
                .getAll("task_ids")
                .map((taskId) => [taskId, { current_status: { status: "Open", total_time: 300 } }]),
            ),
          );
        return reply(fixture(url.pathname));
      });
      const data = await runCatalogOperation(
        "clickup_get_list_time_in_status",
        { list_id: "12345", max_results: maxResults },
        makeGrant(),
        api as typeof fetch,
      );
      expect(data).toMatchObject({
        abc123: { current_status: { status: "Open", total_time: 300 } },
        incomplete: true,
        first_page_only: true,
      });
      if (maxResults === 2) expect(data["abc125"]).toBeUndefined();
    }
  });

  it("refuses malformed List task metadata instead of inventing an empty List", async () => {
    const api = vi.fn(async (req: RequestInfo | URL) => {
      const path = new URL(String(req)).pathname;
      if (path === "/api/v2/list/12345/task") return reply({ tasks: "invalid" });
      return reply(fixture(path));
    });
    await expect(
      runCatalogOperation(
        "clickup_get_list_time_in_status",
        { list_id: "12345" },
        makeGrant(),
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_BAD_RESPONSE");
  });

  it("preserves actual time-in-status records and legitimate empty Lists", async () => {
    const api = vi.fn(async (req: RequestInfo | URL) => {
      const path = new URL(String(req)).pathname;
      if (path === "/api/v2/list/12345/task") return reply({ tasks: [{ id: "abc123" }] });
      if (path === "/api/v2/task/abc123/time_in_status")
        return reply({ current_status: { status: "Open", total_time: 1234 } });
      if (path.includes("/bulk_time_in_status/"))
        return reply({ abc123: { current_status: { status: "Open" }, status_history: [] } });
      return reply(fixture(path));
    });
    const single = await runCatalogOperation(
      "clickup_get_task_time_in_status",
      { task_id: "abc123" },
      makeGrant(),
      api as typeof fetch,
    );
    expect(single).toMatchObject({ current_status: { status: "Open" } });
    const batch = await runCatalogOperation(
      "clickup_get_list_time_in_status",
      { list_id: "12345", max_results: 2 },
      makeGrant(),
      api as typeof fetch,
    );
    expect(batch).toMatchObject({ abc123: { status_history: [] } });

    const emptyApi = vi.fn(async (req: RequestInfo | URL) => {
      const path = new URL(String(req)).pathname;
      return path === "/api/v2/list/12345/task" ? reply({ tasks: [] }) : reply(fixture(path));
    });
    const empty = await runCatalogOperation(
      "clickup_get_list_time_in_status",
      { list_id: "12345" },
      makeGrant(),
      emptyApi as typeof fetch,
    );
    expect(empty).toEqual({ source: "clickup-api-v2", tasks: [] });
    expect(
      emptyApi.mock.calls.filter(([req]) => String(req).includes("bulk_time_in_status")),
    ).toHaveLength(0);
  });

  it("routes expanded search to the ClickUp Workspace endpoint", async () => {
    const requests: string[] = [];
    const f = vi.fn(async (req: RequestInfo | URL) => {
      const url = new URL(String(req));
      requests.push(url.pathname);
      if (url.pathname === "/api/v2/team/555/task")
        return reply({ tasks: [{ id: "inb", name: "Stocktake B", list: { id: "12346" } }] });
      if (url.pathname === "/api/v3/workspaces/555/docs") return reply({ docs: [] });
      if (url.pathname === "/api/v2/team/555/space")
        return reply({ spaces: [{ id: "777", name: "Sales" }] });
      if (url.pathname === "/api/v2/space/777/folder") return reply({ folders: [] });
      if (url.pathname === "/api/v2/space/777/list") return reply({ lists: [] });
      throw Error("unexpected endpoint");
    });
    const result = await runCatalogOperation(
      "clickup_search_workspace",
      { query: "Stocktake" },
      makeGrant(),
      f as typeof fetch,
    );
    expect(result["tasks"]).toHaveLength(1);
    expect(requests).toContain("/api/v2/team/555/task");
    expect(requests).not.toContain("/api/v2/list/12345/task");
  });
});
