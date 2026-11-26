import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { ClickUpWebhookEvents } from "../src/clickup/webhook-event-store.js";
import { projectTaskSnapshot } from "../src/clickup/task-index.js";
import type { OAuthEnv } from "../src/auth/env.js";

function fixture(autoRefresh = false) {
  const db = new DatabaseSync(":memory:");
  const exec = (sql: string, ...bindings: Array<string | number | null>) => {
    const prepared = db.prepare(sql);
    if (/^\s*SELECT\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
      return { one: () => prepared.get(...bindings), toArray: () => prepared.all(...bindings) };
    }
    prepared.run(...bindings);
    return { one: () => null, toArray: () => [] };
  };
  const alarms: number[] = [];
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
    setAlarm: async (at: number) => {
      alarms.push(at);
    },
    getAlarm: async () => null,
  };
  const env = {
    CLICKUP_WORKSPACE_ID: "555",
    CLICKUP_INDEX_AUTOSYNC_ENABLED: autoRefresh ? "true" : "false",
  } as unknown as OAuthEnv;
  const instance = new ClickUpWebhookEvents({ storage } as unknown as DurableObjectState, env);
  return { db, instance, alarms };
}

describe("idempotent Durable Object webhook ingestion", () => {
  const databases: DatabaseSync[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  it("accepts only the configured actor identity for queued event-driven refresh", async () => {
    const { db, instance, alarms } = fixture(true);
    databases.push(db);
    const receivedAt = Date.now();
    const hint = {
      key: "7689a169-a000-4985-8676-6902b96d6627:historynext001",
      taskId: "task1",
      event: "taskCommentPosted",
      receivedAt,
    };
    const send = (body: unknown) =>
      instance.fetch(
        new Request("https://internal/ingest", {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    expect((await send({ workspaceId: "777", subject: "github:11", hints: [hint] })).status).toBe(
      400,
    );
    expect((await send({ workspaceId: "555", subject: "github:11", hints: [hint] })).status).toBe(
      204,
    );
    const owner = db.prepare("SELECT workspace_id, subject FROM sync_owner").get() as {
      workspace_id: string;
      subject: string;
    };
    expect(owner).toEqual({ workspace_id: "555", subject: "github:11" });
    expect(alarms.some((at) => at <= Date.now() + 10_000)).toBe(true);
    // This test has no authorized OAuth vault. Its alarm must not attempt a
    // privileged network read or claim successful synchronization.
    await instance.alarm();
    const status = await instance.fetch(new Request("https://internal/diagnostics"));
    const body = (await status.json()) as {
      task_index: { comment_refresh_pending: number };
    };
    expect(body.task_index.comment_refresh_pending).toBe(1);
  });

  it("accepts minimal discovery hints only as pending revalidation work", async () => {
    const { db, instance } = fixture();
    databases.push(db);
    const body = {
      observed_at: Date.now(),
      tasks: [{ task_id: "taskxyz", list_id: "12345", source_updated_at_ms: 1000 }],
    };
    const submit = () =>
      instance.fetch(
        new Request("https://internal/index/discovery", {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    const first = await submit();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ enqueued: 1, unchanged: 0 });
    const repeated = await submit();
    expect(await repeated.json()).toMatchObject({ enqueued: 0, already_pending: 1 });
    const snapshot = await instance.fetch(
      new Request("https://internal/index/task?task_id=taskxyz"),
    );
    // A list summary is NOT a validated, cached task-content response.
    expect(snapshot.status).toBe(404);
    const diagnostics = await instance.fetch(new Request("https://internal/diagnostics"));
    expect((await diagnostics.json()) as unknown).toMatchObject({
      task_index: { task_refresh_pending: 1, comment_refresh_pending: 1 },
    });
    const unsafe = await instance.fetch(
      new Request("https://internal/index/discovery", {
        method: "POST",
        body: JSON.stringify({
          observed_at: Date.now(),
          tasks: [{ task_id: "bad/id", list_id: "12345", source_updated_at_ms: 1000 }],
        }),
      }),
    );
    expect(unsafe.status).toBe(400);
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
