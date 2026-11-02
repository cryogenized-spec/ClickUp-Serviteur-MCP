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
  }

  async fetch(request: Request): Promise<Response> {
    const route = new URL(request.url).pathname;
    if (request.method !== "POST" || (route !== "/reserve" && route !== "/cooldown")) {
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
      });
      return Response.json({ allowed: true });
    }

    const block = this.state.storage.sql
      .exec<{ blocked_until_ms: number }>("SELECT blocked_until_ms FROM limits WHERE id = 1")
      .one();
    return Response.json({
      allowed: block.blocked_until_ms <= now,
      retryAfterMs: Math.max(0, block.blocked_until_ms - now),
    });
  }
}
