import { afterEach, describe, expect, it, vi } from "vitest";
import { ClickUpQuota } from "../src/clickup/quota-object.js";

/** Simulates the persistent upstream cooldown table without live credentials. */
function createStorage() {
  let blockedUntil = 0;
  const statements: string[] = [];
  const exec = (sql: string, ...params: (number | string)[]) => {
    statements.push(sql);
    if (sql.startsWith("CREATE TABLE") || sql.startsWith("INSERT OR IGNORE")) return {};
    if (sql.startsWith("SELECT blocked_until"))
      return { one: () => ({ blocked_until_ms: blockedUntil }) };
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
