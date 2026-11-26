import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { TaskIndexStore, projectCommentSnapshot, projectTaskSnapshot } from "../src/clickup/task-index.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  const run = (sql: string, ...bindings: Array<string | number | null>) => {
    const statement = db.prepare(sql);
    if (/^\\s*SELECT\\b/i.test(sql) || /\\bRETURNING\\b/i.test(sql)) {
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
});
