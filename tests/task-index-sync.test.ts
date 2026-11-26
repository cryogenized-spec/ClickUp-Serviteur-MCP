import { describe, expect, it, vi } from "vitest";
import { ReadFailure, type ReadGrant } from "../src/clickup/policy.js";
import {
  grantForSignedWebhook,
  retryDelayMs,
  synchronizeDirtyTask,
} from "../src/clickup/task-index-sync.js";
import type { TaskIndexStore } from "../src/clickup/task-index.js";
import type { OAuthEnv } from "../src/auth/env.js";
import type { runCatalogOperation } from "../src/clickup/catalog-runtime.js";

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
    storeTask: vi.fn(),
    storeComments: vi.fn(),
    discardSnapshots: vi.fn(),
  } as unknown as TaskIndexStore;
  const call = vi.fn(async (name: string) => {
    if (name === "clickup_get_task")
      return {
        id: "task1",
        name: "Fresh task",
        list: { id: "12345" },
        status: { status: "open" },
        date_updated: "100",
      };
    if (name === "clickup_get_task_comments")
      return {
        comments: [{ id: "c1", date: "110", comment_text: "Updated comment" }],
        incomplete: false,
      };
    throw new Error("Unexpected operation " + name);
  });
  const syncCall = call as unknown as typeof runCatalogOperation;
  const index = store as {
    storeTask: ReturnType<typeof vi.fn>;
    storeComments: ReturnType<typeof vi.fn>;
    discardSnapshots: ReturnType<typeof vi.fn>;
  };
  return { store, index, syncCall, call };
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
    const { store, index, syncCall, call } = fixture();
    const result = await synchronizeDirtyTask(
      { task_id: "task1", task_dirty: true, comments_dirty: true, attempts: 0 },
      grant,
      store,
      fetch,
      syncCall,
      () => 200,
    );
    expect(result).toEqual({ complete: true, indexed_comments: 1 });
    expect(call.mock.calls.map((args) => args[0])).toEqual([
      "clickup_get_task",
      "clickup_get_task_comments",
    ]);
    expect(index.storeTask).toHaveBeenCalledTimes(1);
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
    const { store, index } = fixture();
    const call = vi.fn(async () => {
      throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    }) as unknown as typeof runCatalogOperation;
    await expect(
      synchronizeDirtyTask(
        { task_id: "task1", task_dirty: true, comments_dirty: false, attempts: 0 },
        grant,
        store,
        fetch,
        call,
        () => 202,
      ),
    ).rejects.toThrowError("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(index.discardSnapshots).toHaveBeenCalledWith("task1");
  });

  it("uses actual 429 cooldowns and bounded retry backoff", () => {
    expect(retryDelayMs(new ReadFailure("CLICKUP_RATE_LIMITED"), 9)).toBe(60_000);
    expect(retryDelayMs(new Error("temporary failure"), 0)).toBe(30_000);
    expect(retryDelayMs(new Error("temporary failure"), 15)).toBe(60 * 60_000);
  });
});
