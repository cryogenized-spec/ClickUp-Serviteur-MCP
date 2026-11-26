import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { ClickUpWebhookEvents } from "../src/clickup/webhook-event-store.js";
import { projectTaskSnapshot } from "../src/clickup/task-index.js";
import type { OAuthEnv } from "../src/auth/env.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  const exec = (sql: string, ...bindings: Array<string | number | null>) => {
    const prepared = db.prepare(sql);
    if (/^\s*SELECT\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
      return { one: () => prepared.get(...bindings), toArray: () => prepared.all(...bindings) };
    }
    prepared.run(...bindings);
    return { one: () => null, toArray: () => [] };
  };
  const storage = {
    sql: { exec },
    transactionSync: (action: () => void) => {
      db.exec("BEGIN");
      try {
        action();
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    setAlarm: async () => {},
    getAlarm: async () => null,
  };
  const env = {
    CLICKUP_WORKSPACE_ID: "555",
    CLICKUP_INDEX_AUTOSYNC_ENABLED: "false",
  } as unknown as OAuthEnv;
  const instance = new ClickUpWebhookEvents({ storage } as unknown as DurableObjectState, env);
  return { db, instance };
}

describe("idempotent Durable Object webhook ingestion", () => {
  const databases: DatabaseSync[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  it("does not re-invalidate a verified snapshot on an identical event replay", async () => {
    const { db, instance } = fixture();
    databases.push(db);
    const now = Date.now();
    const event = {
      key: "7689a169-a000-4985-8676-6902b96d6627:historyabc123",
      taskId: "task1",
      event: "taskStatusUpdated",
      receivedAt: now,
    };
    const post = (body: unknown) =>
      instance.fetch(
        new Request("https://internal/ingest", {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    expect((await post([event])).status).toBe(204);
    const snapshot = projectTaskSnapshot({
      id: "task1",
      list: { id: "12345" },
      name: "Verified current",
      date_updated: now + 1,
    });
    expect(snapshot).not.toBeNull();
    const wrote = await instance.fetch(
      new Request("https://internal/index/task", {
        method: "POST",
        body: JSON.stringify({ snapshot, observed_at: now + 1000 }),
      }),
    );
    expect(wrote.status).toBe(200);
    const before = await instance.fetch(new Request("https://internal/index/task?task_id=task1"));
    expect(((await before.json()) as { task_stale: boolean }).task_stale).toBe(false);
    expect((await post([{ ...event, receivedAt: now + 2000 }])).status).toBe(204);
    const after = await instance.fetch(new Request("https://internal/index/task?task_id=task1"));
    expect(((await after.json()) as { task_stale: boolean }).task_stale).toBe(false);
    const info = await instance.fetch(new Request("https://internal/diagnostics"));
    const metrics = (await info.json()) as {
      retained: number;
      task_index: { task_refresh_pending: number };
    };
    expect(metrics.retained).toBe(1);
    expect(metrics.task_index.task_refresh_pending).toBe(0);
  });
});
