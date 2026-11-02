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
const reply = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Content-Type": "application/json" } });
const fixture = (path: string) => {
  if (path === "/api/v2/list/12345") return { id: "12345", space: { id: "777" } };
  if (path === "/api/v2/list/99999") return { id: "99999", space: { id: "888" } };
  if (path === "/api/v2/list/12346") return { id: "12346", space: { id: "777" } };
  if (path === "/api/v2/team/555/space") return { spaces: [{ id: "777", name: "NeonSales" }] };
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
  it("registers all 48 REST backed capability names including a bounded binary attachment implementation", () => {
    expect(OPERATIONAL_CATALOG_NAMES).toHaveLength(48);
    expect(new Set(OPERATIONAL_CATALOG_NAMES).size).toBe(48);
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
      { name: "Bad", assignee_ids: ["707"] },
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
          assignee_ids: [707],
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

  it("advertises numeric member IDs and decimal custom field values", () => {
    const create = CLICKUP_MODEL_TOOL_CATALOG.find((tool) => tool.name === "clickup_create_task")!;
    const draft = create.inputSchema.properties["new_task"]!;
    expect(draft.properties?.["assignee_ids"]?.items?.type).toBe("integer");
    const custom = CLICKUP_MODEL_TOOL_CATALOG.find(
      (tool) => tool.name === "clickup_set_custom_field",
    )!;
    expect(custom.inputSchema.properties["field_value"]?.properties?.["number"]?.type).toBe(
      "number",
    );
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
    const blob = sent!.get("attachment[0]") as File;
    expect(blob.name).toBe("note.txt");
    expect(await blob.text()).toBe("hello");
    expect(f).toHaveBeenCalledTimes(4);
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
    expect(OPERATIONAL_CATALOG_NAMES).toHaveLength(48);
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
