import { describe, expect, it, vi } from "vitest";
import { requireReadGrant, ReadFailure, type ReadGrant } from "../src/clickup/policy.js";
import { findScopedTasks, getScopedTask } from "../src/clickup/client.js";
import { createAttentionReport } from "../src/reports/attention.js";

const env = {
  CLICKUP_LIVE_ENABLED: "true",
  CLICKUP_LIST_ID: "12345",
  CLICKUP_OAUTH_ENABLED: "true",
  CLICKUP_CLIENT_ID: "fixture-client",
  CLICKUP_CLIENT_SECRET: "fixture-secret",
  CLICKUP_STATE_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  CLICKUP_TOKEN_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  CLICKUP_WORKSPACE_ID: "555",
  CLICKUP_STAFF_USER_MAP: JSON.stringify({ "11": "456", "22": "654" }),
  MCP_PUBLIC_ORIGIN: "https://staging.example",
  CLICKUP_CONNECTIONS: {
    idFromName: (name: string) => name,
    get: (_id: unknown) => ({
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === "/credential")
          return Response.json({
            connected: true,
            clickupUserId: "456",
            workspaceId: "555",
            accessToken: "nonworking-personal-oauth-token-fixture",
            workspaceExclusive: true,
          });
        if (path === "/status")
          return Response.json({ connected: true, clickupUserId: "456", workspaceId: "555" });
        return Response.json({ accepted: true, disconnected: true });
      },
    }),
  },
  CLICKUP_READ_GITHUB_IDS: "11,22",
  ALLOWED_GITHUB_IDS: "11,22,33",
  CLICKUP_QUOTA: {
    idFromName: (_name: string) => "test-quota-id",
    get: (_id: unknown) => ({
      fetch: async (_req: Request) => Response.json({ allowed: true }),
    }),
  },
};

const auth = { scopes: ["mcp:read"], extra: { subject: "github:11" } };

function task(id: string, extras: Record<string, unknown> = {}) {
  return {
    id,
    name: "fixture " + id,
    status: { status: "to do" },
    list: { id: "12345" },
    date_updated: "1760000000000",
    due_date: null,
    assignees: [],
    url: "https://app.clickup.com/t/" + id,
    ...extras,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Phase 4 separate authorization policy", () => {
  it("accepts only approved verified subject and configured server List", async () => {
    const grant = await requireReadGrant(auth, env);
    expect(grant.subject).toBe("github:11");
    expect(grant.listId).toBe("12345");
  });

  it("requires explicit Workspace opt-in and verified exclusive OAuth consent", async () => {
    const full = await requireReadGrant(auth, { ...env, CLICKUP_RESOURCE_SCOPE: "workspace" });
    expect(full.resourceScope).toBe("workspace");
    await expect(
      requireReadGrant(auth, { ...env, CLICKUP_RESOURCE_SCOPE: "other" }),
    ).rejects.toThrowError("CLICKUP_NOT_CONFIGURED");
    const missingEvidence = {
      ...env,
      CLICKUP_RESOURCE_SCOPE: "workspace",
      CLICKUP_CONNECTIONS: {
        idFromName: () => "stub",
        get: () => ({
          fetch: async () =>
            Response.json({
              connected: true,
              clickupUserId: "456",
              workspaceId: "555",
              accessToken: "old-token-without-verification",
            }),
        }),
      },
    };
    await expect(requireReadGrant(auth, missingEvidence)).rejects.toThrowError(
      "CLICKUP_WORKSPACE_RECONSENT_REQUIRED",
    );
  });

  it.each([
    [{ scopes: ["mcp:read"], extra: { subject: "github:33" } }, "CLICKUP_ACCESS_DENIED"],
    [{ scopes: ["mcp:read"], extra: { subject: "github:1" } }, "CLICKUP_ACCESS_DENIED"],
    [{ scopes: ["mcp:write"], extra: { subject: "github:11" } }, "CLICKUP_ACCESS_DENIED"],
    [
      { scopes: ["mcp:read", "mcp:read"], extra: { subject: "github:11" } },
      "CLICKUP_ACCESS_DENIED",
    ],
    [{ scopes: ["mcp:read"], extra: { subject: "github:011" } }, "CLICKUP_ACCESS_DENIED"],
    [null, "CLICKUP_ACCESS_DENIED"],
  ])("denies forged, out-of-grant or unexpected scopes", async (identity, code) => {
    await expect(requireReadGrant(identity, env)).rejects.toThrowError(code);
  });

  it("fails closed if any separate configuration or the quota binding is absent", async () => {
    for (const field of ["CLICKUP_LIST_ID", "CLICKUP_QUOTA", "CLICKUP_READ_GITHUB_IDS"]) {
      const broken: Record<string, unknown> = { ...env };
      delete broken[field];
      await expect(requireReadGrant(auth, broken)).rejects.toThrowError("CLICKUP_NOT_CONFIGURED");
    }
    await expect(
      requireReadGrant(auth, { ...env, CLICKUP_CONNECTIONS: undefined }),
    ).rejects.toThrowError("CLICKUP_OAUTH_NOT_CONFIGURED");
    await expect(
      requireReadGrant(auth, { ...env, CLICKUP_LIVE_ENABLED: "false" }),
    ).rejects.toThrowError("CLICKUP_NOT_CONFIGURED");
    await expect(
      requireReadGrant(auth, { ...env, CLICKUP_READ_GITHUB_IDS: "11,99" }),
    ).rejects.toThrowError("CLICKUP_NOT_CONFIGURED");
  });
});

