import type { ReadGrant } from "./policy.js";

type Json = Record<string, unknown>;
/** Provider-independent SQL cursor; ClickUp application code does not depend on
 * Cloudflare DurableObjectState types in the MCP-only TypeScript build. */
export type SqlRunner = (
  statement: string,
  ...bindings: (string | number | null)[]
) => { one(): unknown; toArray(): unknown[] };
const object = (value: unknown): Json | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
const taskId = (value: unknown): string | null =>
  (typeof value === "string" || typeof value === "number") &&
  /^[a-zA-Z0-9_-]{1,80}$/.test(String(value))
    ? String(value)
    : null;
const numericId = (value: unknown): string | null =>
  (typeof value === "string" || typeof value === "number") && /^[1-9]\d{0,23}$/.test(String(value))
    ? String(value)
    : null;
const milliseconds = (value: unknown): number =>
  (typeof value === "string" || typeof value === "number") &&
  /^\d{1,16}$/.test(String(value)) &&
  Number.isSafeInteger(Number(value))
    ? Number(value)
    : 0;
const bounded = (value: unknown, max: number): string | null =>
  typeof value === "string" ? value.slice(0, max) : null;

/** Only useful, explicitly selected task fields are copied; never attachments,
 * signed URLs, arbitrary custom-field values, credentials or complete API JSON.
 */
export function projectTaskSnapshot(value: unknown) {
  const task = object(value);
  const id = taskId(task?.["id"]);
  const list = numericId(object(task?.["list"])?.["id"]);
  if (!task || !id || !list || typeof task["name"] !== "string") return null;
  const status = object(task["status"]);
  const assignees = task["assignees"];
  const ids = Array.isArray(assignees)
    ? [
        ...new Set(
          assignees.map((item) => numericId(object(item)?.["id"])).filter((n) => n !== null),
        ),
      ]
    : [];
  const priority = Number(object(task["priority"])?.["id"]);
  const markdown = task["markdown_description"];
  const plain = task["description"] ?? task["text_content"];
  return {
    task_id: id,
    list_id: list,
    title: task["name"].slice(0, 500),
    status: bounded(status?.["status"], 120),
    priority: Number.isInteger(priority) && priority >= 1 && priority <= 4 ? priority : null,
    due_at_ms: milliseconds(task["due_date"]) || null,
    created_at_ms: milliseconds(task["date_created"]) || null,
    source_updated_at_ms: milliseconds(task["date_updated"]),
    closed_at_ms: milliseconds(task["date_closed"]) || null,
    description: bounded(typeof markdown === "string" ? markdown : plain, 40000),
    assignee_ids: ids.slice(0, 100),
  };
}

export function projectCommentSnapshot(value: unknown) {
  const comment = object(value);
  const id = taskId(comment?.["id"]);
  if (!comment || !id) return null;
  const author = numericId(object(comment["user"])?.["id"]);
  const assigned = numericId(object(comment["assignee"])?.["id"]);
  const segments = comment["comment"];
  const mentions = Array.isArray(segments)
    ? [
        ...new Set(
          segments
            .map((segment) => {
              const node = object(segment);
              return node?.["type"] === "tag" ? numericId(object(node["user"])?.["id"]) : null;
            })
            .filter((user) => user !== null),
        ),
      ]
    : [];
  const text = typeof comment["comment_text"] === "string" ? comment["comment_text"] : "";
  return {
    comment_id: id,
    author_id: author,
    source_at_ms: milliseconds(comment["date"]),
    text: text.slice(0, 16000),
    text_truncated: text.length > 16000,
    assigned_to: assigned,
    resolved: comment["resolved"] === true ? true : comment["resolved"] === false ? false : null,
    reply_count: Number.isSafeInteger(comment["reply_count"]) ? comment["reply_count"] : null,
    mentioned_user_ids: mentions.slice(0, 100),
  };
}

export type TaskSnapshot = NonNullable<ReturnType<typeof projectTaskSnapshot>>;
export type CommentSnapshot = NonNullable<ReturnType<typeof projectCommentSnapshot>>;
const validObserved = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/**
 * Persistent index in the SAME actor/Workspace Durable Object as webhook hints.
 * These methods do not establish ClickUp permission: upstream calls must first
 * verify the task using the current user's own ClickUp OAuth credential.
 */
