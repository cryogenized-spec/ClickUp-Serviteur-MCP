import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { AttentionDeliveryLedger } from "../src/clickup/attention-delivery-ledger.js";

const firstEvent = "7689a169-a000-4985-8676-6902b96d6627:historyevent01";
const secondEvent = "7689a169-a000-4985-8676-6902b96d6627:historyevent02";

describe("separate, durable attention delivery receipts", () => {
  const databases: DatabaseSync[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });
  const setup = () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    const ledger = new AttentionDeliveryLedger((query, ...args) => {
      const stmt = db.prepare(query);
      if (query.trimStart().startsWith("SELECT") || query.includes("RETURNING"))
        return { one: () => stmt.get(...args), toArray: () => stmt.all(...args) };
      stmt.run(...args);
      return { one: () => null, toArray: () => [] };
    });
    return { db, ledger };
  };

  it("does not infer publication from retrieval, replays, or newer processing", () => {
    const { ledger } = setup();
    const id = ledger.enqueue("task1", 1, [firstEvent], "owned_change", 1795844000000);
    expect(id).toBe("task1:1");
    expect(ledger.pending()).toHaveLength(1);
    expect(ledger.pending()).toHaveLength(1);
    // Re-running an alarm's same checkpoint cannot manufacture another alert.
    expect(ledger.enqueue("task1", 1, [firstEvent], "owned_change", 1795844000000)).toBe(id);
    expect(ledger.pending()).toHaveLength(1);
    ledger.enqueue("task1", 2, [secondEvent], "direct_mention", 1795844000001);
    expect(ledger.taskSummary("task1")).toEqual({
      pending_delivery_count: 2,
      last_confirmed_delivery_at_ms: null,
      delivery_receipt_supported: false,
    });
  });

  it("only the exact delivered alert is committed, once, after a notifier receipt", () => {
    const { ledger } = setup();
    ledger.enqueue("task1", 1, [firstEvent], "owned_change", 1795844000000);
    ledger.enqueue("task1", 2, [secondEvent], "direct_mention", 1795844000001);
    const receipt = {
      provider: "trusted_notifier",
      messageId: "published-message-123",
      publishedAtMs: 1795844400000,
    };
    expect(ledger.confirmFromTrustedNotifier(["task1:1"], receipt)).toBe(1);
    expect(ledger.confirmFromTrustedNotifier(["task1:1"], receipt)).toBe(0);
    expect(ledger.pending().map((x) => x.alert_id)).toEqual(["task1:2"]);
    expect(ledger.taskSummary("task1")).toMatchObject({
      pending_delivery_count: 1,
      last_confirmed_delivery_at_ms: receipt.publishedAtMs,
    });
  });

  it("rejects incomplete or fabricated publication evidence", () => {
    const { ledger } = setup();
    ledger.enqueue("task1", 1, [firstEvent], "owned_change", 1795844000000);
    expect(() =>
      ledger.confirmFromTrustedNotifier(["task1:1"], {
        provider: "tool_read",
        messageId: "",
        publishedAtMs: 1795844400000,
      }),
    ).toThrow("ATTENTION_DELIVERY_INVALID");
    expect(() =>
      ledger.confirmFromTrustedNotifier(["task1:1", "task1:1"], {
        provider: "trusted_notifier",
        messageId: "published-message-123",
        publishedAtMs: 1795844400000,
      }),
    ).toThrow("ATTENTION_DELIVERY_INVALID");
    expect(ledger.pending()).toHaveLength(1);
  });
});
