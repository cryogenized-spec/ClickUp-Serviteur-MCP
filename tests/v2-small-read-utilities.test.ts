import { describe, expect, it, vi } from "vitest";
import { runCatalogOperation, OPERATIONAL_CATALOG_NAMES } from "../src/clickup/catalog-runtime.js";
import type { ReadGrant } from "../src/clickup/policy.js";
import { CLICKUP_MODEL_TOOL_CATALOG } from "../src/mcp/tool-catalog.js";

const toolNames = [
  "clickup_get_list_custom_fields",
  "clickup_get_list_members",
  "clickup_get_task_members",
  "clickup_get_list_comments",
  "clickup_get_space_tags",
] as const;
const grant = (scope: "list" | "workspace" = "list"): ReadGrant => ({
  subject: "github:11",
  clickupUserId: "707",
  workspaceId: "555",
  listId: "12345",
  resourceScope: scope,
  apiToken: "synthetic-private-token",
  quota: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
  },
});
type Options = {
  foreignList?: boolean;
  foreignTask?: boolean;
  listFields?: unknown;
  listMembers?: unknown;
  taskMembers?: unknown;
  spaceTags?: unknown;
  listComments?: unknown[];
};
function fakeApi(options: Options = {}) {
  const calls: Array<{ path: string; method: string; query: URLSearchParams; token: string }> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const method = init?.method ?? "GET";
    const token = (init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? "";
    calls.push({ path: u.pathname, query: new URLSearchParams(u.search), method, token });
    if (u.hostname !== "api.clickup.com") throw Error("Unexpected host");
    const reply = (value: unknown) => Response.json(value);
    if (u.pathname === "/api/v2/team/555/space") return reply({ spaces: [{ id: "777" }] });
    if (u.pathname === "/api/v2/list/12345")
      return reply({ id: "12345", space: { id: options.foreignList ? "888" : "777" } });
    if (u.pathname === "/api/v2/list/99999") return reply({ id: "99999", space: { id: "888" } });
    if (u.pathname === "/api/v2/task/abc123")
      return reply({ id: "abc123", list: { id: options.foreignTask ? "99999" : "12345" } });
    if (u.pathname === "/api/v2/list/12345/field")
      return reply({
        fields: options.listFields ?? [
          {
            id: "field-one",
            name: "Repair type",
            type: "drop_down",
            type_config: { options: [{ id: "part", name: "Parts" }] },
          },
          { id: "field-two", name: "Cost", type: "currency" },
        ],
      });
    if (u.pathname === "/api/v2/list/12345/member")
      return reply({ members: options.listMembers ?? [{ id: 708, username: "Sample member" }] });
    if (u.pathname === "/api/v2/task/abc123/member")
      return reply({ members: options.taskMembers ?? [{ id: 707, username: "Task member" }] });
    if (u.pathname === "/api/v2/space/777/tag")
      return reply({ tags: options.spaceTags ?? [{ name: "supplier", tag_fg: "#000000" }] });
    if (u.pathname === "/api/v2/list/12345/comment") {
      if (options.listComments) return reply({ comments: options.listComments });
      if (u.searchParams.has("start")) {
        return reply({
          comments: Array.from({ length: 6 }, (_, i) => ({
            id: "older-" + i,
            date: String(1690000000000 - i),
            comment_text: "Older List comment",
          })),
        });
      }
      return reply({
        comments: Array.from({ length: 25 }, (_, i) => ({
          id: "first-" + i,
          date: String(1700000000000 - i),
          comment_text: "List-level note " + i,
        })),
      });
    }
    throw Error("Unexpected API call: " + method + " " + u.pathname);
  });
  return { fetcher, calls };
}
async function run(
  name: string,
  args: Record<string, unknown>,
  permissions: ReadGrant,
  api: ReturnType<typeof fakeApi>,
) {
  return runCatalogOperation(name, args, permissions, api.fetcher as typeof fetch);
}

