import { describe, expect, it, vi } from "vitest";
import { runCatalogOperation } from "../src/clickup/catalog-runtime.js";
import type { ReadGrant } from "../src/clickup/policy.js";

const grant = (company = true): ReadGrant => ({
  subject: "github:11",
  clickupUserId: "707",
  workspaceId: "555",
  listId: "12345",
  resourceScope: "list",
  ...(company ? { companyListTaskAccess: true } : {}),
  apiToken: "person-707",
  quota: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
  },
});

const reply = (data: unknown) =>
  Response.json(data, { status: 200, headers: { "Content-Type": "application/json" } });

describe("task comment editing is author- and List-bound", () => {
  it("changes only an authenticated user's comment and verifies the persisted text", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    let changed = false;
    const api = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = new URL(String(input)).pathname;
      calls.push({ method, path });
      if (path === "/api/v2/task/task1") return reply({ id: "task1", list: { id: "12345" } });
      if (path === "/api/v2/list/12345") return reply({ id: "12345", space: { id: "777" } });
      if (path === "/api/v2/team/555/space") return reply({ spaces: [{ id: "777" }] });
      if (path === "/api/v2/task/task1/comment")
        return reply({
          comments: [
            {
              id: "own22",
              user: { id: 707 },
              assignee: null,
              group_assignee: null,
              comment_text: changed
                ? "Please use the second tab."
                : "@MONISHA Please use the second tab.",
            },
          ],
        });
      if (path === "/api/v2/comment/own22" && method === "PUT") {
        expect((init?.headers as Record<string, string>)["Authorization"]).toBe("person-707");
        expect(JSON.parse(String(init?.body))).toEqual({
          comment_text: "Please use the second tab.",
          assignee: 0,
          resolved: false,
        });
        changed = true;
        return reply({});
      }
      throw Error("Unexpected API request " + method + " " + path);
    });
    const result = await runCatalogOperation(
      "clickup_edit_task_comment",
      { task_id: "task1", comment_id: "own22", text: "Please use the second tab." },
      grant(),
      api as typeof fetch,
    );
    expect(result).toMatchObject({
      success: true,
      task_id: "task1",
      comment_id: "own22",
      verified_by_readback: true,
    });
    expect(calls).toEqual([
      { method: "GET", path: "/api/v2/task/task1" },
      { method: "GET", path: "/api/v2/list/12345" },
      { method: "GET", path: "/api/v2/team/555/space" },
      { method: "GET", path: "/api/v2/task/task1/comment" },
      { method: "PUT", path: "/api/v2/comment/own22" },
      { method: "GET", path: "/api/v2/task/task1/comment" },
    ]);
  });

  it.each([
    { label: "someone else's", authorId: 708, comments: true },
    { label: "unseen", authorId: 707, comments: false },
  ])("refuses editing $label comment before a PUT", async ({ authorId, comments }) => {
    const api = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "GET") throw Error("Unauthorized write");
      const path = new URL(String(input)).pathname;
      if (path === "/api/v2/task/task1") return reply({ id: "task1", list: { id: "12345" } });
      if (path === "/api/v2/list/12345") return reply({ id: "12345", space: { id: "777" } });
      if (path === "/api/v2/team/555/space") return reply({ spaces: [{ id: "777" }] });
      if (path === "/api/v2/task/task1/comment")
        return reply({
          comments: comments ? [{ id: "other22", user: { id: authorId } }] : [],
        });
      throw Error("Unexpected API request");
    });
    await expect(
      runCatalogOperation(
        "clickup_edit_task_comment",
        { task_id: "task1", comment_id: "other22", text: "Replacement" },
        grant(),
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(api.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });

  it("retains known assignment and resolved state in the ClickUp PUT contract", async () => {
    let changed = false;
    const api = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = new URL(String(input)).pathname;
      if (path === "/api/v2/task/task1") return reply({ id: "task1", list: { id: "12345" } });
      if (path === "/api/v2/list/12345") return reply({ id: "12345", space: { id: "777" } });
      if (path === "/api/v2/team/555/space") return reply({ spaces: [{ id: "777" }] });
      if (path === "/api/v2/task/task1/comment")
        return reply({
          comments: [
            {
              id: "own22",
              user: { id: 707 },
              assignee: { id: 708 },
              resolved: true,
              comment_text: changed ? "Corrected" : "Original",
            },
          ],
        });
      if (path === "/api/v2/comment/own22" && method === "PUT") {
        expect(JSON.parse(String(init?.body))).toEqual({
          comment_text: "Corrected",
          assignee: 708,
          resolved: true,
        });
        changed = true;
        return reply({});
      }
      throw Error("Unexpected API request");
    });
    const result = await runCatalogOperation(
      "clickup_edit_task_comment",
      { task_id: "task1", comment_id: "own22", text: "Corrected" },
      grant(),
      api as typeof fetch,
    );
    expect(result["success"]).toBe(true);
  });

  it("fails closed if assignment or resolution cannot be preserved", async () => {
    const api = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "GET") throw Error("Unauthorized write");
      const path = new URL(String(input)).pathname;
      if (path === "/api/v2/task/task1") return reply({ id: "task1", list: { id: "12345" } });
      if (path === "/api/v2/list/12345") return reply({ id: "12345", space: { id: "777" } });
      if (path === "/api/v2/team/555/space") return reply({ spaces: [{ id: "777" }] });
      if (path === "/api/v2/task/task1/comment")
        return reply({ comments: [{ id: "own22", user: { id: 707 }, assignee: { id: 708 } }] });
      throw Error("Unexpected API request");
    });
    await expect(
      runCatalogOperation(
        "clickup_edit_task_comment",
        { task_id: "task1", comment_id: "own22", text: "Changed" },
        grant(),
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(api.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });

  it("refuses a different List and legacy List-only grants", async () => {
    const api = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "GET") throw Error("Unauthorized write");
      const path = new URL(String(input)).pathname;
      if (path === "/api/v2/task/task1") return reply({ id: "task1", list: { id: "other-list" } });
      throw Error("Out-of-scope list access attempted");
    });
    const a = { task_id: "task1", comment_id: "own22", text: "Replacement" };
    await expect(
      runCatalogOperation("clickup_edit_task_comment", a, grant(), api as typeof fetch),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    await expect(
      runCatalogOperation("clickup_edit_task_comment", a, grant(false), api as typeof fetch),
    ).rejects.toThrow("CLICKUP_WORKSPACE_SCOPE_REQUIRED");
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("reports an uncertain result if the PUT commits but verification GET fails", async () => {
    let readCount = 0;
    const api = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = new URL(String(input)).pathname;
      if (path === "/api/v2/task/task1") return reply({ id: "task1", list: { id: "12345" } });
      if (path === "/api/v2/list/12345") return reply({ id: "12345", space: { id: "777" } });
      if (path === "/api/v2/team/555/space") return reply({ spaces: [{ id: "777" }] });
      if (path === "/api/v2/task/task1/comment") {
        readCount++;
        if (readCount === 1)
          return reply({ comments: [{ id: "own22", user: { id: 707 }, assignee: null }] });
        throw Error("Simulated connection loss after committed update");
      }
      if (path === "/api/v2/comment/own22" && method === "PUT") return reply({});
      throw Error("Unexpected API request");
    });
    await expect(
      runCatalogOperation(
        "clickup_edit_task_comment",
        { task_id: "task1", comment_id: "own22", text: "Revised" },
        grant(),
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_WRITE_OUTCOME_UNKNOWN");
    expect(api.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
    expect(readCount).toBe(2);
  });

  it("rejects unverified post-write content instead of reporting success", async () => {
    const api = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = new URL(String(input)).pathname;
      if (path === "/api/v2/task/task1") return reply({ id: "task1", list: { id: "12345" } });
      if (path === "/api/v2/list/12345") return reply({ id: "12345", space: { id: "777" } });
      if (path === "/api/v2/team/555/space") return reply({ spaces: [{ id: "777" }] });
      if (path === "/api/v2/task/task1/comment")
        return reply({
          comments: [{ id: "own22", user: { id: 707 }, assignee: null, comment_text: "Old" }],
        });
      if (path === "/api/v2/comment/own22" && method === "PUT") return reply({});
      throw Error("Unexpected API request");
    });
    await expect(
      runCatalogOperation(
        "clickup_edit_task_comment",
        { task_id: "task1", comment_id: "own22", text: "New" },
        grant(),
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_WRITE_OUTCOME_UNKNOWN");
    expect(api.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
  });
});

describe("targeted rich comment patch", () => {
  const initial = [
    { text: "Heading", attributes: { bold: true } },
    { type: "tag", user: { id: 708 }, text: "@Colleague" },
    { text: "Unwanted sketch" },
    { text: "\n", attributes: { "code-block": { "code-block": "plain" } } },
    { text: "Supplier", attributes: { link: "https://example.com" } },
  ];
  const args = {
    task_id: "task1",
    comment_id: "own22",
    patch_start: 2,
    patch_delete_count: 2,
  };
  function fixture(author = 707) {
    let segments: unknown[] = structuredClone(initial);
    const api = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = new URL(String(input)).pathname;
      if (path === "/api/v2/task/task1") return reply({ id: "task1", list: { id: "12345" } });
      if (path === "/api/v2/list/12345") return reply({ id: "12345", space: { id: "777" } });
      if (path === "/api/v2/team/555/space") return reply({ spaces: [{ id: "777" }] });
      if (path === "/api/v2/task/task1/comment")
        return reply({
          comments: [
            {
              id: "own22",
              user: { id: author },
              assignee: { id: 708 },
              resolved: true,
              reply_count: 3,
              comment: segments,
            },
          ],
        });
      if (path === "/api/v2/comment/own22" && method === "PUT") {
        const expected = [
          { text: "Heading", attributes: { bold: true } },
          { type: "tag", user: { id: 708 } },
          { text: "Supplier", attributes: { link: "https://example.com" } },
        ];
        expect(JSON.parse(String(init?.body))).toEqual({
          comment: expected,
          assignee: 708,
          resolved: true,
        });
        segments = expected;
        return reply({});
      }
      throw Error("Unexpected API request " + method + " " + path);
    });
    return {
      api,
      mutate: () => {
        segments = [...segments, { text: "Concurrent edit" }];
      },
      run: (patch: Record<string, unknown> = {}) =>
        runCatalogOperation(
          "clickup_patch_task_comment",
          { ...args, ...patch },
          grant(),
          api as typeof fetch,
        ),
    };
  }

  it("previews without a write, then removes only the approved range in place", async () => {
    const f = fixture();
    const preview = await f.run();
    expect(preview).toMatchObject({ preview: true, write_performed: false });
    expect(f.api.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    const result = await f.run({
      confirm_patch: true,
      expected_patch_fingerprint: preview["fingerprint"],
    });
    expect(result).toMatchObject({
      success: true,
      comment_id: "own22",
      verified_by_readback: true,
    });
    expect(f.api.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
    expect(f.api.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });

  it("refuses a stale preview after concurrent changes", async () => {
    const f = fixture();
    const preview = await f.run();
    f.mutate();
    await expect(
      f.run({ confirm_patch: true, expected_patch_fingerprint: preview["fingerprint"] }),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(f.api.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });

  it("refuses an unapproved write and another author's comment", async () => {
    const f = fixture();
    await expect(f.run({ confirm_patch: true })).rejects.toThrow(
      "CLICKUP_SCOPE_OR_SCHEMA_REJECTED",
    );
    const other = fixture(709);
    await expect(other.run()).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(f.api.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    expect(other.api.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });

  it("refuses removing the entire comment or an out-of-range segment", async () => {
    const f = fixture();
    await expect(f.run({ patch_start: 0, patch_delete_count: 5 })).rejects.toThrow();
    await expect(f.run({ patch_start: 99 })).rejects.toThrow("CLICKUP_INVALID_ARGUMENT");
    expect(f.api.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });
});
