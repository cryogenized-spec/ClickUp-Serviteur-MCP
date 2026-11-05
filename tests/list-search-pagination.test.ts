import { describe, expect, it, vi } from "vitest";
import { runCatalogOperation } from "../src/clickup/catalog-runtime.js";
import type { ReadGrant } from "../src/clickup/policy.js";

const grant = (): ReadGrant => ({
  subject: "github:11",
  clickupUserId: "707",
  workspaceId: "555",
  listId: "12345",
  resourceScope: "list",
  apiToken: "fake-test-token",
  quota: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
  },
});

const reply = (body: unknown) =>
  Response.json(body, { status: 200, headers: { "Content-Type": "application/json" } });

function listOnlyApi(taskPage: (page: number) => unknown) {
  const pages: number[] = [];
  const fetcher = vi.fn(async (request: RequestInfo | URL) => {
    const url = new URL(String(request));
    if (url.pathname === "/api/v2/list/12345") {
      return reply({ id: "12345", space: { id: "777" } });
    }
    if (url.pathname === "/api/v2/team/555/space") {
      return reply({ spaces: [{ id: "777" }] });
    }
    if (url.pathname === "/api/v2/list/12345/task") {
      const page = Number(url.searchParams.get("page"));
      pages.push(page);
      return reply({ tasks: taskPage(page) });
    }
    throw Error("Unexpected out-of-scope API route: " + url.pathname);
  });
  return { fetcher, pages };
}

describe("List-scoped task search pagination (#76)", () => {
  it("finds a matching task beyond the first 100 tasks without Workspace traversal", async () => {
    const api = listOnlyApi((page) => {
      if (page === 0) {
        return Array.from({ length: 100 }, (_, i) => ({
          id: "unrelated-" + i,
          name: "Unrelated",
          list: { id: "12345" },
        }));
      }
      if (page === 1) {
        return [{ id: "target-vusi", name: "VUSI repair", list: { id: "12345" } }];
      }
      throw Error("Unexpected extra page");
    });
    const result = await runCatalogOperation(
      "clickup_search_workspace",
      { query: "VUSI", max_results: 10 },
      grant(),
      api.fetcher as typeof fetch,
    );
    expect(result).toMatchObject({
      scope: "list",
      incomplete: false,
      pages_scanned: 2,
      next_task_page: null,
      docs: [],
      lists: [],
      folders: [],
    });
    expect(result["tasks"]).toHaveLength(1);
    expect(api.pages).toEqual([0, 1]);
  });

  it("returns a continuation cursor after ten List pages", async () => {
    const api = listOnlyApi((page) => {
      if (page < 10) {
        return Array.from({ length: 100 }, (_, i) => ({
          id: "unrelated-" + page + "-" + i,
          name: "Unrelated",
          list: { id: "12345" },
        }));
      }
      if (page === 10) {
        return [{ id: "target-late", name: "Late repair", list: { id: "12345" } }];
      }
      throw Error("Unexpected extra page");
    });
    const first = await runCatalogOperation(
      "clickup_search_workspace",
      { query: "Late repair" },
      grant(),
      api.fetcher as typeof fetch,
    );
    expect(first).toMatchObject({
      scope: "list",
      incomplete: true,
      pages_scanned: 10,
      next_task_page: 10,
    });
    expect(first["tasks"]).toEqual([]);
    const second = await runCatalogOperation(
      "clickup_search_workspace",
      { query: "Late repair", task_page: 10 },
      grant(),
      api.fetcher as typeof fetch,
    );
    expect(second).toMatchObject({
      scope: "list",
      incomplete: false,
      pages_scanned: 1,
      next_task_page: null,
    });
    expect(second["tasks"]).toHaveLength(1);
    expect(api.pages).toEqual(Array.from({ length: 11 }, (_, i) => i));
  });

  it("fails closed if a later List page contains a foreign-home task", async () => {
    const api = listOnlyApi((page) =>
      page === 0
        ? Array.from({ length: 100 }, (_, i) => ({
            id: "unrelated-" + i,
            name: "Unrelated",
            list: { id: "12345" },
          }))
        : [{ id: "foreign", name: "Foreign task", list: { id: "12346" } }],
    );
    await expect(
      runCatalogOperation(
        "clickup_search_workspace",
        { query: "Foreign task" },
        grant(),
        api.fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(api.pages).toEqual([0, 1]);
  });
});
