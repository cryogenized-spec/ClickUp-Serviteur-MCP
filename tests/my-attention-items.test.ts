import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCatalogOperation } from "../src/clickup/catalog-runtime.js";
import { CLICKUP_MODEL_TOOL_CATALOG } from "../src/mcp/tool-catalog.js";
import type { ReadGrant } from "../src/clickup/policy.js";

const now = Date.parse("2026-11-09T17:30:00.000Z");
const date = (iso: string) => String(Date.parse(iso));
const myId = "707";
const grant = (scope: "list" | "workspace" = "list"): ReadGrant => ({
  subject: "github:11",
  clickupUserId: myId,
  workspaceId: "555",
  listId: "12345",
  resourceScope: scope,
  apiToken: "fixture-only-oauth-token",
  quota: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
  },
});
const task = (id: string, options: {
  assigned?: boolean;
  home?: string;
  due?: string;
  dateOnly?: boolean;
  updated?: string;
  priority?: number;
} = {}) => ({
  id,
  name: "Task " + id,
  list: { id: options.home ?? "12345" },
  status: { status: "to do" },
  assignees: options.assigned === false ? [] : [{ id: 707 }],
  date_updated: options.updated ?? date("2026-11-09T16:00:00.000Z"),
  ...(options.due ? { due_date: date(options.due) } : {}),
  due_date_time: options.dateOnly === false,
  priority: { id: String(options.priority ?? 2) },
  url: "https://app.clickup.com/t/" + id,
});
const comment = (id: string, options: {
  assignee?: number;
  resolved?: boolean;
  mentioned?: boolean;
  group?: boolean;
  when?: string;
} = {}) => ({
  id,
  date: options.when ?? date("2026-11-09T16:15:00.000Z"),
  assignee: options.assignee ? { id: options.assignee } : null,
  resolved: options.resolved ?? false,
  ...(options.group ? { group_assignee: { id: "group1" } } : {}),
  comment_text: "Please check",
  comment: options.mentioned
    ? [{ text: "Please check " }, { type: "tag", user: { id: 707 } }, { text: " today" }]
    : [{ text: "Please check, Gareth." }],
});
function fixture(options: {
  assigned?: Array<ReturnType<typeof task>>;
  activity?: Array<ReturnType<typeof task>>;
  comments?: Record<string, unknown[]>;
  rateLimitCommentTask?: string;
  badCommentPage?: boolean;
} = {}) {
  const calls: Array<{ method: string; path: string; query: URLSearchParams }> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname, query: new URLSearchParams(url.search) });
    const reply = (payload: unknown) => Response.json(payload);
    if (url.pathname === "/api/v2/list/12345")
      return reply({ id: "12345", space: { id: "777" } });
    if (url.pathname === "/api/v2/team/555/space")
      return reply({ spaces: [{ id: "777" }] });
    if (url.pathname === "/api/v2/list/99999")
      return reply({ id: "99999", space: { id: "888" } });
    if (url.pathname === "/api/v2/list/12345/task" ||
        url.pathname === "/api/v2/team/555/task") {
      return reply({ tasks: url.searchParams.has("assignees[]")
        ? options.assigned ?? [task("mine", { due: "2026-11-08T12:00:00.000Z" })]
        : options.activity ?? [task("mine"), task("other", { assigned: false })] });
    }
    const commentMatch = /^\/api\/v2\/task\/([a-zA-Z0-9_-]+)\/comment$/.exec(url.pathname);
    if (commentMatch) {
      if (commentMatch[1] === options.rateLimitCommentTask)
        return new Response(null, { status: 429 });
      return reply({ comments: options.badCommentPage
        ? [{ arbitrary: "not-a-comment" }]
        : options.comments?.[commentMatch[1]!] ?? [] });
    }
    throw new Error("Unexpected API request " + method + " " + url.pathname);
  });
  return { fetcher, calls };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("dedicated read-only ClickUp attention aggregation", () => {
  it("registers exactly one named read tool with no model-facing credentials", () => {
    const found = CLICKUP_MODEL_TOOL_CATALOG.filter((x) => x.name === "clickup_get_my_attention_items");
    expect(found).toHaveLength(1);
    expect(found[0]?.effect).toBe("read");
    expect(found[0]?.inputSchema.properties).not.toHaveProperty("api_token");
    expect(found[0]?.inputSchema.properties).not.toHaveProperty("user_id");
    expect(found[0]?.inputSchema.properties).not.toHaveProperty("execute");
  });

  it("uses the connected ClickUp identity, includes subtasks, and makes only GET calls", async () => {
    const api = fixture();
    const result = await runCatalogOperation(
      "clickup_get_my_attention_items", {}, grant(), api.fetcher as typeof fetch,
    );
    expect(result).toMatchObject({
      is_official_inbox: false,
      timezone: "Africa/Johannesburg",
      user_id: "707",
      scope: "list",
    });
    const queries = api.calls.filter((c) => c.path.endsWith("/task"));
    expect(queries).toHaveLength(2);
    expect(queries[0]?.query.getAll("assignees[]")).toEqual(["707"]);
    expect(queries[0]?.query.get("subtasks")).toBe("true");
    expect(queries[1]?.query.has("assignees[]")).toBe(false);
    expect(api.calls.every((c) => c.method === "GET")).toBe(true);
    expect(api.calls.some((c) => c.path === "/api/v2/team/555/task")).toBe(false);
  });

  it("places assigned comments, overdue tasks, genuine mentions, and due-soon tasks in order", async () => {
    const api = fixture({
      assigned: [
        task("overdue", { due: "2026-11-08T12:00:00.000Z" }),
        task("soon", { due: "2026-11-10T12:00:00.000Z" }),
        task("regular"),
      ],
      activity: [
        task("overdue"),
        task("mention", { assigned: false }),
        task("assigned-comment", { assigned: false }),
      ],
      comments: {
        "mention": [comment("c-mention", { mentioned: true })],
        "assigned-comment": [comment("c-assigned", { assignee: 707, resolved: false })],
      },
    });
    const result = await runCatalogOperation(
      "clickup_get_my_attention_items", { max_results: 20 }, grant(), api.fetcher as typeof fetch,
    );
    const items = result["items"] as Array<{ kind: string; reasons: string[]; comment_id?: string }>;
    expect(items.map((x) => x.kind)).toEqual([
      "assigned_comment",
      "overdue_task",
      "mention",
      "due_soon_task",
      "assigned_task",
    ]);
    expect(items[0]?.comment_id).toBe("c-assigned");
    expect(items[2]?.reasons).toEqual(["individual_mention"]);
  });

  it("does not confuse a plain name or group-assignment with a genuine individual mention", async () => {
    const api = fixture({
      assigned: [],
      activity: [task("other", { assigned: false })],
      comments: {
        other: [
          comment("normal"),
          comment("group", { group: true }),
        ],
      },
    });
    const result = await runCatalogOperation(
      "clickup_get_my_attention_items", {}, grant(), api.fetcher as typeof fetch,
    );
    expect(result["items"]).toEqual([]);
    expect(result["no_matches_statement"]).toContain("inspected");
    expect((result["coverage"] as Record<string, unknown>)["group_mentions_included"]).toBe(false);
  });

  it("merges assigned and mentioned reasons for the same unresolved comment", async () => {
    const api = fixture({
      assigned: [],
      activity: [task("other", { assigned: false })],
      comments: { other: [comment("both", { assignee: 707, mentioned: true })] },
    });
    const result = await runCatalogOperation(
      "clickup_get_my_attention_items", {}, grant(), api.fetcher as typeof fetch,
    );
    const items = result["items"] as Array<{ item_id: string; reasons: string[] }>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      item_id: "comment:other:both",
      reasons: ["unresolved_comment_assigned_to_me", "individual_mention"],
    });
  });

  it("does not call date-only due-today work overdue before local midnight", async () => {
    vi.setSystemTime(Date.parse("2026-11-08T22:05:00.000Z")); // Nov 9, 00:05 SAST
    const api = fixture({
      assigned: [task("today", { due: "2026-11-09T12:00:00.000Z" })],
      activity: [],
    });
    const result = await runCatalogOperation(
      "clickup_get_my_attention_items", {}, grant(), api.fetcher as typeof fetch,
    );
    expect((result["items"] as Array<{ kind: string }>)[0]?.kind).toBe("due_soon_task");
  });

  it("includes older unresolved assigned comments but filters older optional mentions", async () => {
    const api = fixture({
      assigned: [],
      activity: [task("old", { assigned: false })],
      comments: { old: [
        comment("old-mention", { mentioned: true, when: date("2026-10-01T12:00:00.000Z") }),
        comment("old-assigned", { assignee: 707, when: date("2026-10-01T12:00:00.000Z") }),
      ] },
    });
    const result = await runCatalogOperation(
      "clickup_get_my_attention_items", {}, grant(), api.fetcher as typeof fetch,
    );
    expect((result["items"] as Array<{ comment_id: string }>).map((x) => x.comment_id))
      .toEqual(["old-assigned"]);
  });

  it("strictly rejects a foreign home List returned by a List-scoped task query", async () => {
    const api = fixture({
      assigned: [task("foreign", { home: "99999" })],
      activity: [],
    });
    await expect(
      runCatalogOperation("clickup_get_my_attention_items", {}, grant(), api.fetcher as typeof fetch),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(api.calls.every((c) => !c.path.includes("/comment"))).toBe(true);
  });

  it("uses Workspace task search only with Workspace authority and preflights comment List ancestry", async () => {
    const api = fixture({
      assigned: [],
      activity: [task("other", { assigned: false })],
      comments: { other: [comment("note", { mentioned: true })] },
    });
    const result = await runCatalogOperation(
      "clickup_get_my_attention_items", {}, grant("workspace"), api.fetcher as typeof fetch,
    );
    expect(result["scope"]).toBe("workspace");
    expect(api.calls.filter((c) => c.path === "/api/v2/team/555/task")).toHaveLength(2);
    expect(api.calls.some((c) => c.path === "/api/v2/list/12345")).toBe(true);
  });

  it("never broadens a List-only grant when a caller asks for another List", async () => {
    const api = fixture();
    await expect(runCatalogOperation(
      "clickup_get_my_attention_items", { list_id: "99999" }, grant(), api.fetcher as typeof fetch,
    )).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(api.calls.every((c) => !c.path.endsWith("/task"))).toBe(true);
  });

  it("reports an actual 429 after verified task results as partial without adding quota controls", async () => {
    const api = fixture({
      assigned: [task("mine", { due: "2026-11-08T12:00:00.000Z" })],
      activity: [task("mine")],
      rateLimitCommentTask: "mine",
    });
    const result = await runCatalogOperation(
      "clickup_get_my_attention_items", {}, grant(), api.fetcher as typeof fetch,
    );
    expect(result).toMatchObject({
      partial: true,
      interrupted_reason: "clickup_rate_limited",
      incomplete: true,
    });
    expect((result["items"] as Array<unknown>).length).toBeGreaterThan(0);
  });

  it("propagates malformed comment content rather than reporting a successful scan", async () => {
    const api = fixture({ badCommentPage: true });
    await expect(
      runCatalogOperation("clickup_get_my_attention_items", {}, grant(), api.fetcher as typeof fetch),
    ).rejects.toThrow("CLICKUP_BAD_RESPONSE");
  });

  it("discloses bounded comment coverage and excludes replies and watched-only tasks", async () => {
    const api = fixture({
      assigned: [],
      activity: Array.from({ length: 10 }, (_, i) => task("candidate-" + i, { assigned: false })),
    });
    const result = await runCatalogOperation(
      "clickup_get_my_attention_items", { attention_comment_tasks: 2 }, grant(),
      api.fetcher as typeof fetch,
    );
    expect((result["coverage"] as Record<string, unknown>)).toMatchObject({
      activity_tasks_examined: 10,
      comment_tasks_inspected: 2,
      comment_pages_inspected: 2,
      threaded_replies_included: false,
      watched_tasks_included: false,
      comments_on_uninspected_tasks_may_be_missing: true,
    });
    expect(result["incomplete"]).toBe(true);
    expect(api.calls.filter((c) => c.path.endsWith("/comment"))).toHaveLength(2);
  });

  it("has stable ranked result offsets, without silently losing extra found items", async () => {
    const api = fixture({
      assigned: [task("a"), task("b"), task("c")],
      activity: [],
    });
    const first = await runCatalogOperation(
      "clickup_get_my_attention_items", { max_results: 2, attention_comment_tasks: 0 },
      grant(), api.fetcher as typeof fetch,
    );
    expect(first["next_result_offset"]).toBe(2);
    const second = await runCatalogOperation(
      "clickup_get_my_attention_items",
      { max_results: 2, attention_result_offset: 2, attention_comment_tasks: 0 },
      grant(), api.fetcher as typeof fetch,
    );
    const ids = [
      ...(first["items"] as Array<{ item_id: string }>).map((x) => x.item_id),
      ...(second["items"] as Array<{ item_id: string }>).map((x) => x.item_id),
    ];
    expect(ids).toEqual(["task:a", "task:b", "task:c"]);
    expect(second["next_result_offset"]).toBeNull();
  });
});
