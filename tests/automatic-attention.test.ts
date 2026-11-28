import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { classifyAutomaticAttention } from "../src/clickup/automatic-attention.js";
import { ClickUpWebhookEvents } from "../src/clickup/webhook-event-store.js";
import { projectTaskSnapshot } from "../src/clickup/task-index.js";
import type { OAuthEnv } from "../src/auth/env.js";

const self = "74510260";
const other = "152461219";
const snapshot = {
  task_id: "task1",
  source_updated_at_ms: 1795844000000,
  closed_at_ms: null,
  assignee_ids: [other],
};
const hint = (
  key: string,
  event: string,
  metadata: Record<string, unknown> = {},
  received_at = 1795844000000,
) => ({ event_key: key, event, metadata, received_at });

describe("deterministic automatic attention routing", () => {
  it("suppresses changes to delegated tasks without inventing user awareness", () => {
    const changes = [hint("key1", "taskCommentPosted", { actor_user_id: other })];
    const decision = classifyAutomaticAttention(snapshot, self, changes, {
      state: "awaiting_response",
      waiting_on_user_id: other,
    });
    expect(decision).toMatchObject({
      ownership: "delegated",
      changed: true,
      needs_attention: false,
      reason: "delegated_change",
    });
  });

  it("reopens attention for a genuine individual mention or reassignment", () => {
    const followup = { state: "awaiting_response", waiting_on_user_id: other };
    expect(
      classifyAutomaticAttention(
        snapshot,
        self,
        [hint("m", "taskCommentPosted", { actor_user_id: other, mentioned_user_ids: [self] })],
        followup,
      ),
    ).toMatchObject({ needs_attention: true, reason: "direct_mention" });
    const reassigned = { ...snapshot, assignee_ids: [self] };
    expect(
      classifyAutomaticAttention(
        reassigned,
        self,
        [
          hint("a", "taskAssigneeUpdated", {
            actor_user_id: other,
            assignee_user_id: self,
            field: "assignee_add",
          }),
        ],
        followup,
      ),
    ).toMatchObject({ ownership: "assigned", needs_attention: true, reason: "assigned_change" });
  });

  it("does not manufacture an alert from the user's own activity or an unchanged task", () => {
    const assigned = { ...snapshot, assignee_ids: [self] };
    expect(
      classifyAutomaticAttention(
        assigned,
        self,
        [hint("own", "taskCommentPosted", { actor_user_id: self })],
        null,
      ).needs_attention,
    ).toBe(false);
    expect(classifyAutomaticAttention(assigned, self, [], null)).toMatchObject({
      changed: false,
      needs_attention: false,
      reason: "no_change",
    });
  });

  it("does not reopen a closed case for an old mention", () => {
    expect(
      classifyAutomaticAttention(
        { ...snapshot, closed_at_ms: 1795844000000 },
        self,
        [hint("m", "taskCommentPosted", { mentioned_user_ids: [self] })],
        null,
      ),
    ).toMatchObject({ ownership: "closed", needs_attention: false });
  });
});

describe("Durable Object backend checkpoint", () => {
  const databases: DatabaseSync[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  function fixture() {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    const sql = {
      exec: (query: string, ...args: Array<string | number | null>) => {
        const stmt = db.prepare(query);
        if (query.trimStart().startsWith("SELECT") || query.includes("RETURNING"))
          return { one: () => stmt.get(...args), toArray: () => stmt.all(...args) };
        stmt.run(...args);
        return { one: () => null, toArray: () => [] };
      },
    };
    const storage = {
      sql,
      transactionSync: (fn: () => void) => {
        db.exec("BEGIN");
        try {
          fn();
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
      getAlarm: async () => null,
      setAlarm: async () => {},
    };
    const instance = new ClickUpWebhookEvents(
      { storage } as unknown as DurableObjectState,
      { CLICKUP_WORKSPACE_ID: "555" } as OAuthEnv,
    );
    const checkpoint = (cutoff: number) =>
      (
        instance as unknown as {
          checkpointAttention: (taskId: string, actor: string, cutoff: number) => void;
        }
      ).checkpointAttention("task1", self, cutoff);
    return { db, instance, checkpoint };
  }

  it("advances a durable cursor once after a verified refresh, not at ingestion", async () => {
    const { db, instance, checkpoint } = fixture();
    const at = Date.now();
    const event = {
      key: "7689a169-a000-4985-8676-6902b96d6627:historyevent1",
      taskId: "task1",
      event: "taskStatusUpdated",
      receivedAt: at,
      metadata: { actor_user_id: other, field: "status" },
    };
    const ingest = (item: typeof event) =>
      instance.fetch(new Request("https://internal/ingest", {
        method: "POST",
        body: JSON.stringify([item]),
      }));
    expect((await ingest(event)).status).toBe(204);
    const read = () =>
      instance.fetch(new Request("https://internal/attention/task?task_id=task1"));
    expect(await (await read()).json()).toMatchObject({ checkpoint: null });
    const indexed = projectTaskSnapshot({
      id: "task1",
      name: "Verified customer return",
      list: { id: "12345" },
      assignees: [{ id: self }],
      status: { status: "repairs" },
      date_updated: at + 1,
    });
    expect(indexed).not.toBeNull();
    const stored = await instance.fetch(new Request("https://internal/index/task", {
      method: "POST",
      body: JSON.stringify({ snapshot: indexed, observed_at: at + 1000 }),
    }));
    expect(stored.status).toBe(200);
    checkpoint(at);
    const first = (await (await read()).json()) as {
      checkpoint: { revision: number; needs_attention: number; last_event_key: string };
    };
    expect(first.checkpoint).toMatchObject({
      revision: 1,
      needs_attention: 1,
      last_event_key: event.key,
    });
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM consumer_processed WHERE consumer = 'backend-attention'")
        .get(),
    ).toMatchObject({ n: 1 });
    // Replays and repeated alarms do not advance the system checkpoint.
    expect((await ingest({ ...event, receivedAt: at })).status).toBe(204);
    checkpoint(at + 1);
    expect((await (await read()).json()) as unknown).toMatchObject({
      checkpoint: { revision: 1, last_event_key: event.key },
    });
  });

  it("does not mark a still-dirty snapshot as processed", async () => {
    const { instance, checkpoint } = fixture();
    const at = Date.now();
    const event = {
      key: "7689a169-a000-4985-8676-6902b96d6627:historyevent2",
      taskId: "task1",
      event: "taskCommentPosted",
      receivedAt: at,
    };
    await instance.fetch(new Request("https://internal/ingest", {
      method: "POST",
      body: JSON.stringify([event]),
    }));
    checkpoint(at + 1);
    const response = await instance.fetch(
      new Request("https://internal/attention/task?task_id=task1"),
    );
    expect(await response.json()).toMatchObject({ checkpoint: null });
  });
});
