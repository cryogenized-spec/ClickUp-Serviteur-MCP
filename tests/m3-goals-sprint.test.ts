import { describe, expect, it, vi } from "vitest";
import { runCatalogOperation, OPERATIONAL_CATALOG_NAMES } from "../src/clickup/catalog-runtime.js";
import { CLICKUP_MODEL_TOOL_CATALOG } from "../src/mcp/tool-catalog.js";
import type { ReadGrant } from "../src/clickup/policy.js";

const grant = (resourceScope: "list" | "workspace" = "workspace"): ReadGrant => ({
  subject: "github:707",
  clickupUserId: "707",
  workspaceId: "555",
  listId: "12345",
  resourceScope,
  apiToken: "fake-private-user-token",
  quota: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
  },
});

type RequestRecord = { path: string; method: string; query: URLSearchParams; auth: string };
const fakeApi = (response: (path: string, query: URLSearchParams) => unknown) => {
  const requests: RequestRecord[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push({
      path: url.pathname,
      method,
      query: url.searchParams,
      auth: String((init?.headers as Record<string, string>)?.["Authorization"] ?? ""),
    });
    expect(url.hostname).toBe("api.clickup.com");
    expect(method).toBe("GET");
    return Response.json(response(url.pathname, url.searchParams));
  });
  return { requests, fetcher };
};

const scopedFixture = (path: string) => {
  if (path === "/api/v2/list/12345")
    return { id: "12345", name: "Sprint iteration", space: { id: "777" } };
  if (path === "/api/v2/team/555/space") return { spaces: [{ id: "777" }] };
  if (path === "/api/v2/list/99999")
    return { id: "99999", name: "Other", space: { id: "888" } };
  throw new Error("Unexpected upstream call " + path);
};

