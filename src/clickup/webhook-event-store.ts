import type { WebhookHint } from "./webhook-ingress.js";

const WEEK = 7 * 24 * 60 * 60 * 1000;

/** Internal binding only. Partition by approved Workspace and authenticated actor. */
export class ClickUpWebhookEvents {
  constructor(private readonly state: DurableObjectState) {
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS hints (event_key TEXT PRIMARY KEY, task_id TEXT NOT NULL, event TEXT NOT NULL, received_at INTEGER NOT NULL)",
    );
    state.storage.sql.exec("CREATE INDEX IF NOT EXISTS hints_received ON hints(received_at)");
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || path !== "/ingest") return new Response(null, { status: 404 });
    const raw: unknown = await request.json().catch(() => null);
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 500)
      return new Response(null, { status: 400 });
    const now = Date.now();
    const hints: WebhookHint[] = [];
    for (const value of raw) {
      if (value === null || typeof value !== "object" || Array.isArray(value))
        return new Response(null, { status: 400 });
      const item = value as Record<string, unknown>;
      const key = item["key"];
      const taskId = item["taskId"];
      const event = item["event"];
      const receivedAt = item["receivedAt"];
      if (
        typeof key !== "string" ||
        !/^[a-f0-9-]{36}:[a-zA-Z0-9_-]{1,100}$/i.test(key) ||
        typeof taskId !== "string" ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(taskId) ||
        typeof event !== "string" ||
        !/^task[A-Z][A-Za-z]{1,40}$/.test(event) ||
        typeof receivedAt !== "number" ||
        !Number.isSafeInteger(receivedAt) ||
        Math.abs(receivedAt - now) > 60_000
      )
        return new Response(null, { status: 400 });
      hints.push({ key, taskId, event, receivedAt });
    }
    this.state.storage.transactionSync(() => {
      for (const hint of hints) {
        this.state.storage.sql.exec(
          "INSERT OR IGNORE INTO hints(event_key, task_id, event, received_at) VALUES (?, ?, ?, ?)",
          hint.key,
          hint.taskId,
          hint.event,
          hint.receivedAt,
        );
      }
      this.state.storage.sql.exec("DELETE FROM hints WHERE received_at < ?", now - WEEK);
      this.state.storage.sql.exec(
        "DELETE FROM hints WHERE event_key IN (SELECT event_key FROM hints ORDER BY received_at DESC, event_key DESC LIMIT -1 OFFSET 5000)",
      );
    });
    await this.state.storage.setAlarm(now + WEEK);
    return new Response(null, { status: 204 });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.state.storage.sql.exec("DELETE FROM hints WHERE received_at <= ?", now - WEEK);
    const remaining = this.state.storage.sql
      .exec<{ earliest: number | null }>("SELECT MIN(received_at) AS earliest FROM hints")
      .one();
    if (remaining.earliest !== null)
      await this.state.storage.setAlarm(Math.max(now + 1000, remaining.earliest + WEEK));
  }
}
