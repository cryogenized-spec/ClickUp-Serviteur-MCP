import { describe, expect, it, vi } from "vitest";
import { runCatalogOperation } from "../src/clickup/catalog-runtime.js";
import type { ReadGrant } from "../src/clickup/policy.js";
import { CLICKUP_MODEL_TOOL_CATALOG } from "../src/mcp/tool-catalog.js";

const grant = (resourceScope: "list" | "workspace" = "list"): ReadGrant => ({
  subject: "github:11",
  clickupUserId: "707",
  workspaceId: "555",
  listId: "12345",
  resourceScope,
  apiToken: "synthetic-token",
  quota: {
    idFromName: (key: string) => key,
    get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
  },
});
const reply = (value: unknown) =>
  Response.json(value, { headers: { "Content-Type": "application/json" } });

function fakeTaskApi(
  taskPage: (page: number) => unknown[],
  resourceScope: "list" | "workspace" = "list",
) {
  const pages: number[] = [];
  const fetcher = vi.fn(async (req: RequestInfo | URL) => {
    const url = new URL(String(req));
    if (url.pathname === "/api/v2/list/12345")
      return reply({ id: "12345", space: { id: "777" } });
    if (url.pathname === "/api/v2/team/555/space")
      return reply({ spaces: [{ id: "777" }] });
    const taskPath =
      resourceScope === "list" ? "/api/v2/list/12345/task" : "/api/v2/team/555/task";
    if (url.pathname === taskPath) {
      const page = Number(url.searchParams.get("page"));
      pages.push(page);
      return reply({ tasks: taskPage(page) });
    }
    throw new Error("Unexpected or out-of-scope route: " + url.pathname);
  });
  return { fetcher, pages };
}
const task = (id: string, type = 7, tags = ["QC"], list = "12345") => ({
  id,
  list: { id: list },
  custom_item_id: type,
  tags: tags.map((name) => ({ name })),
});

const dates = (page: number, length: number) =>
  Array.from({ length }, (_, index) => ({
    id: "comment-" + (page * 25 + index),
    date: String(1_790_000_000_000 - page * 25 - index),
    comment_text: "Status update",
  }));

function fakeCommentsApi(pages: Array<Array<Record<string, unknown>>>) {
  const cursors: Array<[string | null, string | null]> = [];
  const requests: string[] = [];
  const fetcher = vi.fn(async (req: RequestInfo | URL) => {
    const url = new URL(String(req));
    requests.push(url.pathname);
    if (url.pathname === "/api/v2/task/task1")
      return reply({ id: "task1", list: { id: "12345" } });
    if (url.pathname === "/api/v2/list/12345")
      return reply({ id: "12345", space: { id: "777" } });
    if (url.pathname === "/api/v2/team/555/space")
      return reply({ spaces: [{ id: "777" }] });
    if (url.pathname === "/api/v2/task/task1/comment") {
      const start = url.searchParams.get("start");
      const startId = url.searchParams.get("start_id");
      cursors.push([start, startId]);
      if (start !== null && startId === null) throw new Error("Unpaired cursor");
      const page =
        startId === null
          ? 0
          : pages.findIndex((items) => {
              const last = items.at(-1);
              return last?.["id"] === startId && String(last["date"]) === start;
            }) + 1;
      if (page < 0) throw new Error("Unrecognized comment cursor");
      return reply({ comments: pages[page] ?? [] });
    }
    if (url.pathname === "/api/v2/comment/comment-29/reply")
      return reply({ comments: [{ id: "reply1", comment_text: "Acknowledged" }] });
    throw new Error("Unexpected route " + url.pathname);
  });
  return { fetcher, cursors, requests };
}

