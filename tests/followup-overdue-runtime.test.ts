import { describe, expect, it, vi } from "vitest";
import { runCatalogOperation } from "../src/clickup/catalog-runtime.js";
import type { ReadGrant } from "../src/clickup/policy.js";

const due = 1795800000000;
const cutoff = due + 100;

function fixture(options: { stopAt?: string; allDenied?: boolean } = {}) {
  const privateCalls = vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname === "/followups/due") {
      expect(url.searchParams.get("cutoff_ms")).toBe(String(cutoff));
      const after = url.searchParams.get("after_task_id");
      return Response.json(after
        ? {
            candidates: [{ task_id: "taskE", state: "awaiting_response",
              waiting_on_user_id: null, next_check_at_ms: due + 1, revision: 1 }],
            incomplete: false,
            next_after_due_ms: null,
            next_after_task_id: null,
          }
        : {
            candidates: ["taskA", "taskB", "taskC", "taskD"].map((task_id) => ({
              task_id, state: "awaiting_response",
              waiting_on_user_id: "707", next_check_at_ms: due, revision: 1,
            })),
            incomplete: true,
            next_after_due_ms: due,
            next_after_task_id: "taskD",
          });
    }
    if (url.pathname === "/followups/task") {
      const taskId = url.searchParams.get("task_id");
      return Response.json({
        task_id: taskId,
        state: taskId === "taskC"
          ? { state: "resolved", revision: 2, next_check_at_ms: due }
          : { state: "awaiting_response", revision: 1, waiting_on_user_id: "707",
              next_check_at_ms: taskId === "taskE" ? due + 1 : due },
        history: [{
          action_kind: "instruction_sent",
          recorded_at_ms: due - 100,
          note: "Verified historical comment; awaiting buyer response",
        }],
      });
    }
    return new Response(null, { status: 404 });
  });

  const api = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method).toBe("GET");
    const path = new URL(String(input)).pathname;
    if (path.startsWith("/api/v2/task/")) {
      const id = path.split("/").at(-1)!;
      if (id === options.stopAt) return Response.json({}, { status: 429 });
      if (options.allDenied || id === "taskB")
        return Response.json({}, { status: 403 });
      return Response.json({
        id,
        name: "Case " + id,
        list: { id: id === "taskD" ? "54321" : "12345" },
        status: { status: "price request" },
        assignees: [{ id: 707 }],
        date_updated: String(due),
      });
    }
    if (path === "/api/v2/list/12345")
      return Response.json({ id: "12345", space: { id: "777" } });
    if (path === "/api/v2/team/555/space")
      return Response.json({ spaces: [{ id: "777" }] });
    throw Error("Unexpected upstream GET " + path);
  });

  const grant: ReadGrant = {
    subject: "github:11",
    clickupUserId: "707",
    workspaceId: "555",
    listId: "12345",
    resourceScope: "list",
    apiToken: "user-private-token",
    quota: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
    },
    taskIndex: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: privateCalls }),
    },
  };
  return { grant, api, privateCalls };
}

describe("authorized overdue follow-up catalogue", () => {
  it("hides revoked/out-of-scope tasks and superseded resolutions, with honest continuation", async () => {
    const { grant, api, privateCalls } = fixture();
    const result = await runCatalogOperation(
      "clickup_get_overdue_followups",
      { followup_due_before_ms: cutoff, max_results: 4 },
      grant,
      api as typeof fetch,
    );
    expect(result).toMatchObject({
      source: "serviteur-private-followup-ledger",
      due_before_ms: cutoff,
      candidates_scanned: 4,
      filtered_inaccessible_or_out_of_scope: 2,
      filtered_changed_since_read: 1,
      incomplete: true,
      next_after_due_ms: due,
      next_after_task_id: "taskD",
      followups: [{
        task_id: "taskA",
        title: "Case taskA",
        status: "price request",
        home_list_id: "12345",
        followup_state: "awaiting_response",
        waiting_on_user_id: "707",
        next_check_at_ms: due,
        last_action_kind: "instruction_sent",
      }],
    });
    expect(privateCalls.mock.calls.map(([request]) => new URL(request.url).pathname))
      .toEqual(["/followups/due", "/followups/task", "/followups/task"]);
    expect(api.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });

  it("resumes after the exact returned keyset cursor and the same cutoff", async () => {
    const { grant, api, privateCalls } = fixture();
    const result = await runCatalogOperation(
      "clickup_get_overdue_followups",
      { followup_due_before_ms: cutoff, max_results: 4,
        followup_after_due_ms: due, followup_after_task_id: "taskD" },
      grant,
      api as typeof fetch,
    );
    expect(result).toMatchObject({
      candidates_scanned: 1,
      incomplete: false,
      next_after_due_ms: null,
      next_after_task_id: null,
      followups: [{ task_id: "taskE", title: "Case taskE" }],
    });
    expect(new URL(privateCalls.mock.calls[0]![0].url).searchParams.get("after_task_id"))
      .toBe("taskD");
  });

  it("does not expose a private candidate when every task is no longer authorized", async () => {
    const { grant, api } = fixture({ allDenied: true });
    const result = await runCatalogOperation(
      "clickup_get_overdue_followups",
      { followup_due_before_ms: cutoff, max_results: 4 },
      grant,
      api as typeof fetch,
    );
    expect(result).toMatchObject({
      followups: [],
      candidates_scanned: 4,
      filtered_inaccessible_or_out_of_scope: 4,
      incomplete: true,
    });
    expect(JSON.stringify(result)).not.toContain("Case task");
  });

  it("stops on an actual rate limit rather than reporting an empty list", async () => {
    const { grant, api, privateCalls } = fixture({ stopAt: "taskB" });
    await expect(runCatalogOperation(
      "clickup_get_overdue_followups",
      { followup_due_before_ms: cutoff, max_results: 4 },
      grant,
      api as typeof fetch,
    )).rejects.toThrow("CLICKUP_RATE_LIMITED");
    expect(privateCalls).toHaveBeenCalledTimes(2);
  });

  it("requires both cursor fields and rejects an unauthorized List filter before reading private storage", async () => {
    const { grant, api, privateCalls } = fixture();
    await expect(runCatalogOperation(
      "clickup_get_overdue_followups",
      { followup_due_before_ms: cutoff, followup_after_due_ms: due },
      grant,
      api as typeof fetch,
    )).rejects.toThrow("CLICKUP_INVALID_ARGUMENT");
    await expect(runCatalogOperation(
      "clickup_get_overdue_followups",
      { followup_due_before_ms: cutoff, list_id: "54321" },
      grant,
      api as typeof fetch,
    )).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(privateCalls).not.toHaveBeenCalled();
  });
});