export class TaskIndexStore {
  constructor(
    private readonly run: SqlRunner,
    private readonly transactionSync: (action: () => void) => void = (action) => action(),
  ) {
    run(
      "CREATE TABLE IF NOT EXISTS task_snapshots (task_id TEXT PRIMARY KEY, list_id TEXT NOT NULL, snapshot_json TEXT NOT NULL, source_updated_at INTEGER NOT NULL, observed_at INTEGER NOT NULL)",
    );
    run("CREATE INDEX IF NOT EXISTS task_snapshots_list ON task_snapshots(list_id)");
    run(
      "CREATE TABLE IF NOT EXISTS comment_snapshots (task_id TEXT NOT NULL, comment_id TEXT NOT NULL, snapshot_json TEXT NOT NULL, source_at INTEGER NOT NULL, observed_at INTEGER NOT NULL, PRIMARY KEY(task_id, comment_id))",
    );
    run(
      "CREATE TABLE IF NOT EXISTS task_refresh (task_id TEXT PRIMARY KEY, task_dirty_at INTEGER NOT NULL DEFAULT 0, comments_dirty_at INTEGER NOT NULL DEFAULT 0, task_checked_at INTEGER NOT NULL DEFAULT 0, comments_checked_at INTEGER NOT NULL DEFAULT 0)",
    );
    run(
      "CREATE TABLE IF NOT EXISTS sync_backoff (task_id TEXT PRIMARY KEY, retry_at INTEGER NOT NULL, attempts INTEGER NOT NULL)",
    );
  }

  markDirty(id: string, event: string, at: number): void {
    if (!taskId(id) || !validObserved(at)) throw new Error("INVALID_TASK_HINT");
    const isComment = event === "taskCommentPosted" || event === "taskCommentUpdated";
    this.run(
      "INSERT INTO task_refresh(task_id, task_dirty_at, comments_dirty_at) VALUES (?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET task_dirty_at = MAX(task_refresh.task_dirty_at, excluded.task_dirty_at), comments_dirty_at = MAX(task_refresh.comments_dirty_at, excluded.comments_dirty_at)",
      id,
      isComment ? 0 : at,
      isComment ? at : 0,
    );
    // A fresh, signed change invalidates any earlier retry deferral.
    this.run("DELETE FROM sync_backoff WHERE task_id = ?", id);
  }

  /** Bounded work batch, not a lifetime quota: unprocessed tasks remain durable. */
  dirtyTasks(now: number, limit = 3): Array<{
    task_id: string;
    task_dirty: boolean;
    comments_dirty: boolean;
    attempts: number;
  }> {
    if (!validObserved(now) || !Number.isInteger(limit) || limit < 1 || limit > 25)
      throw new Error("INVALID_SYNC_REQUEST");
    const rows = this.run(
      "SELECT r.task_id, r.task_dirty_at, r.comments_dirty_at, r.task_checked_at, r.comments_checked_at, COALESCE(b.attempts, 0) AS attempts FROM task_refresh r LEFT JOIN sync_backoff b ON r.task_id = b.task_id WHERE (r.task_dirty_at > r.task_checked_at OR r.comments_dirty_at > r.comments_checked_at) AND COALESCE(b.retry_at, 0) <= ? ORDER BY MAX(r.task_dirty_at, r.comments_dirty_at), r.task_id LIMIT ?",
      now,
      limit,
    ).toArray() as Array<{
      task_id: string;
      task_dirty_at: number;
      comments_dirty_at: number;
      task_checked_at: number;
      comments_checked_at: number;
      attempts: number;
    }>;
    return rows.map((row) => ({
      task_id: row.task_id,
      task_dirty: row.task_dirty_at > row.task_checked_at,
      comments_dirty: row.comments_dirty_at > row.comments_checked_at,
      attempts: row.attempts,
    }));
  }

  nextDirtyDue(): number | null {
    const row = this.run(
      "SELECT MIN(COALESCE(b.retry_at, 0)) AS next_due FROM task_refresh r LEFT JOIN sync_backoff b ON r.task_id = b.task_id WHERE r.task_dirty_at > r.task_checked_at OR r.comments_dirty_at > r.comments_checked_at",
    ).one() as { next_due: number | null };
    return row.next_due;
  }

