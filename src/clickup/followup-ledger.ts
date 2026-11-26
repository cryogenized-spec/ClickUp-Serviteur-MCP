import type { SqlRunner } from "./task-index.js";

/** A human/agent-curated obligation, not a substitute for current ClickUp task state.
 * The containing Durable Object is already partitioned by OAuth actor + Workspace.
 */
const states = new Set([
  "detected",
  "verified",
  "action_required",
  "action_taken",
  "awaiting_response",
  "response_received",
  "resolved",
]);
const kinds = new Set([
  "observation",
  "draft_prepared",
  "instruction_sent",
  "response_received",
  "followup_checked",
  "resolution_confirmed",
  "note",
]);

type Row = Record<string, unknown>;
const taskId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const userId = (value: unknown): value is string =>
  typeof value === "string" && /^[1-9]\d{0,23}$/.test(value);
const optionalTime = (value: unknown): value is number | null =>
  value === null ||
  (typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 9_000_000_000_000);

export interface FollowupWrite {
  task_id: string;
  action_key: string;
  action_kind: string;
  state_after: string;
  expected_revision: number;
  note?: string | null;
  evidence_comment_id?: string | null;
  waiting_on_user_id?: string | null;
  next_check_at_ms?: number | null;
}

export class FollowupLedgerError extends Error {
  constructor(readonly code: "invalid" | "conflict") {
    super(code);
  }
}

/** All rows are private. Write operations are transactionally append-only;
 * state is a materialized projection of the latest action. */
export class FollowupLedger {
  constructor(
    private readonly run: SqlRunner,
    private readonly transactionSync: (action: () => void) => void,
  ) {
    run(
      "CREATE TABLE IF NOT EXISTS followup_current (task_id TEXT PRIMARY KEY, state TEXT NOT NULL, waiting_on_user_id TEXT, next_check_at_ms INTEGER, revision INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL)",
    );
    run("CREATE INDEX IF NOT EXISTS followup_due ON followup_current(next_check_at_ms, state)");
    run(
      "CREATE TABLE IF NOT EXISTS followup_actions (task_id TEXT NOT NULL, action_key TEXT NOT NULL, revision INTEGER NOT NULL, action_kind TEXT NOT NULL, state_after TEXT NOT NULL, note TEXT, evidence_comment_id TEXT, waiting_on_user_id TEXT, next_check_at_ms INTEGER, recorded_at_ms INTEGER NOT NULL, request_json TEXT NOT NULL, PRIMARY KEY(task_id, action_key), UNIQUE(task_id, revision))",
    );
    run(
      "CREATE INDEX IF NOT EXISTS followup_task_history ON followup_actions(task_id, revision DESC)",
    );
  }

  /** Explicit, optimistic revision prevents concurrent agents from overwriting
   * each other's follow-up state. An exact action_key replay is idempotent. */
  record(
    value: unknown,
    now: number,
  ): {
    task_id: string;
    revision: number;
    replayed: boolean;
    state: Row;
  } {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new FollowupLedgerError("invalid");
    const a = value as Record<string, unknown>;
    if (
      !taskId(a["task_id"]) ||
      typeof a["action_key"] !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(a["action_key"]) ||
      typeof a["action_kind"] !== "string" ||
      !kinds.has(a["action_kind"]) ||
      typeof a["state_after"] !== "string" ||
      !states.has(a["state_after"]) ||
      !Number.isSafeInteger(a["expected_revision"]) ||
      Number(a["expected_revision"]) < 0 ||
      Number(a["expected_revision"]) > 1_000_000_000 ||
      (a["note"] !== undefined &&
        a["note"] !== null &&
        (typeof a["note"] !== "string" || a["note"].length > 2000)) ||
      (a["evidence_comment_id"] !== undefined &&
        a["evidence_comment_id"] !== null &&
        (typeof a["evidence_comment_id"] !== "string" ||
          !/^[a-zA-Z0-9_-]{1,100}$/.test(a["evidence_comment_id"]))) ||
      (a["waiting_on_user_id"] !== undefined &&
        a["waiting_on_user_id"] !== null &&
        !userId(a["waiting_on_user_id"])) ||
      (a["next_check_at_ms"] !== undefined && !optionalTime(a["next_check_at_ms"])) ||
      !Number.isSafeInteger(now) ||
      now <= 0
    )
      throw new FollowupLedgerError("invalid");

    // The "sent" designation must always have a concrete comment reference.
    // The MCP adapter independently verifies it against current ClickUp.
    if (a["action_kind"] === "instruction_sent" && !a["evidence_comment_id"])
      throw new FollowupLedgerError("invalid");

    const item = {
      task_id: a["task_id"] as string,
      action_key: a["action_key"] as string,
      action_kind: a["action_kind"] as string,
      state_after: a["state_after"] as string,
      expected_revision: a["expected_revision"] as number,
      note: (a["note"] ?? null) as string | null,
      evidence_comment_id: (a["evidence_comment_id"] ?? null) as string | null,
      waiting_on_user_id: (a["waiting_on_user_id"] ?? null) as string | null,
      next_check_at_ms: (a["next_check_at_ms"] ?? null) as number | null,
    };
    const requestJson = JSON.stringify(item);
    let revision = 0;
    let replayed = false;
    this.transactionSync(() => {
      const old = this.run(
        "SELECT revision, request_json FROM followup_actions WHERE task_id = ? AND action_key = ?",
        item.task_id,
        item.action_key,
      ).toArray()[0] as Row | undefined;
      if (old) {
        if (old["request_json"] !== requestJson) throw new FollowupLedgerError("conflict");
        replayed = true;
        revision = Number(old["revision"]);
        return;
      }
      const current = this.run(
        "SELECT revision FROM followup_current WHERE task_id = ?",
        item.task_id,
      ).toArray()[0] as Row | undefined;
      const previous = current ? Number(current["revision"]) : 0;
      if (previous !== item.expected_revision) throw new FollowupLedgerError("conflict");
      revision = previous + 1;
      this.run(
        "INSERT INTO followup_actions (task_id, action_key, revision, action_kind, state_after, note, evidence_comment_id, waiting_on_user_id, next_check_at_ms, recorded_at_ms, request_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        item.task_id,
        item.action_key,
        revision,
        item.action_kind,
        item.state_after,
        item.note,
        item.evidence_comment_id,
        item.waiting_on_user_id,
        item.next_check_at_ms,
        now,
        requestJson,
      );
      this.run(
        "INSERT INTO followup_current (task_id, state, waiting_on_user_id, next_check_at_ms, revision, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET state = excluded.state, waiting_on_user_id = excluded.waiting_on_user_id, next_check_at_ms = excluded.next_check_at_ms, revision = excluded.revision, updated_at_ms = excluded.updated_at_ms",
        item.task_id,
        item.state_after,
        item.waiting_on_user_id,
        item.next_check_at_ms,
        revision,
        now,
      );
    });
    const state = this.run(
      "SELECT state, waiting_on_user_id, next_check_at_ms, revision, updated_at_ms FROM followup_current WHERE task_id = ?",
      item.task_id,
    ).toArray()[0] as Row;
    return { task_id: item.task_id, revision, replayed, state };
  }

