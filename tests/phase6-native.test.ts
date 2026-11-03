import { describe, expect, it, vi } from "vitest";
import { createScopedTask, getScopedList, verifyListWorkspace } from "../src/clickup/operations.js";
import { requireWriteGrant, type ReadGrant } from "../src/clickup/policy.js";

const authToken = "individual-synthetic-OAuth-token";
function fixtureQuota() {
  const calls: Array<{ path: string; payload: Record<string, unknown> }> = [];
  const quota = {
    idFromName: (key: string) => key,
    get: () => ({
      fetch: async (req: Request) => {
        calls.push({
          path: new URL(req.url).pathname,
          payload: (await req.json()) as Record<string, unknown>,
        });
        return Response.json({ allowed: true });
      },
    }),
  };
  return { quota, calls };
}
const grant: ReadGrant = {
  subject: "github:11",
  clickupUserId: "707",
  listId: "12345",
  workspaceId: "555",
  apiToken: authToken,
  quota: fixtureQuota().quota,
};
function json(value: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
describe("native ClickUp endpoints: no duplicate journal or server approval settings", () => {
  it("rejects missing MCP write scope, even with a connected ClickUp OAuth credential", async () => {
    await expect(
      requireWriteGrant({ scopes: ["mcp:read"], extra: { subject: "github:11" } }, {}),
    ).rejects.toThrow("CLICKUP_WRITE_SCOPE_REQUIRED");
  });

  it("creates a task directly within the configured List with the user's ClickUp credential", async () => {
    const outbound = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.clickup.com/api/v2/list/12345/task");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({ Authorization: authToken });
      expect(init?.redirect).toBe("manual");
      expect(JSON.parse(String(init?.body))).toEqual({
        name: "Order packing",
        description: "Pack paid order",
        status: "to do",
        priority: 3,
        check_required_custom_fields: true,
        notify_all: false,
      });
      return json({ id: "abc123", list: { id: "12345" } });
    });
    const result = await createScopedTask(
      grant,
      {
        name: "Order packing",
        description: "Pack paid order",
        status: "to do",
        priority: 3,
      },
      outbound as typeof fetch,
    );
    expect(result).toMatchObject({ action: "task_created", task_id: "abc123", accepted: true });
    expect(outbound).toHaveBeenCalledTimes(1);
  });

  it("preserves explicit due time in native List-bound task creates", async () => {
    const due = Date.parse("2026-10-28T07:30:00.000Z"); // 09:30 SAST
    const outbound = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.clickup.com/api/v2/list/12345/task");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        name: "Time-sensitive",
        due_date: due,
        due_date_time: true,
      });
      return json({ id: "abc123", list: { id: "12345" } });
    });
    await createScopedTask(
      grant,
      { name: "Time-sensitive", due_date_ms: due },
      outbound as typeof fetch,
    );
    expect(outbound).toHaveBeenCalledTimes(1);
  });

  it("binds the configured List to an actual Space in the approved Workspace", async () => {
    const outbound = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      expect(init?.headers).toMatchObject({ Authorization: authToken });
      if (String(url).endsWith("/list/12345")) return json({ id: "12345", space: { id: 765 } });
      if (String(url).endsWith("/team/555/space?archived=false"))
        return json({ spaces: [{ id: "765" }, { id: 999 }] });
      throw new Error("unexpected endpoint");
    });
    await expect(verifyListWorkspace(grant, outbound as typeof fetch)).resolves.toBeUndefined();
    expect(outbound).toHaveBeenCalledTimes(2);
  });

  it("accepts a directly shared List only from the matching Workspace shared hierarchy", async () => {
    const outbound = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      expect(init?.headers).toMatchObject({ Authorization: authToken });
      if (String(url).endsWith("/list/12345")) return json({ id: "12345", space: { id: "765" } });
      if (String(url).endsWith("/team/555/space?archived=false")) return json({ spaces: [] });
      if (String(url).endsWith("/team/555/shared"))
        return json({
          shared: { lists: [{ id: "12345", name: "Shared list" }], folders: [], tasks: [] },
        });
      throw new Error("unexpected endpoint");
    });
    await expect(verifyListWorkspace(grant, outbound as typeof fetch)).resolves.toBeUndefined();
    expect(outbound).toHaveBeenCalledTimes(3);
    expect(outbound.mock.calls[2]?.[0].toString()).toContain("/team/555/shared");
  });

  it("rejects unrelated shared Lists and malformed shared hierarchy", async () => {
    for (const shared of [
      { lists: [{ id: "77777" }] },
      { tasks: [{ id: "12345" }], lists: [] },
      { lists: "12345" },
      null,
    ]) {
      const outbound = vi.fn(async (url: RequestInfo | URL) => {
        if (String(url).endsWith("/list/12345")) return json({ id: "12345", space: { id: "765" } });
        if (String(url).includes("/team/555/space")) return json({ spaces: [] });
        if (String(url).endsWith("/team/555/shared")) return json({ shared });
        throw new Error("wrong endpoint");
      });
      await expect(verifyListWorkspace(grant, outbound as typeof fetch)).rejects.toThrow(
        "CLICKUP_SCOPE_OR_SCHEMA_REJECTED",
      );
      expect(outbound).toHaveBeenCalledTimes(3);
    }
  });

  it("denies company mutations before OAuth access despite mcp write scope", async () => {
    await expect(
      requireWriteGrant(
        { scopes: ["mcp:read", "mcp:write"], extra: { subject: "github:11" } },
        { CLICKUP_COMPANY_READ_ONLY: "true" },
      ),
    ).rejects.toThrow("CLICKUP_COMPANY_WRITE_DISABLED");
  });

  it("allows company read/write scope only for explicitly named non-destructive mutations", async () => {
    const auth = { scopes: ["mcp:read", "mcp:write"], extra: { subject: "github:11" } };
    const company = {
      CLICKUP_COMPANY_PROFILE: "true",
      CLICKUP_COMPANY_WRITE_MODE: "non_destructive",
    };
    for (const operation of [
      "clickup_delete_task",
      "clickup_remove_tag_from_task",
      "clickup_remove_task_link",
      "clickup_remove_dependency",
      "clickup_move_task_to_list",
      "clickup_update_document_page",
      "clickup_set_workspace_access",
      "unknown_new_write",
    ]) {
      await expect(requireWriteGrant(auth, company, operation)).rejects.toThrow(
        "CLICKUP_COMPANY_OPERATION_DISABLED",
      );
    }
    await expect(requireWriteGrant(auth, company)).rejects.toThrow(
      "CLICKUP_COMPANY_OPERATION_DISABLED",
    );
    // The authorization gate accepts safe tasks and then fails only because this
    // fixture deliberately has no live OAuth/storage bindings.
    await expect(requireWriteGrant(auth, company, "create_scoped_task")).rejects.toThrow(
      "CLICKUP_NOT_CONFIGURED",
    );
    await expect(requireWriteGrant(auth, company, "clickup_update_task")).rejects.toThrow(
      "CLICKUP_NOT_CONFIGURED",
    );
    await expect(
      requireWriteGrant(
        { scopes: ["mcp:read"], extra: { subject: "github:11" } },
        company,
        "clickup_create_task",
      ),
    ).rejects.toThrow("CLICKUP_WRITE_SCOPE_REQUIRED");
    await expect(
      requireWriteGrant(
        auth,
        { ...company, CLICKUP_COMPANY_WRITE_MODE: "unrestricted" },
        "clickup_create_task",
      ),
    ).rejects.toThrow("CLICKUP_COMPANY_WRITE_DISABLED");
    await expect(
      requireWriteGrant(
        auth,
        { ...company, CLICKUP_COMPANY_WRITE_MODE: "" },
        "clickup_create_task",
      ),
    ).rejects.toThrow("CLICKUP_COMPANY_WRITE_DISABLED");
    await expect(
      requireWriteGrant(
        auth,
        { ...company, CLICKUP_COMPANY_READ_ONLY: "true" },
        "clickup_create_task",
      ),
    ).rejects.toThrow("CLICKUP_COMPANY_WRITE_DISABLED");
  });

  it("fails closed on foreign Workspace, absent space, mismatched List or malformed response", async () => {
    for (const payload of [
      { id: "12345", space: { id: 765 } },
      { id: "99999", space: { id: 765 } },
      { id: "12345", space: {} },
    ]) {
      const upstream = vi.fn(async (url: RequestInfo | URL) =>
        String(url).includes("/team/555/space") ? json({ spaces: [] }) : json(payload),
      );
      await expect(verifyListWorkspace(grant, upstream as typeof fetch)).rejects.toThrow(
        "CLICKUP_SCOPE_OR_SCHEMA_REJECTED",
      );
      expect(upstream.mock.calls.length).toBeLessThanOrEqual(3);
    }
    const wrongWorkspace = vi.fn(async (url: RequestInfo | URL) =>
      String(url).includes("/team/555/space")
        ? json({ spaces: [{ id: 876 }] })
        : json({ id: "12345", space: { id: 765 } }),
    );
    await expect(verifyListWorkspace(grant, wrongWorkspace as typeof fetch)).rejects.toThrow(
      "CLICKUP_SCOPE_OR_SCHEMA_REJECTED",
    );
  });

  it("rejects malicious create input before outbound HTTP", async () => {
    const upstream = vi.fn(async () => json({ id: "abc123" }));
    for (const bad of [
      { name: "" },
      { name: "x".repeat(181) },
      { name: "Test", priority: 8 },
      { name: "Test", due_date_ms: -1 },
      { name: "Test", list_id: "99999" },
    ]) {
      await expect(createScopedTask(grant, bad, upstream as typeof fetch)).rejects.toThrow(
        "CLICKUP_INVALID_ARGUMENT",
      );
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("returns only configured List metadata, not unrelated fields", async () => {
    const outbound = vi.fn(async () =>
      json({
        id: "12345",
        name: "Workshop",
        statuses: [{ status: "to do" }, { status: "in progress" }],
        secret_unrelated_field: "must not leak",
      }),
    );
    expect(await getScopedList(grant, outbound as typeof fetch)).toEqual({
      source: "clickup-api-v2",
      list_id: "12345",
      name: "Workshop",
      statuses: ["to do", "in progress"],
    });
  });

  it("honors upstream 429 and propagates valid future reset to the same token quota", async () => {
    const tracked = fixtureQuota();
    const target: ReadGrant = { ...grant, quota: tracked.quota };
    const until = Math.floor(Date.now() / 1000) + 30;
    const outbound = vi.fn(async () =>
      json({ error: "rate limited" }, 429, {
        "X-RateLimit-Reset": String(until),
      }),
    );
    await expect(
      createScopedTask(target, { name: "test" }, outbound as typeof fetch),
    ).rejects.toThrow("CLICKUP_RATE_LIMITED");
    expect(outbound).toHaveBeenCalledTimes(1);
    expect(tracked.calls.map((c) => c.path)).toEqual(["/reserve", "/cooldown"]);
    expect(tracked.calls[1]?.payload).toMatchObject({ subject: "github:11", until: until * 1000 });
  });

  it("never sends ClickUp write without quota reservation", async () => {
    const blocked: ReadGrant = {
      ...grant,
      quota: {
        idFromName: () => "quota",
        get: () => ({ fetch: async () => new Response(null, { status: 503 }) }),
      },
    };
    const outbound = vi.fn(async () => json({ id: "abc123" }));
    await expect(
      createScopedTask(blocked, { name: "test" }, outbound as typeof fetch),
    ).rejects.toThrow("CLICKUP_QUOTA_UNAVAILABLE");
    expect(outbound).not.toHaveBeenCalled();
  });

  it("never auto-retries a potentially committed write", async () => {
    const serverError = vi.fn(async () => json({ error: "upstream fault" }, 503));
    await expect(
      createScopedTask(grant, { name: "test" }, serverError as typeof fetch),
    ).rejects.toThrow("CLICKUP_WRITE_OUTCOME_UNKNOWN");
    expect(serverError).toHaveBeenCalledTimes(1);
    const timeout = vi.fn(async () => {
      throw Error("time out");
    });
    await expect(
      createScopedTask(grant, { name: "test" }, timeout as typeof fetch),
    ).rejects.toThrow("CLICKUP_WRITE_OUTCOME_UNKNOWN");
    expect(timeout).toHaveBeenCalledTimes(1);
  });
});