describe("M3 bounded, read-only Goals and Sprint/List task snapshots", () => {
  it("registers three read-only, individually named operational tools with closed schemas", () => {
    for (const name of [
      "clickup_get_workspace_goals",
      "clickup_get_goal_details",
      "clickup_get_sprint_task_snapshot",
    ]) {
      expect(OPERATIONAL_CATALOG_NAMES).toContain(name);
      const def = CLICKUP_MODEL_TOOL_CATALOG.find((entry) => entry.name === name);
      expect(def?.effect).toBe("read");
      expect(def?.inputSchema.additionalProperties).toBe(false);
    }
    expect(CLICKUP_MODEL_TOOL_CATALOG.find((d) => d.name === "clickup_get_goal_details")
      ?.inputSchema.required).toEqual(["goal_id"]);
    expect(CLICKUP_MODEL_TOOL_CATALOG.find((d) => d.name === "clickup_get_sprint_task_snapshot")
      ?.inputSchema.required).toEqual(["list_id"]);
  });

  it("lists verified Workspace Goals with a bounded local continuation and one GET", async () => {
    const api = fakeApi((path) => {
      expect(path).toBe("/api/v2/team/555/goal");
      return { goals: [
        { id: "goal-one", name: "Expansion", team_id: "555" },
        { id: "goal-two", name: "Retention", team_id: "555" },
        { id: "goal-three", name: "Delivery", team_id: "555" },
      ] };
    });
    const first = await runCatalogOperation(
      "clickup_get_workspace_goals",
      { include_completed: true, max_results: 1 },
      grant(),
      api.fetcher as typeof fetch,
    );
    expect(first).toMatchObject({
      source: "clickup-api-v2",
      workspace_id: "555",
      goals_in_response: 3,
      goals: [{ id: "goal-one" }],
      next_goal_offset: 1,
      incomplete: true,
    });
    const second = await runCatalogOperation(
      "clickup_get_workspace_goals",
      { include_completed: true, goal_offset: 1, max_results: 2 },
      grant(),
      api.fetcher as typeof fetch,
    );
    expect(second).toMatchObject({
      goals: [{ id: "goal-two" }, { id: "goal-three" }],
      next_goal_offset: null,
      incomplete: false,
    });
    expect(api.requests).toHaveLength(2);
    expect(api.requests.every((req) => req.auth === "fake-private-user-token")).toBe(true);
    expect(api.requests.every((req) => req.query.get("include_completed") === "true")).toBe(true);
  });

  it("represents a legitimate empty Goal collection without inventing a Goal", async () => {
    const api = fakeApi(() => ({ goals: [] }));
    const result = await runCatalogOperation("clickup_get_workspace_goals", {}, grant(), api.fetcher as typeof fetch);
    expect(result).toMatchObject({
      goals: [],
      goals_in_response: 0,
      incomplete: false,
      next_goal_offset: null,
    });
  });

  it("rejects malformed, duplicate, or foreign-Workspace Goals", async () => {
    const bad = [
      {},
      { goals: "not-array" },
      { goals: [{ name: "Missing ID" }] },
      { goals: [{ id: "one" }, { id: "one" }] },
      { goals: [{ id: "one", team_id: "999" }] },
    ];
    for (const body of bad) {
      const api = fakeApi(() => body);
      await expect(
        runCatalogOperation("clickup_get_workspace_goals", {}, grant(), api.fetcher as typeof fetch),
      ).rejects.toThrow();
      expect(api.requests).toHaveLength(1);
    }
  });

  it("independently anchors an exact Goal detail ID to this Workspace before reading Targets", async () => {
    const api = fakeApi((path, query) => {
      if (path === "/api/v2/team/555/goal") {
        expect(query.get("include_completed")).toBe("true");
        return { goals: [{ id: "goal-one" }, { id: "goal-two" }] };
      }
      if (path === "/api/v2/goal/goal-one") return {
        goal: {
          id: "goal-one",
          team_id: "555",
          name: "Improve QC",
          key_results: [
            { id: "key-1", name: "Defects", steps_current: 3 },
            { id: "key-2", name: "Timeliness", steps_current: 7 },
            { id: "key-3", name: "Retention", steps_current: 8 },
          ],
        },
      };
      throw new Error("Unexpected Goal details path " + path);
    });
    const result = await runCatalogOperation(
      "clickup_get_goal_details",
      { goal_id: "goal-one", max_results: 2 },
      grant(),
      api.fetcher as typeof fetch,
    );
    expect(result).toMatchObject({
      source: "clickup-api-v2",
      goal_id: "goal-one",
      targets_in_response: 3,
      incomplete: true,
      goal: { id: "goal-one", key_results: [{ id: "key-1" }, { id: "key-2" }] },
    });
    expect(api.requests.map((req) => req.path)).toEqual([
      "/api/v2/team/555/goal",
      "/api/v2/goal/goal-one",
    ]);
  });

  it("never reads details of a Goal absent from the authenticated Workspace list", async () => {
    const api = fakeApi(() => ({ goals: [{ id: "our-goal" }] }));
    await expect(
      runCatalogOperation("clickup_get_goal_details", { goal_id: "foreign-goal" }, grant(), api.fetcher as typeof fetch),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(api.requests.map((req) => req.path)).toEqual(["/api/v2/team/555/goal"]);
  });

  it("rejects a replaced Goal, foreign Workspace detail, or malformed Target list", async () => {
    for (const goal of [
      { id: "other-goal", team_id: "555" },
      { id: "our-goal", team_id: "999" },
      { id: "our-goal", key_results: "invalid" },
    ]) {
      const api = fakeApi((path) =>
        path === "/api/v2/team/555/goal"
          ? { goals: [{ id: "our-goal" }] }
          : { goal },
      );
      await expect(
        runCatalogOperation("clickup_get_goal_details", { goal_id: "our-goal" }, grant(), api.fetcher as typeof fetch),
      ).rejects.toThrow();
      expect(api.requests).toHaveLength(2);
    }
  });

  it("requires Workspace scope for Goals without issuing any upstream request", async () => {
    const api = fakeApi(() => { throw Error("Must not be called"); });
    for (const [name, args] of [
      ["clickup_get_workspace_goals", {}],
      ["clickup_get_goal_details", { goal_id: "goal-one" }],
    ] as const) {
      await expect(runCatalogOperation(name, args, grant("list"), api.fetcher as typeof fetch))
        .rejects.toThrow("CLICKUP_WORKSPACE_SCOPE_REQUIRED");
    }
    expect(api.requests).toHaveLength(0);
  });

  it("reads a verified Sprint/List page without claiming official Sprint velocity", async () => {
    const api = fakeApi((path, query) => {
      if (path === "/api/v2/list/12345/task") {
        expect(query.get("page")).toBe("0");
        expect(query.get("include_closed")).toBe("true");
        expect(query.get("subtasks")).toBe("true");
        expect(query.get("include_timl")).toBe("false");
        return {
          tasks: [
            { id: "t1", name: "First", list: { id: "12345" }, status: { status: "done", type: "closed" }, points: 5 },
            { id: "t2", name: "Second", list: { id: "12345" }, status: { status: "open", type: "open" }, points: 3 },
            { id: "t3", name: "Third", list: { id: "12345" }, status: { status: "review", type: "custom" } },
          ],
        };
      }
      return scopedFixture(path);
    });
    const result = await runCatalogOperation(
      "clickup_get_sprint_task_snapshot",
      { list_id: "12345", max_results: 2 },
      grant("list"),
      api.fetcher as typeof fetch,
    );
    expect(result).toMatchObject({
      source: "clickup-api-v2",
      list_id: "12345",
      official_sprint_report: false,
      home_list_tasks_only: true,
      tasks: [{ id: "t1", points: 5 }, { id: "t2", points: 3 }],
      sampled_tasks: 2,
      completed_in_sample: 1,
      points_in_sample: 8,
      incomplete: true,
      next_task_page: 0,
      next_task_offset: 2,
    });
    expect(api.requests.map((r) => r.method)).toEqual(["GET", "GET", "GET"]);
    expect(api.requests.at(-1)?.path).toBe("/api/v2/list/12345/task");
  });

  it("rejects foreign home-List rows instead of leaking cross-List task metadata", async () => {
    const api = fakeApi((path) =>
      path === "/api/v2/list/12345/task"
        ? { tasks: [{ id: "out-of-scope", list: { id: "99999" }, name: "Secret" }] }
        : scopedFixture(path),
    );
    await expect(runCatalogOperation(
      "clickup_get_sprint_task_snapshot",
      { list_id: "12345" },
      grant("list"),
      api.fetcher as typeof fetch,
    )).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  });

  it("rejects malformed Sprint task envelopes and empty task identifiers", async () => {
    for (const body of [{ tasks: {} }, { tasks: [{ name: "No ID" }] }, { tasks: [{ id: "x" }, { id: "x" }] }]) {
      const api = fakeApi((path) => path === "/api/v2/list/12345/task" ? body : scopedFixture(path));
      await expect(runCatalogOperation(
        "clickup_get_sprint_task_snapshot", { list_id: "12345" }, grant(),
        api.fetcher as typeof fetch,
      )).rejects.toThrow();
    }
  });

  it("handles a bounded 100-task API page and signals continuation without full-Sprint totals", async () => {
    const api = fakeApi((path) =>
      path === "/api/v2/list/12345/task"
        ? { tasks: Array.from({ length: 100 }, (_, i) => ({ id: "t" + i, list: { id: "12345" }, points: 1 })) }
        : scopedFixture(path),
    );
    const result = await runCatalogOperation(
      "clickup_get_sprint_task_snapshot",
      { list_id: "12345", max_results: 50, task_offset: 50 },
      grant(),
      api.fetcher as typeof fetch,
    );
    expect(result).toMatchObject({
      sampled_tasks: 50,
      points_in_sample: 50,
      incomplete: true,
      next_task_page: 1,
      next_task_offset: 0,
      official_sprint_report: false,
    });
    expect((result["tasks"] as unknown[])).toHaveLength(50);
  });

  it("rejects invalid offsets and page numbers before issuing any Sprint task request", async () => {
    const api = fakeApi(() => { throw Error("Should not make an API request"); });
    for (const args of [{ list_id: "12345", task_offset: -1 }, { list_id: "12345", task_page: -3 }]) {
      await expect(runCatalogOperation("clickup_get_sprint_task_snapshot", args, grant(), api.fetcher as typeof fetch))
        .rejects.toThrow("CLICKUP_INVALID_ARGUMENT");
    }
    expect(api.requests).toHaveLength(0);
  });
});
