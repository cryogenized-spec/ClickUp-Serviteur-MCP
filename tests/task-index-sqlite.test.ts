import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  TaskIndexStore,
  projectCommentSnapshot,
  projectTaskSnapshot,
} from "../src/clickup/task-index.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  const run = (sql: string, ...bindings: Array<string | number | null>) => {
    const statement = db.prepare(sql);
    if (/^\s*SELECT\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
      return {
        one: () => statement.get(...bindings),
        toArray: () => statement.all(...bindings),
      };
    }
    statement.run(...bindings);
    return { one: () => null, toArray: () => [] };
  };
  const store = new TaskIndexStore(run, (action) => {
    db.exec("BEGIN");
    try {
      action();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
  return { db, store };
}

const indexedTask = (version: number, title: string) => {
  const item = projectTaskSnapshot({
    id: "task123",
    list: { id: "901202442802" },
    name: title,
    status: { status: "repairs" },
    date_updated: version,
  });
  if (!item) throw Error("Fixture task projection failed");
  return item;
};
const indexedComment = (id: string, text: string) => {
  const item = projectCommentSnapshot({
    id,
    date: "1795680000000",
    comment_text: text,
  });
  if (!item) throw Error("Fixture comment projection failed");
  return item;
};

describe("real SQLite task-index regressions", () => {
  const open: DatabaseSync[] = [];
  afterEach(() => {
    for (const db of open.splice(0)) db.close();
  });
  const make = () => {
    const fixtureValue = fixture();
    open.push(fixtureValue.db);
    return fixtureValue.store;
  };

  it("keeps a task dirty if an older provider revision loses the UPSERT", () => {
    const store = make();
    store.storeTask(indexedTask(500, "Version 500"), 100);
    store.markDirty("task123", "taskUpdated", 200);
    store.storeTask(indexedTask(400, "Older version 400"), 300);
    const state = store.lookup("task123");
    expect((state?.["task"] as { title: string }).title).toBe("Version 500");
    expect(state?.["task_stale"]).toBe(true);
    expect(store.diagnostics()["task_refresh_pending"]).toBe(1);
    store.storeTask(indexedTask(600, "Version 600"), 400);
    expect((store.lookup("task123")?.["task"] as { title: string }).title).toBe("Version 600");
    expect(store.lookup("task123")?.["task_stale"]).toBe(false);
  });

  it("reconciles removed comments only after an authoritative complete scan", () => {
    const store = make();
    store.storeComments("task123", [indexedComment("c1", "Deleted later")], 100, true);
    store.markDirty("task123", "taskCommentUpdated", 200);
    store.storeComments("task123", [], 250, false);
    expect(store.diagnostics()["indexed_comments"]).toBe(1);
    expect(store.diagnostics()["comment_refresh_pending"]).toBe(1);
    store.storeComments("task123", [], 300, true);
    expect(store.diagnostics()["indexed_comments"]).toBe(0);
    expect(store.diagnostics()["comment_refresh_pending"]).toBe(0);
  });

  it("refuses to erase a more recently observed comment during a stale complete scan", () => {
    const store = make();
    store.storeComments("task123", [indexedComment("c1", "Original")], 100, true);
    store.markDirty("task123", "taskCommentPosted", 220);
    store.storeComments("task123", [indexedComment("c2", "Newer")], 350, false);
    store.storeComments("task123", [], 200, true);
    expect(store.diagnostics()["indexed_comments"]).toBe(2);
    expect(store.diagnostics()["comment_refresh_pending"]).toBe(1);
  });

  it("is idempotent on duplicate comment identifiers, while retaining changed content", () => {
    const store = make();
    store.storeComments("task123", [indexedComment("c1", "First")], 100, false);
    store.storeComments("task123", [indexedComment("c1", "Edited")], 200, true);
    expect(store.diagnostics()["indexed_comments"]).toBe(1);
  });

  it("never resurrects a deleted comment from an older in-flight read", () => {
    const store = make();
    store.storeComments("task123", [indexedComment("c1", "Old note")], 100, true);
    store.markDirty("task123", "taskCommentUpdated", 200);
    store.storeComments("task123", [], 300, true);
    expect(store.diagnostics()["indexed_comments"]).toBe(0);
    store.storeComments("task123", [indexedComment("c1", "Old note")], 150, false);
    store.storeComments("task123", [indexedComment("c1", "Old note")], 150, true);
    expect(store.diagnostics()["indexed_comments"]).toBe(0);
    expect(store.diagnostics()["comment_refresh_pending"]).toBe(0);
  });

  it("blocks late in-flight task and comment reads after a definitive access denial", () => {
    const store = make();
    store.storeTask(indexedTask(100, "Initially authorized"), 100);
    store.storeComments("task123", [indexedComment("c1", "Private content")], 100, true);
    // The later request observes revoked access and purges both collections.
    store.discardSnapshots("task123", 300);
    expect(store.lookup("task123")).toBeNull();
    expect(store.diagnostics()["indexed_comments"]).toBe(0);
    // Both older requests return AFTER the 403. Their original start
    // timestamps must remain older than the durable denial watermark.
    expect(store.storeTask(indexedTask(200, "Late task response"), 200)).toBe(false);
    store.storeComments("task123", [indexedComment("c1", "Resurrected")], 250, false);
    store.storeComments("task123", [indexedComment("c2", "Resurrected")], 250, true);
    expect(store.lookup("task123")).toBeNull();
    expect(store.diagnostics()["indexed_comments"]).toBe(0);
    expect(store.storeTask(indexedTask(300, "Same-millisecond response"), 300)).toBe(false);
    // A genuinely NEW authorized request after the denial can revalidate
    // and restore content without bypassing the native ClickUp preflight.
    expect(store.storeTask(indexedTask(400, "Newly authorized"), 400)).toBe(true);
    store.storeComments("task123", [indexedComment("c3", "Fresh")], 400, true);
    expect((store.lookup("task123")?.["task"] as { title: string }).title).toBe("Newly authorized");
    expect(store.diagnostics()["indexed_comments"]).toBe(1);
  });

  it("never lowers an existing access-denial watermark", () => {
    const store = make();
    store.discardSnapshots("task123", 400);
    store.discardSnapshots("task123", 300);
    expect(store.storeTask(indexedTask(350, "Prior access"), 350)).toBe(false);
    expect(store.lookup("task123")).toBeNull();
  });

  it("discovers missing and changed tasks without resetting an outstanding retry", () => {
    const store = make();
    const older = { task_id: "task123", list_id: "901202442802", source_updated_at_ms: 100 };
    expect(store.observeDiscoveredTasks([older], 150)).toEqual({
      enqueued: 1,
      already_pending: 0,
      unchanged: 0,
    });
    expect(store.dirtyTasks(160)).toEqual([
      { task_id: "task123", task_dirty: true, comments_dirty: true, attempts: 0 },
    ]);
    store.deferTask("task123", 5000, 1);
    expect(store.observeDiscoveredTasks([older], 200)).toMatchObject({
      already_pending: 1,
      enqueued: 0,
    });
    expect(store.dirtyTasks(300)).toHaveLength(0);
    expect(store.nextDirtyDue()).toBe(5000);
    store.storeTask(indexedTask(100, "Authorized full read"), 5500);
    store.storeComments("task123", [], 5500, true);
    expect(store.observeDiscoveredTasks([older], 5600)).toMatchObject({
      unchanged: 1,
      enqueued: 0,
    });
    expect(
      store.observeDiscoveredTasks([{ ...older, source_updated_at_ms: 200 }], 5800),
    ).toMatchObject({ enqueued: 1 });
    expect(store.dirtyTasks(5900)[0]).toMatchObject({
      task_id: "task123",
      task_dirty: true,
      comments_dirty: true,
    });
  });

  it("never requeues an older list page across a confirmed access-denial barrier", () => {
    const store = make();
    store.discardSnapshots("task123", 300);
    expect(
      store.observeDiscoveredTasks(
        [{ task_id: "task123", list_id: "901202442802", source_updated_at_ms: 100 }],
        200,
      ),
    ).toMatchObject({ enqueued: 0, unchanged: 1 });
    expect(store.dirtyTasks(500)).toEqual([]);
  });

  it("rejects duplicate or malformed discovery summaries", () => {
    const store = make();
    const discovered = { task_id: "task123", list_id: "901202442802", source_updated_at_ms: 100 };
    expect(() => store.observeDiscoveredTasks([discovered, discovered], 200)).toThrow(
      "INVALID_DISCOVERY_BATCH",
    );
    expect(() =>
      store.observeDiscoveredTasks([{ ...discovered, source_updated_at_ms: 0 }], 200),
    ).toThrow("INVALID_DISCOVERY_BATCH");
  });

  it("queues both missing snapshot sections after definitive denial, with a bounded retry", () => {
    const store = make();
    store.storeTask(indexedTask(100, "Initial"), 100);
    store.storeComments("task123", [indexedComment("c1", "Initial comment")], 100, true);
    store.markDirty("task123", "taskUpdated", 200);
    store.discardSnapshots("task123", 300);
    expect(store.lookup("task123")).toBeNull();
    expect(store.diagnostics()).toMatchObject({
      task_refresh_pending: 1,
      comment_refresh_pending: 1,
      indexed_comments: 0,
    });
    expect(store.nextDirtyDue()).toBe(300 + 15 * 60_000);
    // Task and comment sections recover only through fresh authorized reads.
    expect(store.storeTask(indexedTask(400, "Reauthorized"), 900_400)).toBe(true);
    store.storeComments("task123", [indexedComment("c2", "Restored")], 900_400, true);
    expect(store.diagnostics()).toMatchObject({
      task_refresh_pending: 0,
      comment_refresh_pending: 0,
      indexed_comments: 1,
    });
  });

  it("retains an event processed after a read starts in the same millisecond", () => {
    const store = make();
    store.storeTask(indexedTask(100, "Stale"), 200);
    store.markDirty("task123", "taskUpdated", 200);
    store.storeTask(indexedTask(100, "Stale"), 200);
    expect(store.lookup("task123")?.["task_stale"]).toBe(true);
    expect(store.dirtyTasks(201)).toHaveLength(1);
    store.storeTask(indexedTask(300, "Fresh"), 202);
    expect(store.lookup("task123")?.["task_stale"]).toBe(false);
  });

  it("does not let an older failed alarm restore its backoff after a new webhook", () => {
    const store = make();
    store.markDirty("task123", "taskUpdated", 100);
    store.deferTask("task123", 200, 7);
    const selected = store.dirtyTasks(250)[0];
    expect(selected?.attempts).toBe(7);
    const oldToken = selected!.dirty_token;
    // New signed change arrives while the selected refresh is in flight.
    store.markDirty("task123", "taskUpdated", 300);
    expect(store.deferTaskIfCurrent("task123", 60_000, 8, oldToken)).toBe(false);
    expect(store.nextDirtyDue()).toBe(0);
    expect(store.dirtyTasks(301)[0]?.attempts).toBe(0);
    const newToken = store.dirtyTasks(301)[0]!.dirty_token;
    expect(store.deferTaskIfCurrent("task123", 2000, 1, newToken)).toBe(true);
    expect(store.nextDirtyDue()).toBe(2000);
  });

  it("keeps task and comment pending-refresh indicators independent", () => {
    const store = make();
    store.storeTask(indexedTask(100, "A"), 100);
    store.storeComments("task123", [], 100, true);
    store.markDirty("task123", "taskCommentPosted", 200);
    expect(store.lookup("task123")?.["task_stale"]).toBe(false);
    expect(store.lookup("task123")?.["comments_stale"]).toBe(true);
    store.markDirty("task123", "taskStatusUpdated", 210);
    expect(store.lookup("task123")?.["task_stale"]).toBe(true);
  });
  it("coalesces dirty tasks, respects retry checkpoints and reactivates new changes", () => {
    const store = make();
    store.markDirty("task1", "taskCreated", 1000);
    store.markDirty("task2", "taskCommentPosted", 1100);
    expect(store.dirtyTasks(1200, 10)).toEqual([
      {
        task_id: "task1",
        task_dirty: true,
        comments_dirty: false,
        attempts: 0,
        dirty_token: "1001:0",
      },
      {
        task_id: "task2",
        task_dirty: false,
        comments_dirty: true,
        attempts: 0,
        dirty_token: "0:1101",
      },
    ]);
    store.deferTask("task1", 5000, 1);
    expect(store.dirtyTasks(1200, 10).map((item) => item.task_id)).toEqual(["task2"]);
    expect(store.nextDirtyDue()).toBe(0);
    store.storeComments("task2", [], 1300, true);
    expect(store.nextDirtyDue()).toBe(5000);
    store.markDirty("task1", "taskStatusUpdated", 1400);
    expect(store.dirtyTasks(1500, 10)[0]?.attempts).toBe(0);
    expect(store.nextDirtyDue()).toBe(0);
  });

  it("discards previously cached task and comment content after access is revoked", () => {
    const store = make();
    store.storeTask(indexedTask(100, "Sensitive"), 100);
    store.storeComments("task123", [indexedComment("c1", "Sensitive note")], 100, true);
    store.discardSnapshots("task123");
    expect(store.lookup("task123")).toBeNull();
    expect(store.diagnostics()["indexed_comments"]).toBe(0);
  });
});
