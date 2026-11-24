import type { WebhookHint } from "./webhook-ingress.js";

const WEEK = 7 * 24 * 60 * 60 * 1000;
const uuid = /^[a-f0-9-]{36}$/i;
const fromBase64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
const toBase64 = (value: Uint8Array) => btoa(String.fromCharCode(...value));

async function registryKey(value: string | undefined): Promise<CryptoKey> {
  if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw Error("Encryption unavailable");
  return crypto.subtle.importKey("raw", fromBase64(value), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

interface RegistryRow extends Record<string, string> {
  webhook_id: string;
  clickup_user_id: string;
  iv: string;
  cipher: string;
}

/** Internal binding only. Partition by approved Workspace and authenticated actor. */
export class ClickUpWebhookEvents {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env?: { readonly CLICKUP_TOKEN_KEY?: string },
  ) {
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS registrations (webhook_id TEXT PRIMARY KEY, clickup_user_id TEXT NOT NULL, iv TEXT NOT NULL, cipher TEXT NOT NULL)",
    );
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS hints (event_key TEXT PRIMARY KEY, task_id TEXT NOT NULL, event TEXT NOT NULL, received_at INTEGER NOT NULL)",
    );
    state.storage.sql.exec("CREATE INDEX IF NOT EXISTS hints_received ON hints(received_at)");
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS reviewed (event_key TEXT PRIMARY KEY, acknowledged_at INTEGER NOT NULL)",
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/registration") {
      const webhookId = url.searchParams.get("id");
      if (!webhookId || !uuid.test(webhookId)) return new Response(null, { status: 400 });
      const row = this.state.storage.sql
        .exec<RegistryRow>(
          "SELECT webhook_id, clickup_user_id, iv, cipher FROM registrations WHERE webhook_id = ?",
          webhookId,
        )
        .toArray()[0];
      if (request.method === "DELETE") {
        this.state.storage.sql.exec("DELETE FROM registrations WHERE webhook_id = ?", webhookId);
        return new Response(null, { status: 204 });
      }
      try {
        const key = await registryKey(this.env?.CLICKUP_TOKEN_KEY);
        if (request.method === "GET") {
          if (!row) return new Response(null, { status: 404 });
          const raw = await crypto.subtle.decrypt(
            {
              name: "AES-GCM",
              iv: fromBase64(row.iv),
              additionalData: new TextEncoder().encode(webhookId + ":" + row.clickup_user_id),
            },
            key,
            fromBase64(row.cipher),
          );
          return Response.json(
            { secret: new TextDecoder().decode(raw), clickup_user_id: row.clickup_user_id },
            { headers: { "Cache-Control": "no-store" } },
          );
        }
        if (request.method !== "PUT") return new Response(null, { status: 405 });
        const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
        const secret = body?.["secret"];
        const owner = body?.["clickup_user_id"];
        if (
          typeof secret !== "string" ||
          !secret ||
          secret.length > 512 ||
          typeof owner !== "string" ||
          !/^[1-9]\d{0,17}$/.test(owner) ||
          (row && row.clickup_user_id !== owner)
        )
          return new Response(null, { status: 400 });
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const cipher = await crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv,
            additionalData: new TextEncoder().encode(webhookId + ":" + owner),
          },
          key,
          new TextEncoder().encode(secret),
        );
        this.state.storage.sql.exec(
          "INSERT OR REPLACE INTO registrations(webhook_id, clickup_user_id, iv, cipher) VALUES (?, ?, ?, ?)",
          webhookId,
          owner,
          toBase64(iv),
          toBase64(new Uint8Array(cipher)),
        );
        return new Response(null, { status: 204 });
      } catch {
        return new Response(null, { status: 503 });
      }
    }
    if (request.method === "GET" && path === "/pending") {
      const since = url.searchParams.get("after_time");
      const key = url.searchParams.get("after_key");
      if (
        (since === null) !== (key === null) ||
        (since !== null && (!/^\d{1,16}$/.test(since) || !Number.isSafeInteger(Number(since)))) ||
        (key !== null && !/^[a-f0-9-]{36}:[a-zA-Z0-9_-]{1,100}$/i.test(key))
      )
        return new Response(null, { status: 400 });
      const rows = this.state.storage.sql
        .exec<{ event_key: string; task_id: string; event: string; received_at: number }>(
          "SELECT h.event_key, h.task_id, h.event, h.received_at FROM hints h LEFT JOIN reviewed r ON h.event_key = r.event_key WHERE r.event_key IS NULL AND h.received_at >= ? AND (h.received_at > ? OR (h.received_at = ? AND h.event_key > ?)) ORDER BY h.received_at, h.event_key LIMIT 11",
          Date.now() - WEEK,
          Number(since ?? 0),
          Number(since ?? 0),
          key ?? "",
        )
        .toArray();
      return Response.json({ events: rows.slice(0, 10), incomplete: rows.length > 10 });
    }
    if (request.method === "POST" && path === "/acknowledge") {
      const raw: unknown = await request.json().catch(() => null);
      if (raw === null || typeof raw !== "object" || Array.isArray(raw))
        return new Response(null, { status: 400 });
      const args = raw as Record<string, unknown>;
      const taskId = args["task_id"];
      const keys = args["event_keys"];
      if (
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
        for (const key of unique)
          this.state.storage.sql.exec(
            "INSERT OR IGNORE INTO reviewed(event_key, acknowledged_at) VALUES (?, ?)",
            key,
            now,
          );
        return true;
      });
      return acknowledged
        ? Response.json({ acknowledged_event_keys: unique })
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
      this.state.storage.sql.exec(
        "DELETE FROM reviewed WHERE event_key NOT IN (SELECT event_key FROM hints)",
      );
    });
    const earliest = this.state.storage.sql
      .exec<{ earliest: number | null }>("SELECT MIN(received_at) AS earliest FROM hints")
      .one().earliest;
    if (earliest !== null) await this.state.storage.setAlarm(Math.max(now + 1000, earliest + WEEK));
    return new Response(null, { status: 204 });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.state.storage.sql.exec("DELETE FROM hints WHERE received_at <= ?", now - WEEK);
    this.state.storage.sql.exec(
      "DELETE FROM reviewed WHERE event_key NOT IN (SELECT event_key FROM hints)",
    );
    const remaining = this.state.storage.sql
      .exec<{ earliest: number | null }>("SELECT MIN(received_at) AS earliest FROM hints")
      .one();
    if (remaining.earliest !== null)
      await this.state.storage.setAlarm(Math.max(now + 1000, remaining.earliest + WEEK));
  }
}