describe("bounded ClickUp v2 pagination with one tool per function", () => {
  it("reaches tag matches on subsequent pages without leaving the home List", async () => {
    const api = fakeTaskApi((page) =>
      page === 0
        ? Array.from({ length: 100 }, (_, i) => task("old-" + i, 7, ["Other"]))
        : [task("target", 7, ["QC"])],
    );
    const result = await runCatalogOperation(
      "clickup_search_tasks_by_tag",
      { tag: "QC" },
      grant(),
      api.fetcher as typeof fetch,
    );
    expect(result).toMatchObject({ incomplete: false, pages_scanned: 2, next_task_page: null });
    expect((result["tasks"] as Array<{ id: string }>).map((t) => t.id)).toEqual(["target"]);
    expect(api.pages).toEqual([0, 1]);
  });

  it("retrieves task types on subsequent pages in a Workspace", async () => {
    const api = fakeTaskApi(
      (page) =>
        page === 0
          ? Array.from({ length: 100 }, (_, i) => task("old-" + i, 8))
          : [task("target", 7)],
      "workspace",
    );
    const result = await runCatalogOperation(
      "clickup_search_tasks_by_type",
      { task_type: 7 },
      grant("workspace"),
      api.fetcher as typeof fetch,
    );
    expect(result["tasks"]).toMatchObject([task("target")]);
    expect(api.pages).toEqual([0, 1]);
  });

  it("continues dense matching results within the same page without skips", async () => {
    const api = fakeTaskApi((page) => {
      if (page !== 0) throw new Error("Unexpected second page");
      return Array.from({ length: 18 }, (_, i) => task("match-" + i));
    });
    const first = await runCatalogOperation(
      "clickup_search_tasks_by_tag",
      { tag: "QC", max_results: 10 },
      grant(),
      api.fetcher as typeof fetch,
    );
    expect(first).toMatchObject({
      next_task_page: 0,
      next_task_offset: 10,
      incomplete: true,
    });
    const second = await runCatalogOperation(
      "clickup_search_tasks_by_tag",
      { tag: "QC", max_results: 10, task_page: 0, task_offset: 10 },
      grant(),
      api.fetcher as typeof fetch,
    );
    expect(second).toMatchObject({ next_task_page: null, incomplete: false });
    const ids = [...(first["tasks"] as Array<{ id: string }>), ...(second["tasks"] as Array<{ id: string }>)]
      .map((t) => t.id);
    expect(ids).toEqual(Array.from({ length: 18 }, (_, i) => "match-" + i));
  });

  it("rejects an entire later page containing an out-of-scope task", async () => {
    const api = fakeTaskApi((page) =>
      page === 0
        ? Array.from({ length: 100 }, (_, i) => task("old-" + i, 8, []))
        : [task("foreign", 7, ["QC"], "99999")],
    );
    await expect(
      runCatalogOperation(
        "clickup_search_tasks_by_tag",
        { tag: "QC" },
        grant(),
        api.fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(api.pages).toEqual([0, 1]);
  });

  it("returns explicit bounded continuations after ten full pages", async () => {
    const api = fakeTaskApi((page) =>
      page < 10
        ? Array.from({ length: 100 }, (_, i) => task("old-" + page + "-" + i, 8, []))
        : [task("match", 7, ["QC"])],
    );
    const first = await runCatalogOperation(
      "clickup_search_tasks_by_type",
      { task_type: 7 },
      grant(),
      api.fetcher as typeof fetch,
    );
    expect(first).toMatchObject({ incomplete: true, pages_scanned: 10, next_task_page: 10 });
    const second = await runCatalogOperation(
      "clickup_search_tasks_by_type",
      { task_type: 7, task_page: 10 },
      grant(),
      api.fetcher as typeof fetch,
    );
    expect((second["tasks"] as Array<{ id: string }>)[0]?.id).toBe("match");
  });

  it("returns real paired ClickUp comment cursors for older comments", async () => {
    const api = fakeCommentsApi([dates(0, 25), dates(1, 8)]);
    const first = await runCatalogOperation(
      "clickup_get_task_comments",
      { task_id: "task1", max_results: 10 },
      grant(),
      api.fetcher as typeof fetch,
    );
    expect(first).toMatchObject({
      incomplete: true,
      pages_scanned: 1,
      next_comment_start: Number(dates(0, 25)[9]?.date),
      next_comment_start_id: "comment-9",
    });
    const next = await runCatalogOperation(
      "clickup_get_task_comments",
      {
        task_id: "task1",
        max_results: 50,
        comment_start: first["next_comment_start"],
        comment_start_id: first["next_comment_start_id"],
      },
      grant(),
      api.fetcher as typeof fetch,
    );
    expect(next["incomplete"]).toBe(false);
    // The synthetic mock treats any date/id cursor as the same upstream older page;
    // verify that the exact pair is transmitted (not independently guessed).
    expect(api.cursors[1]).toEqual([
      String(first["next_comment_start"]),
      String(first["next_comment_start_id"]),
    ]);
  });

  it("aggregates two complete comment pages with a verified terminal state", async () => {
    const api = fakeCommentsApi([dates(0, 25), dates(1, 8)]);
    const result = await runCatalogOperation(
      "clickup_get_task_comments",
      { task_id: "task1", max_results: 40 },
      grant(),
      api.fetcher as typeof fetch,
    );
    expect(result).toMatchObject({
      incomplete: false,
      pages_scanned: 2,
      next_comment_start: null,
      next_comment_start_id: null,
    });
    expect(result["comments"]).toHaveLength(33);
    expect(api.cursors[1]).toEqual([dates(0, 25)[24]!.date, "comment-24"]);
  });

  it("finds an old parent in an authorized task before reading its replies", async () => {
    const api = fakeCommentsApi([dates(0, 25), dates(1, 8)]);
    const result = await runCatalogOperation(
      "clickup_get_threaded_replies",
      { task_id: "task1", comment_id: "comment-29" },
      grant(),
      api.fetcher as typeof fetch,
    );
    expect(result["comments"]).toHaveLength(1);
    expect(api.cursors).toHaveLength(2);
    expect(api.requests.at(-1)).toBe("/api/v2/comment/comment-29/reply");
  });

  it("rejects unpaired cursors before any comment API read", async () => {
    const api = fakeCommentsApi([dates(0, 1)]);
    await expect(
      runCatalogOperation(
        "clickup_get_task_comments",
        { task_id: "task1", comment_start_id: "comment-2" },
        grant(),
        api.fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_INVALID_ARGUMENT");
    expect(api.cursors).toEqual([]);
  });

  it("never fetches arbitrary threaded replies without a verified parent", async () => {
    const api = fakeCommentsApi([dates(0, 3)]);
    await expect(
      runCatalogOperation(
        "clickup_get_threaded_replies",
        { task_id: "task1", comment_id: "foreign" },
        grant(),
        api.fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(api.requests.every((path) => !path.startsWith("/api/v2/comment/"))).toBe(true);
  });

  it("keeps every pagination field on a dedicated named tool", () => {
    for (const name of ["clickup_search_tasks_by_type", "clickup_search_tasks_by_tag"]) {
      const tool = CLICKUP_MODEL_TOOL_CATALOG.find((x) => x.name === name);
      expect(tool?.inputSchema.properties).toHaveProperty("task_page");
      expect(tool?.inputSchema.properties).toHaveProperty("task_offset");
    }
    for (const name of ["clickup_get_task_comments", "clickup_get_threaded_replies"]) {
      const tool = CLICKUP_MODEL_TOOL_CATALOG.find((x) => x.name === name);
      expect(tool?.inputSchema.properties).toHaveProperty("comment_start");
      expect(tool?.inputSchema.properties).toHaveProperty("comment_start_id");
    }
  });
});
