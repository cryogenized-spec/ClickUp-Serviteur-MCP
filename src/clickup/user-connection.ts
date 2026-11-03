/**
 * One durable, isolated account object per VERIFIED MCP GitHub subject.
 * Credentials are AES-GCM encrypted at rest; key stays in a Worker secret.
 * Public HTTP routing never exposes this class or its private stub endpoints.
 */
interface IdentitySecrets {
  readonly CLICKUP_TOKEN_KEY?: string;
}

interface StoredAccount extends Record<string, string | number | null> {
  readonly subject: string;
  readonly clickup_user_id: string;
  readonly workspace_id: string;
  readonly cipher: string;
  readonly iv: string;
  readonly connected_at_ms: number;
}
type Json = Record<string, unknown>;

function object(v: unknown): Json | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}
function numeric(v: unknown): v is string {
  return typeof v === "string" && /^[1-9]\d{0,17}$/.test(v);
}
function subject(v: unknown): v is string {
  return typeof v === "string" && /^github:[1-9]\d{0,15}$/.test(v);
}
function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
async function tokenKey(secret?: string): Promise<CryptoKey> {
  if (typeof secret !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(secret)) {
    throw Error("Credential encryption unavailable");
  }
  const bytes = unb64(secret);
  if (bytes.byteLength !== 32) throw Error("Credential encryption unavailable");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}
