import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { FollowupLedger, FollowupLedgerError } from "../src/clickup/followup-ledger.js";

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
  const create = () =>
    new FollowupLedger(run, (action) => {
      db.exec("BEGIN");
      try {
        action();
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  return { db, create };
}

const first = {
  task_id: "task123",
  action_key: "comment:1500260000111534",
  action_kind: "instruction_sent",
  state_after: "awaiting_response",
  expected_revision: 0,
  note: "Verified instruction, waiting on buyer",
  evidence_comment_id: "1500260000111534",
  waiting_on_user_id: "74509112",
  next_check_at_ms: 1795800000000,
};

describe("append-only actor-local follow-up ledger with real SQLite", () => {
  const open: DatabaseSync[] = [];
  afterEach(() => {
    for (const db of open.splice(0)) db.close();
  });
  const make = () => {
    const value = fixture();
    open.push(value.db);
    return value;
  };

  it("records an action and its current obligation atomically", () => {
    const ledger = make().create();
    expect(ledger.read("task123").state).toBeNull();
    expect(ledger.record(first, 1795680000000)).toMatchObject({
      task_id: "task123",
      revision: 1,
      replayed: false,
      state: { state: "awaiting_response", waiting_on_user_id: "74509112", revision: 1 },
    });
    expect(ledger.read("task123")).toMatchObject({
      state: { state: "awaiting_response", next_check_at_ms: 1795800000000 },
      history: [{ action_key: "comment:1500260000111534", revision: 1 }],
      incomplete: false,
    });
    expect(ledger.dueTaskIds(1795800000000)).toEqual(["task123"]);
  });

  it("returns the identical action on replay without a new revision", () => {
    const ledger = make().create();
    ledger.record(first, 1795680000000);
    expect(ledger.record(first, 1795690000000)).toMatchObject({
      revision: 1,
      replayed: true,
    });
    expect(ledger.read("task123").history).toHaveLength(1);
    const receipt = ledger.receipt("task123", first.action_key);
    expect(receipt).toMatchObject({
      task_id: "task123",
      action_key: first.action_key,
      revision: 1,
    });
    expect(JSON.parse(receipt!.request_json)).toMatchObject({
      action_kind: "instruction_sent",
      evidence_comment_id: "1500260000111534",
      expected_revision: 0,
    });
    expect(() =>
      ledger.record({ ...first, note: "conflicting claim" }, 1795690000001),
    ).toThrowError(FollowupLedgerError);
  });

  it("rejects stale competing revisions and preserves the earlier write", () => {
    const ledger = make().create();
    ledger.record(first, 1795680000000);
    expect(() =>
      ledger.record(
        {
          ...first,
          action_key: "manual:second",
          action_kind: "note",
          state_after: "action_required",
          evidence_comment_id: null,
          expected_revision: 0,
        },
        1795680000001,
      ),
    ).toThrowError(FollowupLedgerError);
    expect(ledger.read("task123").state?.["state"]).toBe("awaiting_response");
    expect(ledger.read("task123").history).toHaveLength(1);
  });

  it("persists records across object re-instantiation and pages history", () => {
    const { create } = make();
    const ledger = create();
    ledger.record(first, 1795680000000);
    const newer = {
      task_id: "task123",
      action_key: "check:2",
      action_kind: "followup_checked",
      state_after: "awaiting_response",
      expected_revision: 1,
      note: "No newer supplier reply",
    };
    ledger.record(newer, 1795681000000);
    const afterRestart = create();
    const newest = afterRestart.read("task123", 1);
    expect(newest.history).toMatchObject([{ action_key: "check:2", revision: 2 }]);
    expect(newest.next_before_revision).toBe(2);
    expect(newest.incomplete).toBe(true);
    const older = afterRestart.read("task123", 1, newest.next_before_revision!);
    expect(older.history).toMatchObject([{ action_key: first.action_key, revision: 1 }]);
    expect(older.incomplete).toBe(false);
  });

  it("keeps due status independent of resolved or future obligations", () => {
    const ledger = make().create();
    ledger.record(first, 1795680000000);
    ledger.record(
      {
        task_id: "task123",
        action_key: "resolve:3",
        action_kind: "resolution_confirmed",
        state_after: "resolved",
        expected_revision: 1,
        next_check_at_ms: 1795000000000,
      },
      1795681000000,
    );
    expect(ledger.dueTaskIds(1795900000000)).toEqual([]);
  });

  it("rejects unverified sent designations, malformed IDs and oversized notes", () => {
    const ledger = make().create();
    expect(() =>
      ledger.record(
        {
          ...first,
          evidence_comment_id: null,
        },
        1795680000000,
      ),
    ).toThrowError(FollowupLedgerError);
    expect(() =>
      ledger.record(
        {
          ...first,
          task_id: "../another-actor",
        },
        1795680000000,
      ),
    ).toThrowError(FollowupLedgerError);
    expect(() =>
      ledger.record(
        {
          ...first,
          note: "x".repeat(2001),
        },
        1795680000000,
      ),
    ).toThrowError(FollowupLedgerError);
    expect(ledger.read("task123").state).toBeNull();
  });
});
