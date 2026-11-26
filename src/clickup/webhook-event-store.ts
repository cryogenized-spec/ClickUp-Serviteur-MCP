import type { OAuthEnv } from "../auth/env.js";
import { FollowupLedger, FollowupLedgerError } from "./followup-ledger.js";
import { grantForSignedWebhook, retryDelayMs, synchronizeDirtyTask } from "./task-index-sync.js";
import {
  projectCommentSnapshot,
  projectTaskDiscovery,
  projectTaskSnapshot,
  TaskIndexStore,
  type CommentSnapshot,
} from "./task-index.js";
import {
  sanitizeWebhookMetadata,
  validActivityConsumer,
  type WebhookHint,
} from "./webhook-ingress.js";

const WEEK = 7 * 24 * 60 * 60 * 1000;

/** Internal binding only. Partition by approved Workspace and authenticated actor. */
export class ClickUpWebhookEvents {
  private readonly taskIndex: TaskIndexStore;
  private readonly followups: FollowupLedger;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: OAuthEnv,
  ) {
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS hints (event_key TEXT PRIMARY KEY, task_id TEXT NOT NULL, event TEXT NOT NULL, received_at INTEGER NOT NULL)",
    );
    state.storage.sql.exec("CREATE INDEX IF NOT EXISTS hints_received ON hints(received_at)");
    state.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS hints_identity ON hints(task_id, event, substr(event_key, 38))",
    );
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS consumer_processed (consumer TEXT NOT NULL, event_key TEXT NOT NULL, processed_at INTEGER NOT NULL, PRIMARY KEY(consumer, event_key))",
    );
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS hint_metadata (event_key TEXT PRIMARY KEY, metadata TEXT NOT NULL)",
    );
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS reviewed (event_key TEXT PRIMARY KEY, acknowledged_at INTEGER NOT NULL)",
    );
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS sync_owner (id INTEGER PRIMARY KEY CHECK(id = 1), workspace_id TEXT NOT NULL, subject TEXT NOT NULL)",
    );
    this.taskIndex = new TaskIndexStore(
      (statement, ...bindings) => state.storage.sql.exec(statement, ...bindings),
      (action) => state.storage.transactionSync(action),
    );
    this.followups = new FollowupLedger(
      (statement, ...bindings) => state.storage.sql.exec(statement, ...bindings),
      (action) => state.storage.transactionSync(action),
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    // Actor/Workspace-private RPCs. The MCP caller must first reverify current
    // ClickUp task access with this individual OAuth actor; never expose these
    // routes on the public Worker router.
    if (request.method === "GET" && path === "/followups/task") {
      const taskId = url.searchParams.get("task_id") ?? "";
      const limitRaw = url.searchParams.get("limit") ?? "20";
      const beforeRaw = url.searchParams.get("before_revision");
      if (!/^[1-9]\d?$/.test(limitRaw) || (beforeRaw !== null && !/^[1-9]\d{0,9}$/.test(beforeRaw)))
        return new Response(null, { status: 400 });
      try {
        const value = this.followups.read(
          taskId,
          Number(limitRaw),
          beforeRaw === null ? undefined : Number(beforeRaw),
        );
        return Response.json(value, { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        if (error instanceof FollowupLedgerError) return new Response(null, { status: 400 });
        throw error;
      }
    }
    if (request.method === "GET" && path === "/followups/due") {
      // Only the private Durable Object returns these raw actor-local rows.
      // The MCP adapter must independently verify each task's current ClickUp
      // permissions before disclosing any item or associated metadata.
      const cutoff = url.searchParams.get("cutoff_ms");
      const limit = url.searchParams.get("limit") ?? "20";
      const afterDue = url.searchParams.get("after_due_ms");
      const afterTask = url.searchParams.get("after_task_id");
      if (
        cutoff === null ||
        !/^\d{1,13}$/.test(cutoff) ||
        !/^(?:[1-9]|[1-4]\d|50)$/.test(limit) ||
        (afterDue === null) !== (afterTask === null) ||
        (afterDue !== null && !/^\d{1,13}$/.test(afterDue))
      ) return new Response(null, { status: 400 });
      try {
        const page = this.followups.dueCandidates(
          Number(cutoff),
          Number(limit),
          afterDue === null ? undefined : Number(afterDue),
          afterTask === null ? undefined : afterTask,
        );
        return Response.json(page, { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        if (error instanceof FollowupLedgerError)
          return new Response(null, { status: 400 });
        throw error;
      }
    }
    if (request.method === "GET" && path === "/followups/receipt") {
      const taskId = url.searchParams.get("task_id") ?? "";
      const actionKey = url.searchParams.get("action_key") ?? "";
      try {
        const receipt = this.followups.receipt(taskId, actionKey);
        return Response.json({ receipt }, { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        if (error instanceof FollowupLedgerError) return new Response(null, { status: 400 });
        throw error;
      }
    }
    if (request.method === "POST" && path === "/followups/record") {
      const value: unknown = await request.json().catch(() => null);
      try {
        const result = this.followups.record(value, Date.now());
        return Response.json(result, { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        if (error instanceof FollowupLedgerError)
          return new Response(null, { status: error.code === "conflict" ? 409 : 400 });
        throw error;
      }
    }
    if (path === "/registry") return this.registry(request);
    // These endpoints are private Durable Object RPCs, never public Worker routes.
    // The caller must have completed its own ClickUp OAuth task verification.
    if (request.method === "POST" && path === "/index/discovery") {
      const raw: unknown = await request.json().catch(() => null);
      const data =
        raw !== null && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : null;
      const rows = data?.["tasks"];
      const at = data?.["observed_at"];
      if (
        !Array.isArray(rows) ||
        rows.length < 1 ||
        rows.length > 50 ||
        typeof at !== "number" ||
        !Number.isSafeInteger(at) ||
        at <= 0
      )
        return new Response(null, { status: 400 });
      const discovered = rows.map((value: unknown) => {
        const row =
          value !== null && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : null;
        return projectTaskDiscovery({
          id: row?.["task_id"],
          list: { id: row?.["list_id"] },
          date_updated: row?.["source_updated_at_ms"],
        });
      });
      if (discovered.some((item) => item === null)) return new Response(null, { status: 400 });
      const typed = discovered.filter((item): item is NonNullable<typeof item> => item !== null);
      const result = this.taskIndex.observeDiscoveredTasks(typed, at);
      // A successful discovery should schedule already-existing native DO
      // autosync work; it must not spawn a second Worker or queue.
      if (result.enqueued > 0) await this.scheduleAlarm(Date.now());
      return Response.json(result);
    }
    if (request.method === "POST" && path === "/index/task") {
      const raw: unknown = await request.json().catch(() => null);
      const args =
        raw !== null && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : null;
      const input = args?.["snapshot"];
      const item =
        input !== null && typeof input === "object" && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : null;
      const observed = args?.["observed_at"];
      if (!item || typeof observed !== "number" || !Number.isSafeInteger(observed) || observed <= 0)
        return new Response(null, { status: 400 });
      const snapshot = projectTaskSnapshot({
        id: item["task_id"],
        name: item["title"],
        list: { id: item["list_id"] },
        status: { status: item["status"] },
        priority: { id: item["priority"] },
        due_date: item["due_at_ms"],
        date_created: item["created_at_ms"],
        date_updated: item["source_updated_at_ms"],
        date_closed: item["closed_at_ms"],
        markdown_description: item["description"],
        assignees: Array.isArray(item["assignee_ids"])
          ? item["assignee_ids"].map((id) => ({ id }))
          : [],
      });
      if (!snapshot) return new Response(null, { status: 400 });
      this.taskIndex.storeTask(snapshot, observed);
      return Response.json({ indexed: true });
    }
    if (request.method === "POST" && path === "/index/comments") {
      const raw: unknown = await request.json().catch(() => null);
      const args =
        raw !== null && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : null;
      const id = args?.["task_id"];
      const observed = args?.["observed_at"];
      const entries = args?.["comments"];
      if (
        typeof id !== "string" ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(id) ||
        typeof observed !== "number" ||
        !Number.isSafeInteger(observed) ||
        observed <= 0 ||
        !Array.isArray(entries) ||
        entries.length > 50 ||
        typeof args?.["complete"] !== "boolean"
      )
        return new Response(null, { status: 400 });
      const comments: CommentSnapshot[] = [];
      for (const value of entries) {
        if (value === null || typeof value !== "object" || Array.isArray(value))
          return new Response(null, { status: 400 });
        const item = value as Record<string, unknown>;
        const projected = projectCommentSnapshot({
          id: item["comment_id"],
          user: { id: item["author_id"] },
          assignee: { id: item["assigned_to"] },
          date: item["source_at_ms"],
          comment_text: item["text"],
          resolved: item["resolved"],
          reply_count: item["reply_count"],
          comment: Array.isArray(item["mentioned_user_ids"])
            ? item["mentioned_user_ids"].map((id) => ({ type: "tag", user: { id } }))
            : [],
        });
        if (!projected) return new Response(null, { status: 400 });
        comments.push({ ...projected, text_truncated: item["text_truncated"] === true });
      }
      this.taskIndex.storeComments(id, comments, observed, args["complete"]);
      return Response.json({ indexed: comments.length });
    }
    if (request.method === "GET" && path === "/index/task") {
      const id = url.searchParams.get("task_id");
      if (!id || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) return new Response(null, { status: 400 });
      const indexed = this.taskIndex.lookup(id);
      return indexed ? Response.json(indexed) : new Response(null, { status: 404 });
    }
    if (request.method === "GET" && path === "/pending") {
      const since = url.searchParams.get("after_time");
      const key = url.searchParams.get("after_key");
      const consumer = url.searchParams.get("consumer");
      if (
        (consumer !== null && !validActivityConsumer(consumer)) ||
        (since === null) !== (key === null) ||
        (since !== null && (!/^\d{1,16}$/.test(since) || !Number.isSafeInteger(Number(since)))) ||
        (key !== null && !/^[a-f0-9-]{36}:[a-zA-Z0-9_-]{1,100}$/i.test(key))
      )
        return new Response(null, { status: 400 });
      const rows = this.state.storage.sql
        .exec<{
          event_key: string;
          task_id: string;
          event: string;
          received_at: number;
          metadata_json: string | null;
        }>(
          consumer === null
            ? "SELECT h.event_key, h.task_id, h.event, h.received_at, m.metadata AS metadata_json FROM hints h LEFT JOIN hint_metadata m ON h.event_key = m.event_key LEFT JOIN reviewed r ON h.event_key = r.event_key WHERE r.event_key IS NULL AND h.received_at >= ? AND (h.received_at > ? OR (h.received_at = ? AND h.event_key > ?)) ORDER BY h.received_at, h.event_key LIMIT 11"
            : "SELECT h.event_key, h.task_id, h.event, h.received_at, m.metadata AS metadata_json FROM hints h LEFT JOIN hint_metadata m ON h.event_key = m.event_key LEFT JOIN consumer_processed p ON h.event_key = p.event_key AND p.consumer = ? WHERE p.event_key IS NULL AND h.received_at >= ? AND (h.received_at > ? OR (h.received_at = ? AND h.event_key > ?)) ORDER BY h.received_at, h.event_key LIMIT 11",
          ...(consumer === null ? [] : [consumer]),
          Date.now() - WEEK,
          Number(since ?? 0),
          Number(since ?? 0),
          key ?? "",
        )
        .toArray();
      const events = rows.slice(0, 10).map(({ metadata_json, ...row }) => {
        let metadata = {};
        if (metadata_json) {
          try {
            metadata = sanitizeWebhookMetadata(JSON.parse(metadata_json));
          } catch {
            // Old or invalid metadata is not a reason to discard the base event.
          }
        }
        return { ...row, ...(Object.keys(metadata).length ? { metadata } : {}) };
      });
      return Response.json({ events, incomplete: rows.length > 10 });
    }
    if (request.method === "GET" && path === "/task-timeline") {
      const taskId = url.searchParams.get("task_id");
      if (!taskId || !/^[a-zA-Z0-9_-]{1,80}$/.test(taskId))
        return new Response(null, { status: 400 });
      const rows = this.state.storage.sql
        .exec<{
          event_key: string;
          event: string;
          received_at: number;
          metadata_json: string | null;
        }>(
          "SELECT h.event_key, h.event, h.received_at, m.metadata AS metadata_json FROM hints h LEFT JOIN hint_metadata m ON h.event_key = m.event_key WHERE h.task_id = ? AND h.received_at >= ? ORDER BY h.received_at DESC, h.event_key DESC LIMIT 51",
          taskId,
          Date.now() - WEEK,
        )
        .toArray();
      const events = rows.slice(0, 50).map(({ metadata_json, ...row }) => {
        let metadata = {};
        if (metadata_json) {
          try {
            metadata = sanitizeWebhookMetadata(JSON.parse(metadata_json));
          } catch {
            // Preserve the base event even if its optional metadata is invalid.
          }
        }
        return { ...row, ...(Object.keys(metadata).length ? { metadata } : {}) };
      });
      return Response.json({ events, incomplete: rows.length > 50 });
    }
    if (request.method === "GET" && path === "/diagnostics") {
      const counts = this.state.storage.sql
        .exec<{ retained: number; pending: number; oldest_ms: number | null }>(
          "SELECT COUNT(*) AS retained, COUNT(CASE WHEN r.event_key IS NULL THEN 1 END) AS pending, MIN(h.received_at) AS oldest_ms FROM hints h LEFT JOIN reviewed r ON h.event_key = r.event_key WHERE h.received_at >= ?",
          Date.now() - WEEK,
        )
        .one();
      return Response.json({
        ...counts,
        retention_days: 7,
        capacity: 5000,
        task_index: this.taskIndex.diagnostics(),
      });
    }
    if (request.method === "POST" && (path === "/acknowledge" || path === "/consumer-processed")) {
      const raw: unknown = await request.json().catch(() => null);
      if (raw === null || typeof raw !== "object" || Array.isArray(raw))
        return new Response(null, { status: 400 });
      const args = raw as Record<string, unknown>;
      const taskId = args["task_id"];
      const keys = args["event_keys"];
      const consumer = path === "/consumer-processed" ? args["consumer"] : null;
      if (
        (path === "/consumer-processed" && !validActivityConsumer(consumer)) ||
        typeof taskId !== "string" ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(taskId) ||
        !Array.isArray(keys) ||
        keys.length < 1 ||
        keys.length > 50 ||
        keys.some(
          (key) => typeof key !== "string" || !/^[a-f0-9-]{36}:[a-zA-Z0-9_-]{1,100}$/i.test(key),
        )
      )
        return new Response(null, { status: 400 });
      const unique = [...new Set<string>(keys as string[])];
      const now = Date.now();
      const acknowledged = this.state.storage.transactionSync(() => {
        // All-or-nothing: no accidentally acknowledging another task's event.
        for (const key of unique) {
          const match = this.state.storage.sql
            .exec(
              "SELECT event_key FROM hints WHERE task_id = ? AND event_key = ? AND received_at >= ?",
              taskId,
              key,
              now - WEEK,
            )
            .toArray();
          if (match.length !== 1) return false;
        }
        for (const key of unique) {
          if (typeof consumer === "string")
            this.state.storage.sql.exec(
              "INSERT OR IGNORE INTO consumer_processed(consumer, event_key, processed_at) VALUES (?, ?, ?)",
              consumer,
              key,
              now,
            );
          else
            this.state.storage.sql.exec(
              "INSERT OR IGNORE INTO reviewed(event_key, acknowledged_at) VALUES (?, ?)",
              key,
              now,
            );
        }
        return true;
      });
      return acknowledged
        ? Response.json(
            typeof consumer === "string"
              ? { consumer, processed_event_keys: unique }
              : { acknowledged_event_keys: unique },
          )
        : new Response(null, { status: 409 });
    }
    if (request.method === "GET" && path === "/recent") {
      const rows = this.state.storage.sql
        .exec<{ task_id: string; received_at: number }>(
          "SELECT h.task_id, MAX(h.received_at) AS received_at FROM hints h LEFT JOIN reviewed r ON h.event_key = r.event_key WHERE r.event_key IS NULL AND h.received_at >= ? GROUP BY h.task_id ORDER BY received_at DESC, h.task_id LIMIT 51",
          Date.now() - WEEK,
        )
        .toArray();
      return Response.json({ tasks: rows.slice(0, 50), incomplete: rows.length > 50 });
    }
    if (request.method !== "POST" || path !== "/ingest") return new Response(null, { status: 404 });
    const raw: unknown = await request.json().catch(() => null);
    // New ingress carries actor identity exclusively from the already
    // HMAC-verified webhook registration, never from the provider body.
    // Legacy array ingress stays readable during an existing deployment.
    const envelope =
      raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : null;
    const input = envelope ? envelope["hints"] : raw;
    if (!Array.isArray(input) || input.length < 1 || input.length > 500)
      return new Response(null, { status: 400 });
    if (
      envelope &&
      (typeof envelope["workspaceId"] !== "string" ||
        envelope["workspaceId"] !== this.env.CLICKUP_WORKSPACE_ID ||
        typeof envelope["subject"] !== "string" ||
        !/^github:[1-9]\d{0,15}$/.test(envelope["subject"]))
    )
      return new Response(null, { status: 400 });
    const now = Date.now();
    const hints: WebhookHint[] = [];
    for (const value of input) {
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
      const metadata = sanitizeWebhookMetadata(item["metadata"]);
      hints.push({
        key,
        taskId,
        event,
        receivedAt,
        ...(Object.keys(metadata).length ? { metadata } : {}),
      });
    }
    this.state.storage.transactionSync(() => {
      if (envelope) {
        this.state.storage.sql.exec(
          "INSERT OR IGNORE INTO sync_owner(id, workspace_id, subject) VALUES (1, ?, ?)",
          String(envelope["workspaceId"]),
          String(envelope["subject"]),
        );
        const owner = this.state.storage.sql
          .exec<{
            workspace_id: string;
            subject: string;
          }>("SELECT workspace_id, subject FROM sync_owner WHERE id = 1")
          .one();
        if (owner.workspace_id !== envelope["workspaceId"] || owner.subject !== envelope["subject"])
          throw new Error("SYNC_OWNER_MISMATCH");
      }
      for (const hint of hints) {
        const identity = hint.key.slice(37);
        // Signed history digests identify the same task/event across subscriptions.
        // Existing event keys stay stable for pagination and consumer receipts.
        const existing = /^[a-f0-9]{64}$/.test(identity)
          ? this.state.storage.sql
              .exec<{ event_key: string }>(
                "SELECT event_key FROM hints WHERE task_id = ? AND event = ? AND substr(event_key, 38) = ? ORDER BY received_at, event_key LIMIT 1",
                hint.taskId,
                hint.event,
                identity,
              )
              .toArray()[0]
          : undefined;
        const eventKey = existing?.event_key ?? hint.key;
        // A retransmitted history item must not trigger a second refresh.
        const inserted = this.state.storage.sql
          .exec<{ event_key: string }>(
            "INSERT OR IGNORE INTO hints(event_key, task_id, event, received_at) VALUES (?, ?, ?, ?) RETURNING event_key",
            eventKey,
            hint.taskId,
            hint.event,
            hint.receivedAt,
          )
          .toArray();
        if (inserted.length) this.taskIndex.markDirty(hint.taskId, hint.event, now);
        if (hint.metadata)
          this.state.storage.sql.exec(
            "INSERT OR IGNORE INTO hint_metadata(event_key, metadata) SELECT event_key, ? FROM hints WHERE event_key = ? AND task_id = ?",
            JSON.stringify(hint.metadata),
            eventKey,
            hint.taskId,
          );
      }
      this.state.storage.sql.exec("DELETE FROM hints WHERE received_at < ?", now - WEEK);
      this.state.storage.sql.exec(
        "DELETE FROM hints WHERE event_key IN (SELECT event_key FROM hints ORDER BY received_at DESC, event_key DESC LIMIT -1 OFFSET 5000)",
      );
      this.state.storage.sql.exec(
        "DELETE FROM reviewed WHERE event_key NOT IN (SELECT event_key FROM hints)",
      );
      this.state.storage.sql.exec(
        "DELETE FROM hint_metadata WHERE event_key NOT IN (SELECT event_key FROM hints)",
      );
      this.state.storage.sql.exec(
        "DELETE FROM consumer_processed WHERE event_key NOT IN (SELECT event_key FROM hints)",
      );
    });
    await this.scheduleAlarm(now);
    return new Response(null, { status: 204 });
  }

  /** A separate internal DO instance per Workspace stores the signing
   * credential encrypted with the existing Worker key. No public read route. */
  private async registry(request: Request): Promise<Response> {
    const webhookId = new URL(request.url).searchParams.get("webhook_id");
    if (!webhookId || !/^[a-f0-9-]{36}$/i.test(webhookId))
      return new Response(null, { status: 400 });
    const storageKey = "registration:" + webhookId;
    const secretKey = this.env.CLICKUP_TOKEN_KEY;
    if (!secretKey || !/^[A-Za-z0-9+/]{43}=$/.test(secretKey))
      return new Response(null, { status: 503 });
    const key = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(atob(secretKey), (c) => c.charCodeAt(0)),
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
    type Stored = { iv: number[]; ciphertext: number[] };
    const existing = await this.state.storage.get<Stored>(storageKey);
    if (request.method === "GET") {
      if (!existing) return new Response(null, { status: 404 });
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(existing.iv) },
        key,
        new Uint8Array(existing.ciphertext),
      );
      return new Response(new TextDecoder().decode(plaintext), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }
    if (request.method === "DELETE") {
      await this.state.storage.delete(storageKey);
      return new Response(null, { status: 204 });
    }
    if (request.method !== "POST") return new Response(null, { status: 405 });
    if (existing) return new Response(null, { status: 409 });
    const value: unknown = await request.json().catch(() => null);
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return new Response(null, { status: 400 });
    const registration = value as Record<string, unknown>;
    if (
      typeof registration["workspaceId"] !== "string" ||
      !/^[1-9]\d{0,17}$/.test(registration["workspaceId"]) ||
      typeof registration["subject"] !== "string" ||
      !/^github:[1-9]\d{0,15}$/.test(registration["subject"]) ||
      typeof registration["secret"] !== "string" ||
      !registration["secret"] ||
      registration["secret"].length > 512
    )
      return new Response(null, { status: 400 });
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(JSON.stringify(registration)),
    );
    // A transaction prevents a concurrent registration replacing a known key.
    const inserted = await this.state.storage.transaction(async (transaction) => {
      if (await transaction.get(storageKey)) return false;
      await transaction.put(storageKey, {
        iv: Array.from(iv),
        ciphertext: Array.from(new Uint8Array(ciphertext)),
      });
      return true;
    });
    return new Response(null, { status: inserted ? 204 : 409 });
  }

  /** Cloudflare's native Durable Object alarm is the only background driver.
   * Each invocation processes a bounded batch, preserving the remainder in
   * SQLite; retries are durable and respect ClickUp's per-user quota handling.
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    this.state.storage.sql.exec("DELETE FROM hints WHERE received_at <= ?", now - WEEK);
    this.state.storage.sql.exec(
      "DELETE FROM reviewed WHERE event_key NOT IN (SELECT event_key FROM hints)",
    );
    this.state.storage.sql.exec(
      "DELETE FROM hint_metadata WHERE event_key NOT IN (SELECT event_key FROM hints)",
    );
    this.state.storage.sql.exec(
      "DELETE FROM consumer_processed WHERE event_key NOT IN (SELECT event_key FROM hints)",
    );
    let pauseUntil: number | null = null;
    if (this.env.CLICKUP_INDEX_AUTOSYNC_ENABLED === "true") {
      const owner = this.state.storage.sql
        .exec<{ workspace_id: string; subject: string }>(
          "SELECT workspace_id, subject FROM sync_owner WHERE id = 1",
        )
        .toArray()[0];
      if (owner) {
        const dirty = this.taskIndex.dirtyTasks(Date.now(), 3);
        if (dirty.length) {
          let grant;
          try {
            grant = await grantForSignedWebhook(
              { workspaceId: owner.workspace_id, subject: owner.subject },
              this.env,
            );
          } catch {
            // Revoked OAuth or changed staff policy: do not use cached tokens.
            pauseUntil = Date.now() + 15 * 60_000;
          }
          if (grant) {
            for (const pending of dirty) {
              try {
                const result = await synchronizeDirtyTask(pending, grant, this.taskIndex, fetch);
                if (result.complete) this.taskIndex.clearRetry(pending.task_id);
                else
                  this.taskIndex.deferTaskIfCurrent(
                    pending.task_id,
                    Date.now() + 15 * 60_000,
                    pending.attempts + 1,
                    pending.dirty_token,
                  );
              } catch (error) {
                // Do not let an older failed request postpone a newer
                // webhook generation. A definite denial has already queued
                // both sections and set its own retry checkpoint.
                this.taskIndex.deferTaskIfCurrent(
                  pending.task_id,
                  Date.now() + retryDelayMs(error, pending.attempts),
                  pending.attempts + 1,
                  pending.dirty_token,
                );
              }
            }
          }
        }
      }
    }
    await this.scheduleAlarm(Date.now(), pauseUntil, true);
  }

  /** Preserve the legacy seven-day event-expiry alarm and choose the earlier
   * task refresh deadline when automatic synchronization is enabled.
   */
  private async scheduleAlarm(
    now: number,
    pausedUntil: number | null = null,
    afterAlarm = false,
  ): Promise<void> {
    const earliest = this.state.storage.sql
      .exec<{ earliest: number | null }>("SELECT MIN(received_at) AS earliest FROM hints")
      .one().earliest;
    const expiry = earliest === null ? null : Math.max(now + 1000, earliest + WEEK);
    let refresh: number | null = null;
    if (this.env.CLICKUP_INDEX_AUTOSYNC_ENABLED === "true") {
      const owner = this.state.storage.sql
        .exec<{ workspace_id: string }>("SELECT workspace_id FROM sync_owner WHERE id = 1")
        .toArray()[0];
      if (owner) {
        const due = this.taskIndex.nextDirtyDue();
        if (due !== null)
          refresh = Math.max(now + 1000, pausedUntil ?? (due === 0 ? now + 2000 : due));
      }
    }
    const candidates = [expiry, refresh].filter((value): value is number => value !== null);
    if (candidates.length > 0) {
      const next = Math.min(...candidates);
      const existing = await this.state.storage.getAlarm();
      if (afterAlarm || existing === null || existing > next)
        await this.state.storage.setAlarm(next);
    }
  }
}
