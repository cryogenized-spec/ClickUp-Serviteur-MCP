import { describe, expect, it, vi } from "vitest";
import { ReadFailure, type ReadGrant } from "../src/clickup/policy.js";
import {
  grantForSignedWebhook,
  retryDelayMs,
  synchronizeDirtyTask,
} from "../src/clickup/task-index-sync.js";
import type { TaskIndexStore } from "../src/clickup/task-index.js";
import type { OAuthEnv } from "../src/auth/env.js";
import type {
  readVerifiedTaskForIndex,
  runCatalogOperation,
} from "../src/clickup/catalog-runtime.js";

const grant: ReadGrant = {
  subject: "github:11",
  clickupUserId: "456",
  workspaceId: "555",
  listId: "12345",
  resourceScope: "list",
  apiToken: "fixture-only",
  quota: {
    idFromName: (value: string) => value,
    get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
  },
};

function fixture() {
  const store = {
    storeTask: vi.fn(() => true),
    storeComments: vi.fn(),
    discardSnapshots: vi.fn(),
  } as unknown as TaskIndexStore;
  const readTask = vi.fn(async () => ({
    id: "task1",
    name: "Fresh task",
    list: { id: "12345" },
    status: { status: "open" },
    date_updated: "100",
  })) as unknown as typeof readVerifiedTaskForIndex;
  const call = vi.fn(async (name: string): Promise<Record<string, unknown>> => {
    if (name === "clickup_get_task_comments")
      return {
        comments: [{ id: "c1", date: "110", comment_text: "Updated comment" }],
        incomplete: false,
      };
    throw new Error("Unexpected operation " + name);
  });
  const syncCall = call as unknown as typeof runCatalogOperation;
  const index = store as unknown as {
    storeTask: ReturnType<typeof vi.fn>;
    storeComments: ReturnType<typeof vi.fn>;
    discardSnapshots: ReturnType<typeof vi.fn>;
  };
  return { store, index, syncCall, call, readTask };
}