  deferTask(id: string, retryAt: number, attempts: number): void {
    if (!taskId(id) || !validObserved(retryAt) || !Number.isInteger(attempts) || attempts < 1)
      throw new Error("INVALID_SYNC_RETRY");
    this.run(
      "INSERT INTO sync_backoff(task_id, retry_at, attempts) VALUES (?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET retry_at = excluded.retry_at, attempts = excluded.attempts",
      id,
      retryAt,
      attempts,
    );
  }

  clearRetry(id: string): void {
    if (!taskId(id)) throw new Error("INVALID_SYNC_TASK");
    this.run("DELETE FROM sync_backoff WHERE task_id = ?", id);
  }

  /** A task that is no longer authorized must not remain retrievable by future
   * cached-reading tools. The webhook hint history is independent. */
  discardSnapshots(id: string): void {
    if (!taskId(id)) throw new Error("INVALID_SYNC_TASK");
    this.transactionSync(() => {
      this.run("DELETE FROM comment_snapshots WHERE task_id = ?", id);
      this.run("DELETE FROM task_snapshots WHERE task_id = ?", id);
    });
  }

  storeTask(snapshot: TaskSnapshot, observedAt: number): void {
    if (
      !validObserved(observedAt) ||
      !projectTaskSnapshot({
        id: snapshot.task_id,
        list: { id: snapshot.list_id },
        name: snapshot.title,
      })
    )
      throw new Error("INVALID_TASK_SNAPSHOT");
    this.transactionSync(() => {
      // RETURNING identifies whether this read was accepted, not merely
      // attempted. A rejected older source revision must leave dirty state.
      const accepted = this.run(
        "INSERT INTO task_snapshots(task_id, list_id, snapshot_json, source_updated_at, observed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET list_id = excluded.list_id, snapshot_json = excluded.snapshot_json, source_updated_at = excluded.source_updated_at, observed_at = excluded.observed_at WHERE excluded.observed_at >= task_snapshots.observed_at AND excluded.source_updated_at >= task_snapshots.source_updated_at RETURNING task_id",
        snapshot.task_id,
        snapshot.list_id,
        JSON.stringify(snapshot),
        snapshot.source_updated_at_ms,
        observedAt,
      ).toArray();
      if (!accepted.length) return;
      this.run(
        "INSERT INTO task_refresh(task_id, task_checked_at) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET task_checked_at = MAX(task_refresh.task_checked_at, excluded.task_checked_at)",
        snapshot.task_id,
        observedAt,
      );
    });
  }

  storeComments(
    id: string,
    comments: readonly CommentSnapshot[],
    observedAt: number,
    complete: boolean,
  ): void {
    if (!taskId(id) || !validObserved(observedAt) || comments.length > 50)
      throw new Error("INVALID_COMMENT_SNAPSHOT");
    const seen = new Set<string>();
    for (const comment of comments) {
      if (!taskId(comment.comment_id) || seen.has(comment.comment_id))
        throw new Error("INVALID_COMMENT_SNAPSHOT");
      seen.add(comment.comment_id);
    }
    this.transactionSync(() => {
      // A previously completed later scan may have deleted these comments.
      // Reject ALL earlier reads before the UPSERT, including partial pages.
      const prior = this.run(
        "SELECT comments_checked_at FROM task_refresh WHERE task_id = ?",
        id,
      ).toArray()[0] as { comments_checked_at: number } | undefined;
      if ((prior?.comments_checked_at ?? 0) > observedAt) return;
      for (const comment of comments) {
        this.run(
          "INSERT INTO comment_snapshots(task_id, comment_id, snapshot_json, source_at, observed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id, comment_id) DO UPDATE SET snapshot_json = excluded.snapshot_json, source_at = excluded.source_at, observed_at = excluded.observed_at WHERE excluded.observed_at >= comment_snapshots.observed_at",
          id,
          comment.comment_id,
          JSON.stringify(comment),
          comment.source_at_ms,
          observedAt,
        );
      }
      // Partial pages can add unique comments, but never declare the complete
      // collection synchronized or delete anything not visible on that page.
      if (!complete) return;
      const latest = this.run(
        "SELECT MAX(observed_at) AS last_observed FROM comment_snapshots WHERE task_id = ?",
        id,
      ).one() as { last_observed: number | null };
      // A newer complete or partial read may have landed while this scan
      // ran; an older scan must not delete its records or declare them fresh.
      if (
        (prior?.comments_checked_at ?? 0) > observedAt ||
        (latest.last_observed ?? 0) > observedAt
      )
        return;
      if (comments.length) {
        const placeholders = comments.map(() => "?").join(", ");
        this.run(
          "DELETE FROM comment_snapshots WHERE task_id = ? AND observed_at <= ? AND comment_id NOT IN (" +
            placeholders +
            ")",
          id,
          observedAt,
          ...comments.map((comment) => comment.comment_id),
        );
      } else
        this.run(
          "DELETE FROM comment_snapshots WHERE task_id = ? AND observed_at <= ?",
          id,
          observedAt,
        );
      this.run(
        "INSERT INTO task_refresh(task_id, comments_checked_at) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET comments_checked_at = MAX(task_refresh.comments_checked_at, excluded.comments_checked_at)",
        id,
        observedAt,
      );
    });
  }