describe("Phase 4 ClickUp GET-only transport", () => {
  it("uses exact allowed host, GET, hardcoded List and no redirects", async () => {
    const grant = await requireReadGrant(auth, env);
    const outbound = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      json({ tasks: [task("abc123")] }),
    );
    const result = await findScopedTasks(grant, outbound as typeof fetch);
    expect(result.tasks.map((x) => x.id)).toEqual(["abc123"]);
    expect(result.source).toBe("clickup-api-v2");
    expect(result.incomplete).toBe(false);
    const [target, options] = outbound.mock.calls[0]!;
    expect(String(target)).toBe(
      "https://api.clickup.com/api/v2/list/12345/task?page=0&include_closed=false&subtasks=false&include_timl=false",
    );
    expect(options?.method).toBe("GET");
    expect(options?.redirect).toBe("manual");
  });

  it("rejects wrong-home-List data rather than leaking another List's content", async () => {
    const grant = await requireReadGrant(auth, env);
    const fetcher = vi.fn(async () =>
      json({ tasks: [task("private123", { list: { id: "999" } })] }),
    );
    await expect(findScopedTasks(grant, fetcher as typeof fetch)).rejects.toThrowError(
      "CLICKUP_SCOPE_OR_SCHEMA_REJECTED",
    );
  });

  it("rejects path injection with zero HTTP requests", async () => {
    const grant = await requireReadGrant(auth, env);
    const fetcher = vi.fn(async () => json(task("ok123")));
    await expect(getScopedTask(grant, "../private", fetcher as typeof fetch)).rejects.toThrowError(
      "CLICKUP_INVALID_ARGUMENT",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns bounded Markdown details and priority", async () => {
    const grant = await requireReadGrant(auth, env);
    const requests: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return json(
        task("gauntlet1", {
          description: "Plain fallback",
          markdown_description: "# Challenge\\nRead this entire task.",
          priority: { id: "2", priority: "high" },
        }),
      );
    });
    const detail = await getScopedTask(grant, "gauntlet1", fetcher as typeof fetch);
    expect(detail).toMatchObject({
      id: "gauntlet1",
      list_id: "12345",
      description: "# Challenge\\nRead this entire task.",
      description_format: "markdown",
      description_truncated: false,
      priority: 2,
    });
    expect(requests).toEqual([
      "https://api.clickup.com/api/v2/task/gauntlet1?custom_task_ids=false&include_markdown_description=true",
    ]);
  });

  it("truncates descriptions and rejects unsafe detail payloads", async () => {
    const grant = await requireReadGrant(auth, env);
    const description = "x".repeat(10000);
    const fetcher = vi.fn(async () => json(task("allowed1", { description, priority: null })));
    const detail = await getScopedTask(grant, "allowed1", fetcher as typeof fetch);
    expect(detail.description).toHaveLength(8000);
    expect(detail.description_truncated).toBe(true);
    expect(detail.description_format).toBe("plain");
    expect(detail.priority).toBeNull();
    const listing = await findScopedTasks(
      grant,
      vi.fn(async () => json({ tasks: [task("allowed1", { description })] })) as typeof fetch,
    );
    expect("description" in listing.tasks[0]!).toBe(false);
    for (const bad of [
      task("allowed1", { list: { id: "999" }, description: "out-of-scope" }),
      task("allowed1", { description: { unexpected: "content" } }),
      task("allowed1", { priority: { id: "99" } }),
    ]) {
      await expect(
        getScopedTask(grant, "allowed1", vi.fn(async () => json(bad)) as typeof fetch),
      ).rejects.toBeInstanceOf(ReadFailure);
    }
  });

  it("rejects task-ID substitution after a successful scoped GET", async () => {
    const grant = await requireReadGrant(auth, env);
    const fetcher = vi.fn(async () => json(task("different")));
    await expect(getScopedTask(grant, "wanted", fetcher as typeof fetch)).rejects.toThrowError(
      "CLICKUP_SCOPE_OR_SCHEMA_REJECTED",
    );
  });

  it("denies forged redirect, upstream 401 and malformed JSON", async () => {
    const grant = await requireReadGrant(auth, env);
    for (const response of [
      new Response(null, { status: 302, headers: { location: "https://evil.invalid" } }),
      json({ err: "unauthorized" }, 401),
      new Response("not json", { status: 200, headers: { "content-type": "text/plain" } }),
    ]) {
      const fetcher = vi.fn(async () => response);
      await expect(findScopedTasks(grant, fetcher as typeof fetch)).rejects.toBeInstanceOf(
        ReadFailure,
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it("tracks pagination and makes the 50-result ceiling explicitly incomplete", async () => {
    const grant = await requireReadGrant(auth, env);
    const fetcher = vi.fn(async () =>
      json({ tasks: Array.from({ length: 100 }, (_, i) => task("t" + i)) }),
    );
    const result = await findScopedTasks(grant, fetcher as typeof fetch, 50);
    expect(result.tasks).toHaveLength(50);
    expect(result.incomplete).toBe(true);
    expect(result.pages_scanned).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects quota unavailability before any ClickUp network request", async () => {
    const grant = await requireReadGrant(auth, env);
    const blocked: ReadGrant = {
      ...grant,
      quota: {
        idFromName: () => "id",
        get: () => ({ fetch: async () => new Response(null, { status: 503 }) }),
      },
    };
    const outbound = vi.fn(async () => json({ tasks: [] }));
    await expect(findScopedTasks(blocked, outbound as typeof fetch)).rejects.toThrowError(
      "CLICKUP_QUOTA_UNAVAILABLE",
    );
    expect(outbound).not.toHaveBeenCalled();
  });

  it("recognizes a real 429 and does not immediately retry", async () => {
    const grant = await requireReadGrant(auth, env);
    const outbound = vi.fn(async () => json({ err: "limit" }, 429));
    await expect(findScopedTasks(grant, outbound as typeof fetch)).rejects.toThrowError(
      "CLICKUP_RATE_LIMITED",
    );
    expect(outbound).toHaveBeenCalledTimes(1);
  });
});

describe("48h report is metadata evidence, not a staff-inactivity verdict", () => {
  it("separates overdue, due soon and stale at exact 48h edge using SAST", () => {
    const now = Date.parse("2026-10-11T10:00:00Z");
    const base = {
      id: "a",
      name: "A",
      status: "to do",
      list_id: "12345",
      due_date_ms: null,
      date_updated_ms: null,
      assignee_ids: [],
      url: null,
    };
    const tasks = [
      { ...base, id: "old", due_date_ms: now - 1, date_updated_ms: now - 48 * 3_600_000 },
      { ...base, id: "soon", due_date_ms: now + 24 * 3_600_000 },
      { ...base, id: "untracked" },
    ];
    const report = createAttentionReport(tasks, "12345", 1, false, 24, true, now);
    expect(report.overdue.map((x) => x.id)).toEqual(["old"]);
    expect(report.due_soon.map((x) => x.id)).toEqual(["soon"]);
    expect(report.not_updated_for_48h.map((x) => x.id)).toEqual(["old"]);
    expect(report.evaluated_at_sast).toBe("2026-10-11T12:00:00.000+02:00");
    expect(report.incomplete).toBe(false);
  });
});
