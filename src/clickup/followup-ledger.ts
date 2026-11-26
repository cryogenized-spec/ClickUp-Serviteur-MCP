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
    // Short-lived, cryptographically random continuation handles; never
    // expose private task IDs or keyset dates through a model-facing cursor.
    run(
      "CREATE TABLE IF NOT EXISTS followup_due_cursors (token TEXT PRIMARY KEY, cutoff_ms INTEGER NOT NULL, scope_key TEXT NOT NULL, after_due_ms INTEGER NOT NULL, after_task_id TEXT NOT NULL, expires_at_ms INTEGER NOT NULL)",
    );
    run(
      "CREATE INDEX IF NOT EXISTS followup_due_cursor_expiry ON followup_due_cursors(expires_at_ms)",
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

  /** Existing exact-key receipt for safe retries after an uncertain response.
   * This private result does not confer task authorization or create actions.
   * The MCP adapter must reverify live task access before looking it up. */
  receipt(
    task: string,
    actionKey: string,
  ): {
    task_id: string;
    action_key: string;
    revision: number;
    request_json: string;
  } | null {
    if (!taskId(task) || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(actionKey))
      throw new FollowupLedgerError("invalid");
    const found = this.run(
      "SELECT revision, request_json FROM followup_actions WHERE task_id = ? AND action_key = ?",
      task,
      actionKey,
    ).toArray()[0] as { revision: number; request_json: string } | undefined;
    return found
      ? {
          task_id: task,
          action_key: actionKey,
          revision: found.revision,
          request_json: found.request_json,
        }
      : null;
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

  /**
   * Private keyset-paginated due candidates. Never forward rows directly:
   * every task must pass a fresh user-OAuth ClickUp task + parent-list preflight.
   * A due cutoff is carried across pages; this is still a live view, not a
   * durable snapshot or webhook checkpoint.
   */
  dueCandidates(
    at: number,
    limit = 20,
    afterDueMs?: number,
    afterTaskId?: string,
  ): {
    candidates: Array<{
      task_id: string;
      state: string;
      waiting_on_user_id: string | null;
      next_check_at_ms: number;
      revision: number;
    }>;
    incomplete: boolean;
    next_after_due_ms: number | null;
    next_after_task_id: string | null;
  } {
    if (
      !Number.isSafeInteger(at) ||
      at < 0 ||
      at > 9_000_000_000_000 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      (afterDueMs === undefined) !== (afterTaskId === undefined) ||
      (afterDueMs !== undefined &&
        (!Number.isSafeInteger(afterDueMs) || afterDueMs < 0 || afterDueMs > at)) ||
      (afterTaskId !== undefined && !taskId(afterTaskId))
    )
      throw new FollowupLedgerError("invalid");

    const cursorDue = afterDueMs ?? 0;
    const cursorTask = afterTaskId ?? "";
    const rows = this.run(
      "SELECT task_id, state, waiting_on_user_id, next_check_at_ms, revision FROM followup_current WHERE next_check_at_ms IS NOT NULL AND next_check_at_ms <= ? AND state != 'resolved' AND (next_check_at_ms > ? OR (next_check_at_ms = ? AND task_id > ?)) ORDER BY next_check_at_ms, task_id LIMIT ?",
      at,
      cursorDue,
      cursorDue,
      cursorTask,
      limit + 1,
    ).toArray() as Array<{
      task_id: string;
      state: string;
      waiting_on_user_id: string | null;
      next_check_at_ms: number;
      revision: number;
    }>;
    const incomplete = rows.length > limit;
    const candidates = rows.slice(0, limit);
    const last = candidates[candidates.length - 1];
    return {
      candidates,
      incomplete,
      next_after_due_ms: incomplete && last ? last.next_check_at_ms : null,
      next_after_task_id: incomplete && last ? last.task_id : null,
    };
  }

  /** A random, actor-local cursor is a private SQLite lookup capability,
   * not a serialized task ID or an unsigned, editable keyset. All callers
   * must still revalidate every returned candidate through live ClickUp.
   */
  issueDueCursor(
    cutoff: number,
    scopeKey: string,
    afterDue: number,
    afterTask: string,
    now: number,
  ): string {
    if (
      !Number.isSafeInteger(cutoff) ||
      cutoff < 0 ||
      cutoff > 9_000_000_000_000 ||
      !/^[a-zA-Z0-9:_-]{1,160}$/.test(scopeKey) ||
      !Number.isSafeInteger(afterDue) ||
      afterDue < 0 ||
      afterDue > cutoff ||
      !taskId(afterTask) ||
      !Number.isSafeInteger(now) ||
      now <= 0
    )
      throw new FollowupLedgerError("invalid");
    const token = crypto.randomUUID();
    this.run("DELETE FROM followup_due_cursors WHERE expires_at_ms < ?", now);
    this.run(
      "INSERT INTO followup_due_cursors(token, cutoff_ms, scope_key, after_due_ms, after_task_id, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
      token,
      cutoff,
      scopeKey,
      afterDue,
      afterTask,
      now + 24 * 60 * 60 * 1000,
    );
    return token;
  }

  resolveDueCursor(
    token: string,
    cutoff: number,
    scopeKey: string,
    now: number,
  ): { after_due_ms: number; after_task_id: string } {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(token) ||
      !Number.isSafeInteger(cutoff) ||
      cutoff < 0 ||
      cutoff > 9_000_000_000_000 ||
      !/^[a-zA-Z0-9:_-]{1,160}$/.test(scopeKey) ||
      !Number.isSafeInteger(now) ||
      now <= 0
    )
      throw new FollowupLedgerError("invalid");
    const row = this.run(
      "SELECT cutoff_ms, scope_key, after_due_ms, after_task_id FROM followup_due_cursors WHERE token = ? AND expires_at_ms >= ?",
      token,
      now,
    ).toArray()[0] as
      | {
          cutoff_ms: number;
          scope_key: string;
          after_due_ms: number;
          after_task_id: string;
        }
      | undefined;
    // An old/tampered token, changed cutoff or changed authorization filter
    // must never silently restart the scan from the beginning.
    if (!row || row.cutoff_ms !== cutoff || row.scope_key !== scopeKey)
      throw new FollowupLedgerError("invalid");
    return { after_due_ms: row.after_due_ms, after_task_id: row.after_task_id };
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