describe("signed-event automatic synchronization", () => {
  it("rejects a mismatched Workspace before any OAuth credential is requested", async () => {
    const env = { CLICKUP_WORKSPACE_ID: "555" } as OAuthEnv;
    await expect(
      grantForSignedWebhook({ workspaceId: "444", subject: "github:11" }, env),
    ).rejects.toThrowError("CLICKUP_ACCESS_DENIED");
    await expect(
      grantForSignedWebhook({ workspaceId: "555", subject: "github:not-a-user" }, env),
    ).rejects.toThrowError("CLICKUP_ACCESS_DENIED");
  });

  it("refreshes only the dirty sections through authorized task and comment reads", async () => {
    const { store, index, syncCall, call, readTask } = fixture();
    const result = await synchronizeDirtyTask(
      { task_id: "task1", task_dirty: true, comments_dirty: true, attempts: 0 },
      grant,
      store,
      fetch,
      syncCall,
      () => 200,
      readTask,
    );
    expect(result).toEqual({ complete: true, indexed_comments: 1 });
    expect(call.mock.calls.map((args) => args[0])).toEqual(["clickup_get_task_comments"]);
    expect(index.storeTask).toHaveBeenCalledTimes(1);
    expect(vi.mocked(readTask)).toHaveBeenCalledTimes(1);
    expect(index.storeComments).toHaveBeenCalledWith(
      "task1",
      [expect.objectContaining({ comment_id: "c1", text: "Updated comment" })],
      200,
      true,
    );
  });

  it("marks clipped older histories partial instead of claiming that comments are fresh", async () => {
    const { store, index, syncCall, call } = fixture();
    call.mockImplementation(async (name: string) =>
      name === "clickup_get_task_comments"
        ? { comments: [{ id: "c1", comment_text: "Partial" }], incomplete: true }
        : { id: "task1" },
    );
    const result = await synchronizeDirtyTask(
      { task_id: "task1", task_dirty: false, comments_dirty: true, attempts: 0 },
      grant,
      store,
      fetch,
      syncCall,
      () => 201,
    );
    expect(result.complete).toBe(false);
    expect(index.storeTask).not.toHaveBeenCalled();
    expect(index.storeComments).toHaveBeenCalledWith("task1", expect.any(Array), 201, false);
  });

  it("discards old snapshots if a verified task read fails current scope checks", async () => {
    const { store, index, syncCall } = fixture();
    const denied = vi.fn(async () => {
      throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    }) as unknown as typeof readVerifiedTaskForIndex;
    await expect(
      synchronizeDirtyTask(
        { task_id: "task1", task_dirty: true, comments_dirty: false, attempts: 0 },
        grant,
        store,
        fetch,
        syncCall,
        () => 202,
        denied,
      ),
    ).rejects.toThrowError("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(index.discardSnapshots).toHaveBeenCalledWith("task1");
  });

  it("treats an upstream 403 as definitive permission loss and discards stale snapshots", async () => {
    const { store, index, syncCall } = fixture();
    const provider = vi.fn(
      async () =>
        new Response("denied", { status: 403, headers: { "content-type": "text/plain" } }),
    ) as unknown as typeof fetch;
    await expect(
      synchronizeDirtyTask(
        { task_id: "task1", task_dirty: true, comments_dirty: false, attempts: 0 },
        grant,
        store,
        provider,
        syncCall,
        () => 203,
      ),
    ).rejects.toThrowError("CLICKUP_UPSTREAM_DENIED");
    expect(index.discardSnapshots).toHaveBeenCalledWith("task1");
  });

  it("does not report a discarded older task revision as synchronized", async () => {
    const { store, index, syncCall, readTask } = fixture();
    index.storeTask.mockReturnValue(false);
    const result = await synchronizeDirtyTask(
      { task_id: "task1", task_dirty: true, comments_dirty: true, attempts: 1 },
      grant,
      store,
      fetch,
      syncCall,
      () => 204,
      readTask,
    );
    expect(result).toEqual({ complete: false, indexed_comments: 0 });
    expect(index.storeComments).not.toHaveBeenCalled();
  });

  it("preserves all 60 assignees from the native authorized task GET", async () => {
    const { store, index, syncCall } = fixture();
    const provider = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      let data: unknown;
      if (path === "/api/v2/task/task1") {
        data = {
          id: "task1",
          name: "Crowded assignment",
          status: { status: "open" },
          list: { id: "12345" },
          date_updated: "1000",
          assignees: Array.from({ length: 60 }, (_, idx) => ({ id: idx + 1 })),
        };
      } else if (path === "/api/v2/list/12345") {
        data = { id: "12345", space: { id: "sp1" } };
      } else if (path === "/api/v2/team/555/space") {
        data = { spaces: [{ id: "sp1" }] };
      } else {
        throw new Error("Unexpected native task preflight path: " + path);
      }
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const result = await synchronizeDirtyTask(
      { task_id: "task1", task_dirty: true, comments_dirty: false, attempts: 0 },
      grant,
      store,
      provider,
      syncCall,
      () => 205,
    );
    expect(result.complete).toBe(true);
    const stored = index.storeTask.mock.calls[0]?.[0] as { assignee_ids: string[] };
    expect(stored.assignee_ids).toHaveLength(60);
    expect(stored.assignee_ids[59]).toBe("60");
    expect(provider).toHaveBeenCalledTimes(3);
  });

  it("uses actual 429 cooldowns and bounded retry backoff", () => {
    expect(retryDelayMs(new ReadFailure("CLICKUP_RATE_LIMITED"), 9)).toBe(60_000);
    expect(retryDelayMs(new Error("temporary failure"), 0)).toBe(30_000);
    expect(retryDelayMs(new Error("temporary failure"), 15)).toBe(60 * 60_000);
  });
});