  diagnostics(): Json {
    const tasks = this.run("SELECT COUNT(*) AS count FROM task_snapshots").one() as {
      count: number;
    };
    const comments = this.run("SELECT COUNT(*) AS count FROM comment_snapshots").one() as {
      count: number;
    };
    const dirty = this.run(
      "SELECT COUNT(CASE WHEN task_dirty_at > task_checked_at THEN 1 END) AS tasks, COUNT(CASE WHEN comments_dirty_at > comments_checked_at THEN 1 END) AS comments FROM task_refresh",
    ).one() as { tasks: number; comments: number };
    return {
      indexed_tasks: tasks.count,
      indexed_comments: comments.count,
      task_refresh_pending: dirty.tasks,
      comment_refresh_pending: dirty.comments,
    };
  }

  lookup(id: string): Json | null {
    if (!taskId(id)) return null;
    const rows = this.run(
      "SELECT snapshot_json, observed_at FROM task_snapshots WHERE task_id = ?",
      id,
    ).toArray() as Array<{ snapshot_json: string; observed_at: number }>;
    const row = rows[0];
    if (!row) return null;
    const refresh = this.run(
      "SELECT task_dirty_at, comments_dirty_at, task_checked_at, comments_checked_at FROM task_refresh WHERE task_id = ?",
      id,
    ).toArray()[0] as
      | {
          task_dirty_at: number;
          comments_dirty_at: number;
          task_checked_at: number;
          comments_checked_at: number;
        }
      | undefined;
    return {
      task: JSON.parse(row.snapshot_json) as unknown,
      observed_at_ms: row.observed_at,
      task_stale: Boolean(refresh && refresh.task_dirty_at > refresh.task_checked_at),
      comments_stale: Boolean(refresh && refresh.comments_dirty_at > refresh.comments_checked_at),
    };
  }
}

/** Best effort: failure to update the private index must not falsify or
 * prevent an otherwise successful authoritative ClickUp read. */
async function writeIndex(
  grant: ReadGrant,
  path: "/index/task" | "/index/comments",
  body: Json,
): Promise<boolean> {
  if (!grant.taskIndex) return false;
  try {
    const binding = grant.taskIndex;
    const stub = binding.get(binding.idFromName(grant.workspaceId + ":" + grant.subject) as never);
    const result = await stub.fetch(
      new Request("https://internal" + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return result.ok;
  } catch {
    return false;
  }
}

export async function captureVerifiedTask(
  grant: ReadGrant,
  verified: unknown,
  observedAt: number,
): Promise<boolean> {
  const snapshot = projectTaskSnapshot(verified);
  if (!snapshot) return false;
  if (grant.resourceScope !== "workspace" && snapshot.list_id !== grant.listId) return false;
  return writeIndex(grant, "/index/task", { snapshot, observed_at: observedAt });
}

export async function captureVerifiedComments(
  grant: ReadGrant,
  verified: unknown,
  rawComments: unknown,
  observedAt: number,
  complete: boolean,
): Promise<boolean> {
  const snapshot = projectTaskSnapshot(verified);
  if (!snapshot || !Array.isArray(rawComments) || rawComments.length > 50) return false;
  if (grant.resourceScope !== "workspace" && snapshot.list_id !== grant.listId) return false;
  const comments = rawComments.map(projectCommentSnapshot);
  if (comments.some((item) => item === null)) return false;
  return writeIndex(grant, "/index/comments", {
    task_id: snapshot.task_id,
    comments,
    observed_at: observedAt,
    complete,
  });
}