  read(
    task: string,
    limit = 20,
    beforeRevision?: number,
  ): {
    task_id: string;
    state: Row | null;
    history: Row[];
    incomplete: boolean;
    next_before_revision: number | null;
  } {
    if (
      !taskId(task) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      (beforeRevision !== undefined &&
        (!Number.isSafeInteger(beforeRevision) || beforeRevision <= 0))
    )
      throw new FollowupLedgerError("invalid");
    const state =
      (this.run(
        "SELECT state, waiting_on_user_id, next_check_at_ms, revision, updated_at_ms FROM followup_current WHERE task_id = ?",
        task,
      ).toArray()[0] as Row | undefined) ?? null;
    const rows = (
      beforeRevision === undefined
        ? this.run(
            "SELECT action_key, action_kind, state_after, revision, note, evidence_comment_id, waiting_on_user_id, next_check_at_ms, recorded_at_ms FROM followup_actions WHERE task_id = ? ORDER BY revision DESC LIMIT ?",
            task,
            limit + 1,
          )
        : this.run(
            "SELECT action_key, action_kind, state_after, revision, note, evidence_comment_id, waiting_on_user_id, next_check_at_ms, recorded_at_ms FROM followup_actions WHERE task_id = ? AND revision < ? ORDER BY revision DESC LIMIT ?",
            task,
            beforeRevision,
            limit + 1,
          )
    ).toArray() as Row[];
    const history = rows.slice(0, limit);
    const incomplete = rows.length > limit;
    return {
      task_id: task,
      state,
      history,
      incomplete,
      next_before_revision: incomplete ? Number(history[history.length - 1]!["revision"]) : null,
    };
  }

  /** Private, offset-paginated candidate IDs. This is never directly exposed to
   * the model: current task authorization MUST be reverified for each ID. Offset
   * pagination is a best-effort live view, not a durable activity checkpoint. */
  dueTaskPage(
    at: number,
    limit = 20,
    offset = 0,
  ): { task_ids: string[]; incomplete: boolean; next_offset: number | null } {
    if (
      !Number.isSafeInteger(at) ||
      at < 0 ||
      at > 9_000_000_000_000 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 100_000_000
    ) throw new FollowupLedgerError("invalid");
    const ids = (this.run(
      "SELECT task_id FROM followup_current WHERE next_check_at_ms IS NOT NULL AND next_check_at_ms <= ? AND state != 'resolved' ORDER BY next_check_at_ms, task_id LIMIT ? OFFSET ?",
      at,
      limit + 1,
      offset,
    ).toArray() as Array<{ task_id: string }>).map((row) => row.task_id);
    const incomplete = ids.length > limit;
    return {
      task_ids: ids.slice(0, limit),
      incomplete,
      next_offset: incomplete ? offset + limit : null,
    };
  }

  /** Candidate IDs only. Each item MUST be re-authorized by an upstream
   * ClickUp task GET before returning any details to an MCP consumer. */
  dueTaskIds(at: number, limit = 20): string[] {
    if (!Number.isSafeInteger(at) || !Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new FollowupLedgerError("invalid");
    return (
      this.run(
        "SELECT task_id FROM followup_current WHERE next_check_at_ms IS NOT NULL AND next_check_at_ms <= ? AND state != 'resolved' ORDER BY next_check_at_ms, task_id LIMIT ?",
        at,
        limit,
      ).toArray() as Array<{ task_id: string }>
    ).map((row) => row.task_id);
  }
}
