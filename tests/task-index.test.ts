import { describe, expect, it, vi } from "vitest";
import {
  TaskIndexStore,
  captureVerifiedComments,
  captureVerifiedTask,
  projectCommentSnapshot,
  projectTaskSnapshot,
} from "../src/clickup/task-index.js";
import type { ReadGrant } from "../src/clickup/policy.js";

const upstreamTask = {
  id: "task123",
  name: "Cabinet guide",
  list: { id: "901202442802" },
  status: { status: "repairs" },
  priority: { id: "2" },
  due_date: "1795226400000",
  date_created: "1793861918633",
  date_updated: "1795528779756",
  markdown_description: "Needs replacement guide.",
  assignees: [{ id: 74510260 }],
  attachments: [{ url: "https://signed-private.example/token" }],
  authorization: "must-never-be-indexed",
};

describe("persistent task index projections", () => {
  it("copies relevant task fields without attachment URLs, secrets or foreign fields", () => {
    const snapshot = projectTaskSnapshot(upstreamTask);
    expect(snapshot).toEqual({
      task_id: "task123",
      list_id: "901202442802",
      title: "Cabinet guide",
      status: "repairs",
      priority: 2,
      due_at_ms: 1795226400000,
      created_at_ms: 1793861918633,
      source_updated_at_ms: 1795528779756,
      closed_at_ms: null,
      description: "Needs replacement guide.",
      assignee_ids: ["74510260"],
    });
    expect(JSON.stringify(snapshot)).not.toContain("signed-private");
    expect(JSON.stringify(snapshot)).not.toContain("authorization");
  });

  it("indexes structured mentions once and does not mistake ordinary text for a mention", () => {
    const comment = projectCommentSnapshot({
      id: "1000",
      date: "1795528779756",
      user: { id: 56547556, email: "private@example.test" },
      assignee: { id: 74510260 },
      resolved: false,
      reply_count: 3,
      comment_text: "Hi @Gareth — please investigate.",
      comment: [
        { type: "tag", user: { id: 74510260 } },
        { type: "tag", user: { id: 74510260 } },
        { text: "@Sameer Singh" },
      ],
    });
    expect(comment).toMatchObject({
      comment_id: "1000",
      author_id: "56547556",
      assigned_to: "74510260",
      resolved: false,
      mentioned_user_ids: ["74510260"],
      reply_count: 3,
    });
    expect(JSON.stringify(comment)).not.toContain("private@example");
  });

  it("rejects malformed task records rather than indexing ambiguous identifiers", () => {
    expect(projectTaskSnapshot({ name: "No task ID", list: { id: "123" } })).toBeNull();
    expect(projectTaskSnapshot({ id: "abc", name: "Wrong list", list: { id: "abc" } })).toBeNull();
    expect(projectCommentSnapshot({ comment_text: "No comment ID" })).toBeNull();
  });
});

describe("actor-local SQLite index operations", () => {
  function fixture() {
    const executed: Array<{ sql: string; params: unknown[] }> = [];
    const exec = vi.fn((sql: string, ...params: unknown[]) => {
      executed.push({ sql, params });
      return { one: () => ({ count: 0, tasks: 0, comments: 0 }), toArray: () => [] };
    });
    const store = new TaskIndexStore((sql, ...params) => exec(sql, ...params));
    return { executed, store };
  }

  it("creates unique task/comment keys and records task and comment invalidations separately", () => {
    const { executed, store } = fixture();
    expect(executed.map((item) => item.sql).join("\n")).toContain(
      "PRIMARY KEY(task_id, comment_id)",
    );
    store.markDirty("task123", "taskCommentPosted", 1795680000000);
    store.markDirty("task123", "taskStatusUpdated", 1795680000001);
    const dirty = executed.filter((item) => item.sql.startsWith("INSERT INTO task_refresh"));
    expect(dirty[0]?.params).toEqual(["task123", 0, 1795680000000]);
    expect(dirty[1]?.params).toEqual(["task123", 1795680000001, 0]);
  });

  it("uses monotonic snapshot upserts and only clears comment dirtiness after complete scans", () => {
    const { executed, store } = fixture();
    const task = projectTaskSnapshot(upstreamTask);
    const comment = projectCommentSnapshot({
      id: "comment2",
      date: "1795680000000",
      comment_text: "OK",
    });
    expect(task).not.toBeNull();
    expect(comment).not.toBeNull();
    store.storeTask(task!, 1795681000000);
    store.storeComments("task123", [comment!], 1795681000100, false);
    expect(
      executed.some((item) =>
        item.sql.includes("excluded.source_updated_at >= task_snapshots.source_updated_at"),
      ),
    ).toBe(true);
    expect(
      executed.some(
        (item) => item.sql.includes("comment_snapshots") && item.params[1] === "comment2",
      ),
    ).toBe(true);
    expect(executed.filter((item) => item.sql.includes("comments_checked_at"))).toHaveLength(1);
    store.storeComments("task123", [comment!], 1795681000200, true);
    expect(
      executed.filter((item) =>
        item.sql.startsWith("INSERT INTO task_refresh(task_id, comments_checked_at)"),
      ),
    ).toHaveLength(1);
  });
});

describe("verified ClickUp read capture", () => {
  function fixture(listId = "901202442802") {
    const calls = vi.fn(async (request: Request) => {
      expect(request.method).toBe("POST");
      return Response.json({ indexed: true });
    });
    const grant = {
      subject: "github:11",
      clickupUserId: "74510260",
      workspaceId: "9005168750",
      listId,
      resourceScope: "list" as const,
      apiToken: "private",
      quota: { idFromName: (value: string) => value, get: () => ({ fetch: calls }) },
      taskIndex: { idFromName: (value: string) => value, get: () => ({ fetch: calls }) },
    } satisfies ReadGrant;
    return { grant, calls };
  }

  it("writes only verified same-List tasks to the actor's private Durable Object", async () => {
    const { grant, calls } = fixture();
    expect(await captureVerifiedTask(grant, upstreamTask, 1795681000000)).toBe(true);
    expect(calls).toHaveBeenCalledTimes(1);
    const request = calls.mock.calls[0]![0];
    expect(new URL(request.url).pathname).toBe("/index/task");
    const body = (await request.json()) as Record<string, unknown>;
    expect((body["snapshot"] as { task_id: string }).task_id).toBe("task123");
    expect(JSON.stringify(body)).not.toContain("signed-private");
  });

  it("does not cache a foreign-List task even if a caller supplies its record", async () => {
    const { grant, calls } = fixture("some-other-list");
    expect(await captureVerifiedTask(grant, upstreamTask, 1795681000000)).toBe(false);
    expect(calls).not.toHaveBeenCalled();
  });

  it("records comment pages without claiming that an incomplete scan is fresh", async () => {
    const { grant, calls } = fixture();
    expect(
      await captureVerifiedComments(
        grant,
        upstreamTask,
        [{ id: "c1", comment_text: "New message", date: "1795680000000" }],
        1795681000000,
        false,
      ),
    ).toBe(true);
    const request = calls.mock.calls[0]![0];
    const body = (await request.json()) as { complete: boolean; comments: unknown[] };
    expect(body.complete).toBe(false);
    expect(body.comments).toHaveLength(1);
  });
});
