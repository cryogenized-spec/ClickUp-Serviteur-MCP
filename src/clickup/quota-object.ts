import { validApiMetric } from "./api-telemetry.js";

/**
 * Shared upstream ClickUp 429 cooldown for each authenticated ClickUp account.
 * The public Worker never routes external requests here; only the internal binding can.
 *
 * No self-imposed per-minute request caps: /reserve permits calls unless ClickUp
 * actually requested a cooldown via a 429 X-RateLimit-Reset response.
 * Keep the existing Durable Object class/binding and "limits" SQLite table so
 * deployed staging and existing encrypted OAuth connections need no migration.
 * Previously stored "reservations" rows are intentionally ignored.
 */
export class ClickUpQuota {
  constructor(private readonly state: DurableObjectState) {
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS limits (id INTEGER PRIMARY KEY CHECK (id = 1), blocked_until_ms INTEGER NOT NULL)",
    );
    state.storage.sql.exec("INSERT OR IGNORE INTO limits (id, blocked_until_ms) VALUES (1, 0)");
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS api_metric_day (day INTEGER NOT NULL, operation TEXT NOT NULL, category TEXT NOT NULL, method TEXT NOT NULL, status INTEGER NOT NULL, count INTEGER NOT NULL, total_ms INTEGER NOT NULL, max_ms INTEGER NOT NULL, PRIMARY KEY(day, operation, category, method, status))",
    );
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS diagnostic_day (day INTEGER PRIMARY KEY, allowed INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0, cooldowns INTEGER NOT NULL DEFAULT 0)",
    );
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS file_pending (attachment_id TEXT PRIMARY KEY, subject TEXT NOT NULL, clickup_user_id TEXT NOT NULL, generation TEXT NOT NULL, created_ms INTEGER NOT NULL, claimed INTEGER NOT NULL DEFAULT 0)",
    );
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS file_claim (id INTEGER PRIMARY KEY CHECK (id = 1), attachment_id TEXT NOT NULL)",
    );
  }

  async fetch(request: Request): Promise<Response> {
    const route = new URL(request.url).pathname;
    if (
      request.method !== "POST" ||
      ![
        "/reserve",
        "/diagnostics",
        "/api-metrics",
        "/cooldown",
        "/file-pending-register",
        "/file-pending-verify",
        "/file-pending-claim",
      ].includes(route)
    ) {
      return new Response(null, { status: 404 });
    }
    const raw: unknown = await request.json().catch(() => null);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return new Response(null, { status: 400 });
    }
    const body = raw as Record<string, unknown>;
    const subject = body["subject"];
    if (typeof subject !== "string" || !/^github:[1-9]\d*$/.test(subject)) {
      return new Response(null, { status: 400 });
    }
    const now = Date.now();
    const day = Math.floor(now / 86_400_000);
    const record = (allowed: number, blocked: number, cooldowns: number) => {
      this.state.storage.sql.exec(
        "INSERT INTO diagnostic_day(day, allowed, blocked, cooldowns) VALUES (?, ?, ?, ?) ON CONFLICT(day) DO UPDATE SET allowed = allowed + excluded.allowed, blocked = blocked + excluded.blocked, cooldowns = cooldowns + excluded.cooldowns",
        day,
        allowed,
        blocked,
        cooldowns,
      );
      this.state.storage.sql.exec("DELETE FROM diagnostic_day WHERE day < ?", day - 6);
    };
    if (route === "/api-metrics") {
      const operation = body["operation"];
      const metrics = body["metrics"];
      if (
        typeof operation !== "string" ||
        !/^clickup_[a-z_]{1,80}$/.test(operation) ||
        !Array.isArray(metrics) ||
        !metrics.every(validApiMetric)
      )
        return new Response(null, { status: 400 });
      this.state.storage.transactionSync(() => {
        for (const metric of metrics) {
          this.state.storage.sql.exec(
            "INSERT INTO api_metric_day(day, operation, category, method, status, count, total_ms, max_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(day, operation, category, method, status) DO UPDATE SET count = count + excluded.count, total_ms = total_ms + excluded.total_ms, max_ms = MAX(max_ms, excluded.max_ms)",
            day,
            operation,
            metric.category,
            metric.method,
            metric.status,
            metric.count,
            metric.total_ms,
            metric.max_ms,
          );
        }
        this.state.storage.sql.exec("DELETE FROM api_metric_day WHERE day < ?", day - 6);
      });
      return new Response(null, { status: 204 });
    }
    if (route === "/diagnostics") {
      const block = this.state.storage.sql
        .exec<{ blocked_until_ms: number }>("SELECT blocked_until_ms FROM limits WHERE id = 1")
        .one();
      const days = this.state.storage.sql
        .exec<{ day: number; allowed: number; blocked: number; cooldowns: number }>(
          "SELECT day, allowed, blocked, cooldowns FROM diagnostic_day WHERE day >= ? ORDER BY day",
          day - 6,
        )
        .toArray();
      const outcomes = this.state.storage.sql
        .exec<{
          day: number;
          status: number;
          count: number;
          total_ms: number;
          max_ms: number;
        }>(
          "SELECT day, status, SUM(count) AS count, SUM(total_ms) AS total_ms, MAX(max_ms) AS max_ms FROM api_metric_day WHERE day >= ? GROUP BY day, status ORDER BY day, status",
          day - 6,
        )
        .toArray();
      const endpointFailures = this.state.storage.sql
        .exec<{
          operation: string;
          category: string;
          method: string;
          status: number;
          count: number;
        }>(
          "SELECT operation, category, method, status, SUM(count) AS count FROM api_metric_day WHERE day >= ? AND (status = 0 OR status >= 400) GROUP BY operation, category, method, status ORDER BY count DESC, operation, category, method, status LIMIT 101",
          day - 6,
        )
        .toArray();
      return Response.json({
        days,
        upstream_outcomes: outcomes,
        endpoint_failures: endpointFailures.slice(0, 100),
        endpoint_failures_incomplete: endpointFailures.length > 100,
        cooldown_remaining_ms: Math.max(0, block.blocked_until_ms - now),
      });
    }
    if (route.startsWith("/file-pending-")) {
      // An instance is selected server-side by the immutable Workspace/task/field tuple.
      // Only the worker has access to this internal Durable Object binding.
      const attachmentId = body["attachmentId"];
      const clickupUserId = body["clickupUserId"];
      const generation = body["generation"];
      if (
        typeof attachmentId !== "string" ||
        !/^[a-zA-Z0-9._-]{1,100}$/.test(attachmentId) ||
        typeof clickupUserId !== "string" ||
        !/^[1-9][0-9]{0,17}$/.test(clickupUserId) ||
        typeof generation !== "string" ||
        generation.length > 128
      ) {
        return new Response(null, { status: 400 });
      }
      // Atomic SQL transitions coordinate separate Worker instances/principals.
      // A claim is deliberately irreversible: no retries after ambiguous ClickUp writes.
      const allowed = this.state.storage.transactionSync(() => {
        const sql = this.state.storage.sql;
        const current = sql
          .exec<{
            subject: string;
            clickup_user_id: string;
            generation: string;
            created_ms: number;
            claimed: number;
          }>(
            "SELECT subject, clickup_user_id, generation, created_ms, claimed FROM file_pending WHERE attachment_id = ?",
            attachmentId,
          )
          .toArray()[0];
        const belongs =
          current?.subject === subject &&
          current.clickup_user_id === clickupUserId &&
          current.generation === generation &&
          current.claimed === 0 &&
          current.created_ms > now - 15 * 60_000;
        if (route === "/file-pending-verify") return belongs;
        if (route === "/file-pending-claim") {
          if (!belongs) return false;
          const taken = sql
            .exec<{ attachment_id: string }>("SELECT attachment_id FROM file_claim WHERE id = 1")
            .toArray()[0];
          if (taken) return false;
          sql.exec("INSERT INTO file_claim (id, attachment_id) VALUES (1, ?)", attachmentId);
          sql.exec("UPDATE file_pending SET claimed = 1 WHERE attachment_id = ?", attachmentId);
          return true;
        }
        // Never let an untrusted attachment ID be registered twice, or after
        // this field has had an association attempt. Old pending rows are bounded.
        if (current) return false;
        const taken = sql
          .exec<{ attachment_id: string }>("SELECT attachment_id FROM file_claim WHERE id = 1")
          .toArray()[0];
        if (taken) return false;
        sql.exec(
          "DELETE FROM file_pending WHERE claimed = 0 AND created_ms < ?",
          now - 15 * 60_000,
        );
        const count = sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM file_pending")
          .one();
        if (count.count >= 100) return false;
        sql.exec(
          "INSERT INTO file_pending (attachment_id, subject, clickup_user_id, generation, created_ms, claimed) VALUES (?, ?, ?, ?, ?, 0)",
          attachmentId,
          subject,
          clickupUserId,
          generation,
          now,
        );
        return true;
      });
      return Response.json({ allowed });
    }
    if (route === "/cooldown") {
      const until = body["until"];
      if (typeof until !== "number" || !Number.isSafeInteger(until) || until < now) {
        return new Response(null, { status: 400 });
      }
      this.state.storage.transactionSync(() => {
        this.state.storage.sql.exec(
          "UPDATE limits SET blocked_until_ms = MAX(blocked_until_ms, ?) WHERE id = 1",
          Math.min(until, now + 3_600_000),
        );
        record(0, 0, 1);
      });
      return Response.json({ allowed: true });
    }

    const block = this.state.storage.sql
      .exec<{ blocked_until_ms: number }>("SELECT blocked_until_ms FROM limits WHERE id = 1")
      .one();
    const allowed = block.blocked_until_ms <= now;
    this.state.storage.transactionSync(() => record(allowed ? 1 : 0, allowed ? 0 : 1, 0));
    return Response.json({
      allowed,
      retryAfterMs: Math.max(0, block.blocked_until_ms - now),
    });
  }
}
