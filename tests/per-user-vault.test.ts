import { describe, expect, it } from "vitest";
import { ClickUpUserConnection } from "../src/clickup/user-connection.js";

interface Row {
  subject: string;
  clickup_user_id: string;
  workspace_id: string;
  cipher: string;
  iv: string;
  connected_at_ms: number;
}
function fakeSqlite() {
  let pending: { hash: string; expires: number; subject: string } | undefined;
  let account: Row | undefined;
  let authorization: { subject: string; exclusive: number } | undefined;
  let workspaceAccess: { subject: string; workspaceId: string; at: number } | undefined;
  let target: { subject: string; workspaceId: string; listId: string } | undefined;
  const exec = (sql: string, ...params: (string | number)[]) => {
    let values: unknown[] = [];
    if (sql.startsWith("CREATE TABLE")) {
      // Durable schema initialization
    } else if (sql === "DELETE FROM pending") {
      pending = undefined;
    } else if (sql.startsWith("INSERT INTO pending")) {
      pending = { hash: String(params[0]), expires: Number(params[1]), subject: String(params[2]) };
    } else if (sql.startsWith("DELETE FROM pending WHERE nonce_hash")) {
      if (
        pending &&
        pending.hash === params[0] &&
        pending.subject === params[1] &&
        pending.expires > Number(params[2])
      ) {
        values = [{ nonce_hash: pending.hash }];
        pending = undefined;
      }
    } else if (sql.startsWith("SELECT workspace_id,list_id FROM list_target")) {
      if (target && target.subject === params[0]) {
        values = [{ workspace_id: target.workspaceId, list_id: target.listId }];
      }
    } else if (sql.startsWith("INSERT OR REPLACE INTO list_target")) {
      target = {
        subject: String(params[0]),
        workspaceId: String(params[1]),
        listId: String(params[2]),
      };
    } else if (sql.startsWith("DELETE FROM list_target")) {
      if (target?.subject === params[0]) target = undefined;
    } else if (sql.startsWith("SELECT workspace_id FROM workspace_access")) {
      if (workspaceAccess && workspaceAccess.subject === params[0])
        values = [{ workspace_id: workspaceAccess.workspaceId }];
    } else if (sql.startsWith("INSERT OR REPLACE INTO workspace_access")) {
      workspaceAccess = {
        subject: String(params[0]),
        workspaceId: String(params[1]),
        at: Number(params[2]),
      };
    } else if (sql.startsWith("DELETE FROM workspace_access")) {
      if (workspaceAccess?.subject === params[0]) workspaceAccess = undefined;
    } else if (sql.startsWith("SELECT workspace_exclusive FROM connection_authorization")) {
      if (authorization && authorization.subject === params[0]) {
        values = [{ workspace_exclusive: authorization.exclusive }];
      }
    } else if (sql.startsWith("INSERT OR REPLACE INTO connection_authorization")) {
      authorization = { subject: String(params[0]), exclusive: Number(params[1]) };
    } else if (sql.startsWith("DELETE FROM connection_authorization")) {
      if (authorization?.subject === params[0]) authorization = undefined;
    } else if (sql.startsWith("SELECT subject,clickup_user_id,workspace_id,cipher,iv")) {
      values = account ? [account] : [];
    } else if (sql.startsWith("INSERT OR REPLACE INTO connection")) {
      account = {
        subject: String(params[0]),
        clickup_user_id: String(params[1]),
        workspace_id: String(params[2]),
        cipher: String(params[3]),
        iv: String(params[4]),
        connected_at_ms: Number(params[5]),
      };
    } else if (sql.startsWith("DELETE FROM connection")) {
      if (account?.subject === params[0]) account = undefined;
    } else if (sql.startsWith("DELETE FROM pending WHERE subject")) {
      if (pending?.subject === params[0]) pending = undefined;
    } else {
      throw Error("Unknown synthetic SQL statement: " + sql);
    }
    return { toArray: () => values };
  };
  const state = {
    storage: { sql: { exec }, transactionSync: (fn: () => unknown) => fn() },
  } as unknown as DurableObjectState;
  return {
    state,
    stored: () => account,
    workspaceAccess: () => workspaceAccess,
    target: () => target,
  };
}
const encryptedKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

