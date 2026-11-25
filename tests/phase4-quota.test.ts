import { afterEach, describe, expect, it, vi } from "vitest";
import { ClickUpQuota } from "../src/clickup/quota-object.js";

/** Simulates the persistent upstream cooldown table without live credentials. */
function createStorage() {
  let blockedUntil = 0;
  const statements: string[] = [];
  const pending = new Map<
    string,
    {
      subject: string;
      clickup_user_id: string;
      generation: string;
      created_ms: number;
      claimed: number;
    }
  >();
  let claimedAttachment: string | null = null;
  const exec = (sql: string, ...params: (number | string)[]) => {
    statements.push(sql);
    if (sql.startsWith("CREATE TABLE") || sql.startsWith("INSERT OR IGNORE")) return {};
    if (sql.startsWith("SELECT blocked_until"))
      return { one: () => ({ blocked_until_ms: blockedUntil }) };
    if (sql.startsWith("SELECT subject, clickup_user_id")) {
      const row = pending.get(String(params[0]));
      return { toArray: () => (row ? [row] : []) };
    }
    if (sql.startsWith("SELECT attachment_id FROM file_claim"))
      return { toArray: () => (claimedAttachment ? [{ attachment_id: claimedAttachment }] : []) };
    if (sql.startsWith("DELETE FROM file_pending")) {
      for (const [key, value] of pending) {
        if (value.claimed === 0 && value.created_ms < Number(params[0])) pending.delete(key);
      }
      return {};
    }
    if (sql.startsWith("SELECT COUNT(*) AS count FROM file_pending"))
      return { one: () => ({ count: pending.size }) };
    if (sql.startsWith("INSERT INTO file_pending")) {
      const [id, subject, user, generation, timestamp] = params;
      pending.set(String(id), {
        subject: String(subject),
        clickup_user_id: String(user),
        generation: String(generation),
        created_ms: Number(timestamp),
        claimed: 0,
      });
      return {};
    }
    if (sql.startsWith("INSERT INTO file_claim")) {
      if (claimedAttachment !== null) throw Error("duplicate claim");
      claimedAttachment = String(params[0]);
      return {};
    }
    if (sql.startsWith("UPDATE file_pending SET claimed")) {
      const row = pending.get(String(params[0]));
      if (row) row.claimed = 1;
      return {};
    }
    if (sql.startsWith("UPDATE limits SET blocked_until")) {
      blockedUntil = Math.max(blockedUntil, Number(params[0]));
      return {};
    }
    throw new Error("Unexpected SQL: " + sql);
  };
  const state = {
    storage: { sql: { exec }, transactionSync: (fn: () => unknown) => fn() },
  } as unknown as DurableObjectState;
  return { state, statements };
}

async function invoke(quota: ClickUpQuota, subject: string, route = "/reserve", until?: number) {
  const response = await quota.fetch(
    new Request("https://internal.invalid" + route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject, ...(until === undefined ? {} : { until }) }),
    }),
  );
  return response.json() as Promise<{ allowed: boolean; retryAfterMs?: number }>;
}

async function fileLedger(
  quota: ClickUpQuota,
  action: "register" | "verify" | "claim",
  attachmentId: string,
  subject = "github:11",
  clickupUserId = "707",
  generation = "oauth-gen-1",
) {
  const response = await quota.fetch(
    new Request("https://internal.invalid/file-pending-" + action, {
      method: "POST",
      body: JSON.stringify({ subject, clickupUserId, generation, attachmentId }),
    }),
  );
  expect(response.ok).toBe(true);
  return (await response.json()) as { allowed: boolean };
}

afterEach(() => vi.useRealTimers());

describe("ClickUp upstream cooldown without self-imposed rate caps", () => {
  it("permits 120 consecutive calls from one user without an artificial cap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T10:00:00Z"));
    const store = createStorage();
    const quota = new ClickUpQuota(store.state);
    for (let i = 0; i < 120; i++) {
      expect((await invoke(quota, "github:11")).allowed).toBe(true);
    }
    expect(store.statements.some((sql) => sql.includes("reservations"))).toBe(false);
  });

  it("permits 160 calls from four users without an artificial shared cap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T10:00:00Z"));
    const store = createStorage();
    const quota = new ClickUpQuota(store.state);
    const results = await Promise.all(
      Array.from({ length: 160 }, (_, i) => invoke(quota, "github:" + (11 + (i % 4)))),
    );
    expect(results.every((result) => result.allowed)).toBe(true);
    expect((await invoke(new ClickUpQuota(store.state), "github:11")).allowed).toBe(true);
  });

  it("still respects actual upstream 429 cooldown and rejects forged subjects", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T10:00:00Z"));
    const store = createStorage();
    const quota = new ClickUpQuota(store.state);
    const until = Date.now() + 30_000;
    expect((await invoke(quota, "github:11", "/cooldown", until)).allowed).toBe(true);
    const restarted = new ClickUpQuota(store.state);
    const blocked = await invoke(restarted, "github:22");
    expect(blocked).toEqual({ allowed: false, retryAfterMs: 30_000 });
    const invalid = await quota.fetch(
      new Request("https://internal.invalid/reserve", {
        method: "POST",
        body: JSON.stringify({ subject: "github:0" }),
      }),
    );
    expect(invalid.status).toBe(400);
    vi.advanceTimersByTime(30_001);
    expect((await invoke(restarted, "github:22")).allowed).toBe(true);
  });
});

describe("durable file attachment provenance and atomic one-time association", () => {
  it("requires the original actor and OAuth credential generation", async () => {
    const quota = new ClickUpQuota(createStorage().state);
    expect((await fileLedger(quota, "register", "uploaded-file")).allowed).toBe(true);
    expect((await fileLedger(quota, "verify", "uploaded-file", "github:22")).allowed).toBe(false);
    expect((await fileLedger(quota, "claim", "uploaded-file", "github:22")).allowed).toBe(false);
    expect(
      (await fileLedger(quota, "verify", "uploaded-file", "github:11", "707", "changed-generation"))
        .allowed,
    ).toBe(false);
    expect((await fileLedger(quota, "verify", "uploaded-file")).allowed).toBe(true);
  });

  it("permits one association claim across parallel requests and prevents replay", async () => {
    const quota = new ClickUpQuota(createStorage().state);
    expect((await fileLedger(quota, "register", "first-file")).allowed).toBe(true);
    expect((await fileLedger(quota, "register", "second-file")).allowed).toBe(true);
    const results = await Promise.all([
      fileLedger(quota, "claim", "first-file"),
      fileLedger(quota, "claim", "second-file"),
    ]);
    expect(results.filter((v) => v.allowed)).toHaveLength(1);
    expect((await fileLedger(quota, "claim", "first-file")).allowed).toBe(false);
    expect((await fileLedger(quota, "claim", "second-file")).allowed).toBe(false);
    expect((await fileLedger(quota, "register", "third-file")).allowed).toBe(false);
  });

  it("rejects expired pending records before association", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-25T09:00:00Z"));
    const quota = new ClickUpQuota(createStorage().state);
    expect((await fileLedger(quota, "register", "expired-file")).allowed).toBe(true);
    vi.advanceTimersByTime(16 * 60_000);
    expect((await fileLedger(quota, "verify", "expired-file")).allowed).toBe(false);
    expect((await fileLedger(quota, "claim", "expired-file")).allowed).toBe(false);
  });
});