function metadataHeaders(): HeadersInit {
  return { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
}

export class ClickUpUserConnection {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: IdentitySecrets,
  ) {
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS pending (nonce_hash TEXT PRIMARY KEY, expires_ms INTEGER NOT NULL, subject TEXT NOT NULL)",
    );
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS connection (id INTEGER PRIMARY KEY CHECK(id = 1), subject TEXT NOT NULL, clickup_user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, cipher TEXT NOT NULL, iv TEXT NOT NULL, connected_at_ms INTEGER NOT NULL)",
    );
    // Old connections lack verified single-Workspace OAuth evidence and must
    // reconnect to activate the optional Workspace-wide operational policy.
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS connection_authorization (id INTEGER PRIMARY KEY CHECK(id = 1), subject TEXT NOT NULL, workspace_exclusive INTEGER NOT NULL CHECK(workspace_exclusive IN (0,1)))",
    );
    // Explicit, revocable per-user Workspace permission, never shared across staff.
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS workspace_access (id INTEGER PRIMARY KEY CHECK(id = 1), subject TEXT NOT NULL, workspace_id TEXT NOT NULL, enabled_at_ms INTEGER NOT NULL)",
    );
    // Per-user active List selection, bound to the SAME verified OAuth Workspace.
    // No credential or Workspace switch is permitted via this table.
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS list_target (id INTEGER PRIMARY KEY CHECK(id = 1), subject TEXT NOT NULL, workspace_id TEXT NOT NULL, list_id TEXT NOT NULL, changed_at_ms INTEGER NOT NULL)",
    );
  }

  async fetch(request: Request): Promise<Response> {
    const route = new URL(request.url).pathname;
    if (request.method !== "POST") return new Response(null, { status: 404 });
    const body = object(await request.json().catch(() => null));
    if (!body || !subject(body["subject"])) return new Response(null, { status: 400 });
    const principal = body["subject"];
    const now = Date.now();
    if (route === "/begin") {
      const hash = body["nonceHash"];
      const expires = body["expiresAt"];
      if (
        typeof hash !== "string" ||
        !/^[0-9a-f]{64}$/.test(hash) ||
        typeof expires !== "number" ||
        !Number.isSafeInteger(expires) ||
        expires <= now ||
        expires > now + 10 * 60_000
      ) {
        return new Response(null, { status: 400 });
      }
      this.state.storage.transactionSync(() => {
        this.state.storage.sql.exec("DELETE FROM pending");
        this.state.storage.sql.exec(
          "INSERT INTO pending(nonce_hash,expires_ms,subject) VALUES(?,?,?)",
          hash,
          expires,
          principal,
        );
      });
      return Response.json({ accepted: true }, { headers: metadataHeaders() });
    }
    if (route === "/consume") {
      const hash = body["nonceHash"];
      if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) {
        return new Response(null, { status: 400 });
      }
      const consumed = this.state.storage.transactionSync(() => {
        const rows = this.state.storage.sql
          .exec<{ nonce_hash: string }>(
            "DELETE FROM pending WHERE nonce_hash = ? AND subject = ? AND expires_ms > ? RETURNING nonce_hash",
            hash,
            principal,
            now,
          )
          .toArray();
        return rows.length === 1;
      });
      return Response.json({ consumed }, { headers: metadataHeaders() });
    }
    const stored = this.state.storage.sql
      .exec<StoredAccount>(
        "SELECT subject,clickup_user_id,workspace_id,cipher,iv,connected_at_ms FROM connection WHERE id = 1",
      )
      .toArray()[0];
    const verified = this.state.storage.sql
      .exec<{ workspace_exclusive: number }>(
        "SELECT workspace_exclusive FROM connection_authorization WHERE id = 1 AND subject = ?",
        principal,
      )
      .toArray()[0];
    const workspaceAccess = this.state.storage.sql
      .exec<{ workspace_id: string }>(
        "SELECT workspace_id FROM workspace_access WHERE id = 1 AND subject = ?",
        principal,
      )
      .toArray()[0];
    const target = this.state.storage.sql
      .exec<{ workspace_id: string; list_id: string }>(
        "SELECT workspace_id,list_id FROM list_target WHERE id = 1 AND subject = ?",
        principal,
      )
      .toArray()[0];
    const targetListId =
      stored?.subject === principal && target?.workspace_id === stored.workspace_id
        ? target.list_id
        : null;
    const exclusive = verified?.workspace_exclusive === 1;
    const workspaceEnabled =
      exclusive &&
      stored?.subject === principal &&
      workspaceAccess?.workspace_id === stored.workspace_id;
    if (route === "/status") {
      return Response.json(
        stored?.subject === principal
          ? {
              connected: true,
              clickupUserId: stored.clickup_user_id,
              workspaceId: stored.workspace_id,
              connectedAtMs: stored.connected_at_ms,
              workspaceExclusive: exclusive,
              workspaceEnabled,
              targetListId,
            }
          : { connected: false },
        { headers: metadataHeaders() },
      );
    }
    if (route === "/workspace-access") {
      const enabled = body["enabled"];
      if (
        !stored ||
        stored.subject !== principal ||
        body["workspaceId"] !== stored.workspace_id ||
        typeof enabled !== "boolean"
      ) {
        return new Response(null, { status: 403 });
      }
      if (enabled && !exclusive) return new Response(null, { status: 403 });
      this.state.storage.transactionSync(() => {
        this.state.storage.sql.exec("DELETE FROM workspace_access WHERE subject = ?", principal);
        if (enabled) {
          this.state.storage.sql.exec(
            "INSERT OR REPLACE INTO workspace_access(id,subject,workspace_id,enabled_at_ms) VALUES(1,?,?,?)",
            principal,
            stored.workspace_id,
            now,
          );
        }
      });
      return Response.json({ workspaceEnabled: enabled }, { headers: metadataHeaders() });
    }
    if (route === "/target-list") {
      if (!stored || stored.subject !== principal || body["workspaceId"] !== stored.workspace_id)
        return new Response(null, { status: 403 });
      const selected = body["listId"];
      if (!numeric(selected)) return new Response(null, { status: 400 });
      // Generation is this OAuth credential's random AES-GCM IV. It changes
      // whenever /store replaces the account. Do not accept stale selections.
      if (body["connectionGeneration"] !== stored.iv) return new Response(null, { status: 409 });
      const resetToDefault = body["resetToDefault"] === true;
      this.state.storage.transactionSync(() => {
        if (resetToDefault) {
          this.state.storage.sql.exec("DELETE FROM list_target WHERE subject = ?", principal);
        } else {
          this.state.storage.sql.exec(
            "INSERT OR REPLACE INTO list_target(id,subject,workspace_id,list_id,changed_at_ms) VALUES(1,?,?,?,?)",
            principal,
            stored.workspace_id,
            selected,
            now,
          );
        }
      });
      return Response.json(
        { selected: true, workspaceId: stored.workspace_id, listId: selected, resetToDefault },
        { headers: metadataHeaders() },
      );
    }
    if (route === "/disconnect") {
      this.state.storage.sql.exec("DELETE FROM connection WHERE subject = ?", principal);
      this.state.storage.sql.exec(
        "DELETE FROM connection_authorization WHERE subject = ?",
        principal,
      );
      this.state.storage.sql.exec("DELETE FROM workspace_access WHERE subject = ?", principal);
      this.state.storage.sql.exec("DELETE FROM list_target WHERE subject = ?", principal);
      this.state.storage.sql.exec("DELETE FROM pending WHERE subject = ?", principal);
      return Response.json({ disconnected: true }, { headers: metadataHeaders() });
    }
    if (route === "/store") {
      const accessToken = body["accessToken"];
      const clickupId = body["clickupUserId"];
      const workspaceId = body["workspaceId"];
      const workspaceExclusive = body["workspaceExclusive"];
      if (
        typeof accessToken !== "string" ||
        accessToken.length < 8 ||
        accessToken.length > 4096 ||
        !numeric(clickupId) ||
        !numeric(workspaceId) ||
        typeof workspaceExclusive !== "boolean"
      ) {
        return new Response(null, { status: 400 });
      }
      try {
        const key = await tokenKey(this.env.CLICKUP_TOKEN_KEY);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encoded = new TextEncoder().encode(accessToken);
        const ciphertext = new Uint8Array(
          await crypto.subtle.encrypt(
            { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(principal) },
            key,
            encoded,
          ),
        );
        this.state.storage.transactionSync(() => {
          // Reconnection must never silently carry forward an earlier broad grant.
          this.state.storage.sql.exec("DELETE FROM workspace_access WHERE subject = ?", principal);
          // OAuth reconnection always clears the old List choice; no cross-account
          // target selection carries over to a new token.
          this.state.storage.sql.exec("DELETE FROM list_target WHERE subject = ?", principal);
          this.state.storage.sql.exec(
            "INSERT OR REPLACE INTO connection(id,subject,clickup_user_id,workspace_id,cipher,iv,connected_at_ms) VALUES(1,?,?,?,?,?,?)",
            principal,
            clickupId,
            workspaceId,
            b64(ciphertext),
            b64(iv),
            now,
          );
          this.state.storage.sql.exec(
            "INSERT OR REPLACE INTO connection_authorization(id,subject,workspace_exclusive) VALUES(1,?,?)",
            principal,
            workspaceExclusive ? 1 : 0,
          );
        });
        return Response.json({ stored: true }, { headers: metadataHeaders() });
      } catch {
        return new Response(null, { status: 503 });
      }
    }
    if (route === "/credential") {
      if (!stored || stored.subject !== principal) {
        return Response.json({ connected: false }, { headers: metadataHeaders() });
      }
      try {
        const key = await tokenKey(this.env.CLICKUP_TOKEN_KEY);
        const raw = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: unb64(stored.iv),
            additionalData: new TextEncoder().encode(principal),
          },
          key,
          unb64(stored.cipher),
        );
        return Response.json(
          {
            connected: true,
            clickupUserId: stored.clickup_user_id,
            workspaceId: stored.workspace_id,
            accessToken: new TextDecoder().decode(raw),
            connectionGeneration: stored.iv,
            workspaceExclusive: exclusive,
            workspaceEnabled,
            targetListId,
          },
          { headers: metadataHeaders() },
        );
      } catch {
        return new Response(null, { status: 503 });
      }
    }
    return new Response(null, { status: 404 });
  }
}