async function call(vault: ClickUpUserConnection, route: string, body: Record<string, unknown>) {
  const response = await vault.fetch(
    new Request("https://private.invalid/" + route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  let data: Record<string, unknown> = {};
  if (response.ok) data = (await response.json()) as Record<string, unknown>;
  return { status: response.status, data };
}

describe("actual encrypted SQLite per-user token vault", () => {
  it("encrypts the credential, authorizes only the originating subject and disconnects locally", async () => {
    const backing = fakeSqlite();
    const vault = new ClickUpUserConnection(backing.state, { CLICKUP_TOKEN_KEY: encryptedKey });
    const payload = {
      subject: "github:11",
      accessToken: "synthetic-personal-token-for-tests",
      clickupUserId: "707",
      workspaceId: "999",
      workspaceExclusive: true,
    };
    expect((await call(vault, "store", payload)).data["stored"]).toBe(true);
    const stored = backing.stored()!;
    expect(stored.cipher).not.toContain(payload.accessToken);
    expect(stored.cipher).not.toBe(payload.accessToken);
    expect(stored.iv).toBeTruthy();
    expect((await call(vault, "credential", { subject: "github:22" })).data).toEqual({
      connected: false,
    });
    const actual = (await call(vault, "credential", { subject: "github:11" })).data;
    expect(actual).toMatchObject({
      connected: true,
      accessToken: payload.accessToken,
      clickupUserId: "707",
      workspaceId: "999",
      workspaceExclusive: true,
    });
    expect((await call(vault, "disconnect", { subject: "github:22" })).data["disconnected"]).toBe(
      true,
    );
    expect((await call(vault, "credential", { subject: "github:11" })).data["connected"]).toBe(
      true,
    );
    await call(vault, "disconnect", { subject: "github:11" });
    expect(backing.stored()).toBeUndefined();
    expect((await call(vault, "credential", { subject: "github:11" })).data).toEqual({
      connected: false,
    });
  });

  it("enables Workspace scope for just its verified subject, supports revocation and clears on reconnect", async () => {
    const backing = fakeSqlite();
    const vault = new ClickUpUserConnection(backing.state, { CLICKUP_TOKEN_KEY: encryptedKey });
    const base = {
      subject: "github:11",
      accessToken: "synthetic-personal-token-for-tests",
      clickupUserId: "707",
      workspaceId: "999",
      workspaceExclusive: true,
    };
    expect((await call(vault, "store", base)).data["stored"]).toBe(true);
    expect((await call(vault, "status", { subject: "github:11" })).data).toMatchObject({
      workspaceExclusive: true,
      workspaceEnabled: false,
    });
    expect(
      (
        await call(vault, "workspace-access", {
          subject: "github:11",
          workspaceId: "888",
          enabled: true,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(vault, "workspace-access", {
          subject: "github:22",
          workspaceId: "999",
          enabled: true,
        })
      ).status,
    ).toBe(403);
    const enabled = await call(vault, "workspace-access", {
      subject: "github:11",
      workspaceId: "999",
      enabled: true,
    });
    expect(enabled.data).toEqual({ workspaceEnabled: true });
    expect(backing.workspaceAccess()?.workspaceId).toBe("999");
    expect((await call(vault, "credential", { subject: "github:11" })).data).toMatchObject({
      workspaceExclusive: true,
      workspaceEnabled: true,
    });
    await call(vault, "workspace-access", {
      subject: "github:11",
      workspaceId: "999",
      enabled: false,
    });
    expect(backing.workspaceAccess()).toBeUndefined();
    await call(vault, "workspace-access", {
      subject: "github:11",
      workspaceId: "999",
      enabled: true,
    });
    expect((await call(vault, "store", base)).data["stored"]).toBe(true);
    expect(backing.workspaceAccess()).toBeUndefined();
  });

  it("refuses Workspace opt-in on non-exclusive OAuth tokens", async () => {
    const vault = new ClickUpUserConnection(fakeSqlite().state, {
      CLICKUP_TOKEN_KEY: encryptedKey,
    });
    await call(vault, "store", {
      subject: "github:11",
      accessToken: "synthetic-personal-token-for-tests",
      clickupUserId: "707",
      workspaceId: "999",
      workspaceExclusive: false,
    });
    expect(
      (
        await call(vault, "workspace-access", {
          subject: "github:11",
          workspaceId: "999",
          enabled: true,
        })
      ).status,
    ).toBe(403);
  });

  it("persists only this staff user's List in the exact OAuth Workspace and resets on reconnect", async () => {
    const backing = fakeSqlite();
    const vault = new ClickUpUserConnection(backing.state, { CLICKUP_TOKEN_KEY: encryptedKey });
    const own = {
      subject: "github:11",
      accessToken: "synthetic-personal-token-for-tests",
      clickupUserId: "707",
      workspaceId: "999",
      workspaceExclusive: true,
    };
    expect((await call(vault, "store", own)).status).toBe(200);
    const generation = String(
      (await call(vault, "credential", { subject: "github:11" })).data["connectionGeneration"],
    );
    expect(generation).toMatch(/^[A-Za-z0-9+/]{16}$/);
    expect((await call(vault, "status", { subject: "github:11" })).data).toMatchObject({
      targetListId: null,
    });
    expect(
      (
        await call(vault, "target-list", {
          subject: "github:22",
          workspaceId: "999",
          listId: "12345",
          connectionGeneration: generation,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(vault, "target-list", {
          subject: "github:11",
          workspaceId: "888",
          listId: "12345",
          connectionGeneration: generation,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(vault, "target-list", {
          subject: "github:11",
          workspaceId: "999",
          listId: "not-an-id",
          connectionGeneration: generation,
        })
      ).status,
    ).toBe(400);
    const changed = await call(vault, "target-list", {
      subject: "github:11",
      workspaceId: "999",
      listId: "23456",
      connectionGeneration: generation,
    });
    expect(changed.data).toEqual({
      selected: true,
      workspaceId: "999",
      listId: "23456",
      resetToDefault: false,
    });
    expect((await call(vault, "credential", { subject: "github:11" })).data).toMatchObject({
      targetListId: "23456",
      workspaceId: "999",
    });
    expect((await call(vault, "status", { subject: "github:11" })).data).toMatchObject({
      targetListId: "23456",
    });
    expect(backing.target()).toMatchObject({
      subject: "github:11",
      workspaceId: "999",
      listId: "23456",
    });
    const reset = await call(vault, "target-list", {
      subject: "github:11",
      workspaceId: "999",
      listId: "12345",
      connectionGeneration: generation,
      resetToDefault: true,
    });
    expect(reset.data).toMatchObject({
      selected: true,
      listId: "12345",
      resetToDefault: true,
    });
    expect(backing.target()).toBeUndefined();
    expect((await call(vault, "status", { subject: "github:11" })).data).toMatchObject({
      targetListId: null,
    });
    await call(vault, "target-list", {
      subject: "github:11",
      workspaceId: "999",
      listId: "23456",
      connectionGeneration: generation,
    });
    await call(vault, "store", own);
    expect(backing.target()).toBeUndefined();
    // The previous OAuth generation cannot be reused after credential rotation.
    expect(
      (
        await call(vault, "target-list", {
          subject: "github:11",
          workspaceId: "999",
          listId: "34567",
          connectionGeneration: generation,
        })
      ).status,
    ).toBe(409);
    const rotated = String(
      (await call(vault, "credential", { subject: "github:11" })).data["connectionGeneration"],
    );
    expect(rotated).not.toBe(generation);
    expect((await call(vault, "credential", { subject: "github:11" })).data).toMatchObject({
      targetListId: null,
    });
    await call(vault, "target-list", {
      subject: "github:11",
      workspaceId: "999",
      listId: "34567",
      connectionGeneration: rotated,
    });
    await call(vault, "disconnect", { subject: "github:11" });
    expect(backing.target()).toBeUndefined();
  });

  it("atomically consumes a one-use state nonce and refuses replay or other user", async () => {
    const backing = fakeSqlite();
    const vault = new ClickUpUserConnection(backing.state, { CLICKUP_TOKEN_KEY: encryptedKey });
    const nonceHash = "a".repeat(64);
    const now = Date.now();
    const started = await call(vault, "begin", {
      subject: "github:11",
      nonceHash,
      expiresAt: now + 50_000,
    });
    expect(started.data["accepted"]).toBe(true);
    expect(
      (await call(vault, "consume", { subject: "github:22", nonceHash })).data["consumed"],
    ).toBe(false);
    expect(
      (await call(vault, "consume", { subject: "github:11", nonceHash })).data["consumed"],
    ).toBe(true);
    expect(
      (await call(vault, "consume", { subject: "github:11", nonceHash })).data["consumed"],
    ).toBe(false);
  });

  it("fails closed without token-encryption secret and does not store plaintext", async () => {
    const backing = fakeSqlite();
    const vault = new ClickUpUserConnection(backing.state, {});
    const result = await call(vault, "store", {
      subject: "github:11",
      accessToken: "synthetic-personal-token-for-tests",
      clickupUserId: "707",
      workspaceId: "999",
      workspaceExclusive: true,
    });
    expect(result.status).toBe(503);
    expect(backing.stored()).toBeUndefined();
  });
});