describe("ClickUp v2 small discovery utilities (typed, scoped, read only)", () => {
  it("registers five explicit read tools and no generic API execution or credential input", () => {
    expect(OPERATIONAL_CATALOG_NAMES).toHaveLength(71);
    expect(new Set(OPERATIONAL_CATALOG_NAMES).size).toBe(71);
    for (const name of toolNames) {
      const specs = CLICKUP_MODEL_TOOL_CATALOG.filter((s) => s.name === name);
      expect(specs).toHaveLength(1);
      expect(specs[0]?.effect).toBe("read");
      expect(OPERATIONAL_CATALOG_NAMES).toContain(name);
      const fields = Object.keys(specs[0]!.inputSchema.properties);
      expect(fields).not.toContain("api_token");
      expect(fields).not.toContain("method");
      expect(fields).not.toContain("path");
      expect(fields).not.toContain("url");
    }
    expect(OPERATIONAL_CATALOG_NAMES).not.toContain("clickup_raw");
  });

  it("discovers List Custom Fields including task-type applicability and original dropdown choices", async () => {
    const api = fakeApi();
    const result = await run("clickup_get_list_custom_fields", { list_id: "12345" }, grant(), api);
    expect(result).toMatchObject({
      source: "clickup-api-v2",
      list_id: "12345",
      fields_in_response: 2,
      incomplete: false,
      include_applied_objects: true,
    });
    expect(result["fields"]).toEqual([
      {
        id: "field-one",
        name: "Repair type",
        type: "drop_down",
        type_config: { options: [{ id: "part", name: "Parts" }] },
      },
      { id: "field-two", name: "Cost", type: "currency" },
    ]);
    const metadata = api.calls.find((c) => c.path.endsWith("/field"))!;
    expect(metadata.query.get("include_applied_objects")).toBe("true");
    expect(
      api.calls.every((c) => c.method === "GET" && c.token === "synthetic-private-token"),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain("synthetic-private-token");
  });

  it("reports clipped field metadata instead of implying full coverage", async () => {
    const api = fakeApi();
    const result = await run(
      "clickup_get_list_custom_fields",
      { list_id: "12345", max_results: 1, include_applied_objects: false },
      grant(),
      api,
    );
    expect(result["fields"] as unknown[]).toHaveLength(1);
    expect(result["fields_in_response"]).toBe(2);
    expect(result["incomplete"]).toBe(true);
    expect(
      api.calls.find((c) => c.path.endsWith("/field"))?.query.get("include_applied_objects"),
    ).toBe("false");
  });

  it("reports explicit List members without claiming inherited access", async () => {
    const api = fakeApi();
    const result = await run("clickup_get_list_members", { list_id: "12345" }, grant(), api);
    expect(result).toMatchObject({
      members: [{ id: 708, username: "Sample member" }],
      explicit_access_only: true,
      inherited_permissions_not_included: true,
      incomplete: false,
    });
    expect(api.calls.map((x) => x.path)).toEqual([
      "/api/v2/list/12345",
      "/api/v2/team/555/space",
      "/api/v2/list/12345/member",
    ]);
  });

  it("reports explicit task members only after verified task and home List", async () => {
    const api = fakeApi();
    const result = await run("clickup_get_task_members", { task_id: "abc123" }, grant(), api);
    expect(result).toMatchObject({
      task_id: "abc123",
      members_in_response: 1,
      explicit_access_only: true,
      inherited_permissions_not_included: true,
    });
    expect(api.calls.map((x) => x.path)).toEqual([
      "/api/v2/task/abc123",
      "/api/v2/list/12345",
      "/api/v2/team/555/space",
      "/api/v2/task/abc123/member",
    ]);
  });

  it("rejects foreign task ancestry and never fetches member data from that task", async () => {
    const api = fakeApi({ foreignTask: true });
    await expect(
      run("clickup_get_task_members", { task_id: "abc123" }, grant(), api),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(api.calls.some((c) => c.path.endsWith("/member"))).toBe(false);
  });

  it("does not fetch List metadata when the caller lacks the List grant", async () => {
    const api = fakeApi();
    await expect(
      run("clickup_get_list_members", { list_id: "99999" }, grant(), api),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(api.calls).toHaveLength(0);
  });

  it("checks real Workspace ancestry before returning foreign-space List data", async () => {
    const api = fakeApi({ foreignList: true });
    await expect(
      run("clickup_get_list_custom_fields", { list_id: "12345" }, grant("workspace"), api),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(api.calls.some((c) => c.path.endsWith("/field"))).toBe(false);
  });

  it("retrieves List-level comments, preserving the precise first-page scope", async () => {
    const api = fakeApi();
    const result = await run(
      "clickup_get_list_comments",
      { list_id: "12345", max_results: 3 },
      grant(),
      api,
    );
    const comments = result["comments"] as Array<{ id: string }>;
    expect(comments.map((c) => c.id)).toEqual(["first-0", "first-1", "first-2"]);
    expect(result).toMatchObject({
      pages_scanned: 1,
      incomplete: true,
      next_comment_start: 1700000000000 - 2,
      next_comment_start_id: "first-2",
      continuation_unavailable: false,
    });
    expect(api.calls.some((x) => x.path.includes("/task/"))).toBe(false);
  });

  it("continues List comments using paired date and ID cursors without skipping the next page", async () => {
    const api = fakeApi();
    const result = await run(
      "clickup_get_list_comments",
      { list_id: "12345", max_results: 28 },
      grant(),
      api,
    );
    const comments = result["comments"] as Array<{ id: string }>;
    expect(comments).toHaveLength(28);
    expect(comments[0]?.id).toBe("first-0");
    expect(comments[27]?.id).toBe("older-2");
    expect(result).toMatchObject({
      pages_scanned: 2,
      incomplete: true,
      next_comment_start_id: "older-2",
      continuation_unavailable: false,
    });
    const commentCalls = api.calls.filter((c) => c.path === "/api/v2/list/12345/comment");
    expect(commentCalls).toHaveLength(2);
    expect(commentCalls[1]?.query.get("start_id")).toBe("first-24");
    expect(commentCalls[1]?.query.get("start")).toBe(String(1700000000000 - 24));
  });

  it("rejects an unpaired or malformed comment cursor before reading comment data", async () => {
    const api = fakeApi();
    await expect(
      run(
        "clickup_get_list_comments",
        { list_id: "12345", comment_start: 1700000000000 },
        grant(),
        api,
      ),
    ).rejects.toThrow("CLICKUP_INVALID_ARGUMENT");
    expect(api.calls.some((c) => c.path.endsWith("/comment"))).toBe(false);
  });

  it("rejects malformed comment pages instead of reporting an empty history", async () => {
    const api = fakeApi({ listComments: [{ comment_text: "no id" }] });
    await expect(
      run("clickup_get_list_comments", { list_id: "12345" }, grant(), api),
    ).rejects.toThrow("CLICKUP_BAD_RESPONSE");
  });

  it("lists known Space tags only with Workspace authority", async () => {
    const api = fakeApi();
    const result = await run(
      "clickup_get_space_tags",
      { space_id: "777" },
      grant("workspace"),
      api,
    );
    expect(result).toMatchObject({
      space_id: "777",
      tags: [{ name: "supplier", tag_fg: "#000000" }],
      incomplete: false,
    });
    expect(api.calls.map((x) => x.path)).toEqual([
      "/api/v2/team/555/space",
      "/api/v2/space/777/tag",
    ]);
  });

  it("rejects Space tag discovery for a List-only grant before upstream reads", async () => {
    const api = fakeApi();
    await expect(run("clickup_get_space_tags", { space_id: "777" }, grant(), api)).rejects.toThrow(
      "CLICKUP_WORKSPACE_SCOPE_REQUIRED",
    );
    expect(api.calls).toHaveLength(0);
  });

  it("rejects Space tag discovery in a Space outside the approved Workspace", async () => {
    const api = fakeApi();
    await expect(
      run("clickup_get_space_tags", { space_id: "888" }, grant("workspace"), api),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(api.calls.some((c) => c.path.includes("/tag"))).toBe(false);
  });

  it("clips large member responses with an accurate incomplete flag", async () => {
    const api = fakeApi({ listMembers: Array.from({ length: 25 }, (_, i) => ({ id: 700 + i })) });
    const result = await run(
      "clickup_get_list_members",
      { list_id: "12345", max_results: 4 },
      grant(),
      api,
    );
    expect((result["members"] as unknown[]).length).toBe(4);
    expect(result["members_in_response"]).toBe(25);
    expect(result["incomplete"]).toBe(true);
  });
});
