import type { SqlRunner } from "./task-index.js";

/**
 * A user-facing alert is a different kind of work from an indexed webhook.
 * A verified ClickUp read, an alarm, or an MCP tool result never proves that a
 * human-facing briefing was published. The delivery ledger therefore starts
 * in a PENDING state and can be completed only by a trusted notifier receipt.
 *
 * No MCP tool grants a model permission to confirm delivery.
 */
export class AttentionDeliveryLedger {
  constructor(private readonly run: SqlRunner) {
    run(
      "CREATE TABLE IF NOT EXISTS attention_delivery_outbox (alert_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attention_revision INTEGER NOT NULL, event_keys_json TEXT NOT NULL, reason TEXT NOT NULL, queued_at_ms INTEGER NOT NULL, published_at_ms INTEGER, delivery_provider TEXT, provider_message_id TEXT, UNIQUE(task_id, attention_revision))",
    );
    run(
      "CREATE INDEX IF NOT EXISTS attention_delivery_pending ON attention_delivery_outbox(published_at_ms, queued_at_ms, alert_id)",
    );
  }

  enqueue(
    taskId: string,
    revision: number,
    eventKeys: readonly string[],
    reason: string,
    at: number,
  ): string {
    if (
      !/^[a-zA-Z0-9_-]{1,80}$/.test(taskId) ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      !Number.isSafeInteger(at) ||
      at < 1 ||
      eventKeys.length < 1 ||
      eventKeys.length > 5000 ||
      new Set(eventKeys).size !== eventKeys.length ||
      eventKeys.some((key) => !/^[a-f0-9-]{36}:[a-zA-Z0-9_-]{1,100}$/i.test(key)) ||
      !/^(?:assigned_change|direct_mention|owned_change)$/.test(reason)
    )
      throw new Error("ATTENTION_DELIVERY_INVALID");

    const alertId = taskId + ":" + revision;
    this.run(
      "INSERT OR IGNORE INTO attention_delivery_outbox(alert_id, task_id, attention_revision, event_keys_json, reason, queued_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
      alertId,
      taskId,
      revision,
      JSON.stringify(eventKeys),
      reason,
      at,
    );
    return alertId;
  }

  taskSummary(taskId: string): {
    pending_delivery_count: number;
    last_confirmed_delivery_at_ms: number | null;
    delivery_receipt_supported: boolean;
  } {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(taskId)) throw new Error("ATTENTION_DELIVERY_INVALID");
    const row = this.run(
      "SELECT COUNT(CASE WHEN published_at_ms IS NULL THEN 1 END) AS pending, MAX(published_at_ms) AS last_published FROM attention_delivery_outbox WHERE task_id = ?",
      taskId,
    ).one() as { pending: number; last_published: number | null };
    return {
      pending_delivery_count: row.pending,
      last_confirmed_delivery_at_ms: row.last_published,
      // This is deliberately false until a native, trusted notification
      // publisher is actually connected; the ChatGPT tool has no such receipt.
      delivery_receipt_supported: false,
    };
  }

  pending(limit = 50): Array<{
    alert_id: string;
    task_id: string;
    attention_revision: number;
    event_keys: string[];
    reason: string;
    queued_at_ms: number;
  }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error("ATTENTION_DELIVERY_INVALID");
    const rows = this.run(
      "SELECT alert_id, task_id, attention_revision, event_keys_json, reason, queued_at_ms FROM attention_delivery_outbox WHERE published_at_ms IS NULL ORDER BY queued_at_ms, alert_id LIMIT ?",
      limit,
    ).toArray() as Array<{
      alert_id: string;
      task_id: string;
      attention_revision: number;
      event_keys_json: string;
      reason: string;
      queued_at_ms: number;
    }>;
    return rows.map(({ event_keys_json, ...row }) => ({
      ...row,
      event_keys: JSON.parse(event_keys_json) as string[],
    }));
  }

  /**
   * Only a trusted server-owned delivery adapter may call this after its
   * provider confirms the final message was published for the recipient.
   * This method is intentionally NOT exposed by any Worker route or MCP tool.
   *
   * A notification being queued, an agent turn completing, and a successful
   * tool result are explicitly not acceptable delivery evidence.
   */
  confirmFromTrustedNotifier(
    alertIds: readonly string[],
    confirmation: {
      provider: string;
      messageId: string;
      publishedAtMs: number;
    },
  ): number {
    if (
      alertIds.length < 1 ||
      alertIds.length > 100 ||
      new Set(alertIds).size !== alertIds.length ||
      alertIds.some((id) => !/^[a-zA-Z0-9_-]{1,80}:[1-9]\d{0,11}$/.test(id)) ||
      !/^[a-zA-Z0-9_-]{2,64}$/.test(confirmation.provider) ||
      !/^[a-zA-Z0-9:._/-]{8,200}$/.test(confirmation.messageId) ||
      !Number.isSafeInteger(confirmation.publishedAtMs) ||
      confirmation.publishedAtMs < 1
    )
      throw new Error("ATTENTION_DELIVERY_INVALID");
    let updated = 0;
    for (const alertId of alertIds) {
      const result = this.run(
        "UPDATE attention_delivery_outbox SET published_at_ms = ?, delivery_provider = ?, provider_message_id = ? WHERE alert_id = ? AND published_at_ms IS NULL RETURNING alert_id",
        confirmation.publishedAtMs,
        confirmation.provider,
        confirmation.messageId,
        alertId,
      ).toArray();
      updated += result.length;
    }
    return updated;
  }
}
