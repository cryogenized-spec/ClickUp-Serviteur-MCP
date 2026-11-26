import type { ReadGrant } from "./policy.js";

const v2Categories = new Set([
  "task",
  "list",
  "team",
  "space",
  "folder",
  "comment",
  "view",
  "checklist",
  "goal",
  "key_result",
  "time_entry",
  "webhook",
  "user",
]);
const v3Categories = new Set(["chat", "docs", "tasks", "attachments", "folders", "lists"]);
const methods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

export interface ApiMetric {
  category: string;
  method: string;
  status: number;
  count: number;
  total_ms: number;
  max_ms: number;
}

export function validApiMetric(value: unknown): value is ApiMetric {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const category = row["category"];
  const method = row["method"];
  const status = row["status"];
  const count = row["count"];
  const total = row["total_ms"];
  const max = row["max_ms"];
  return (
    typeof category === "string" &&
    (category === "other" ||
      (category.startsWith("v2:") && v2Categories.has(category.slice(3))) ||
      (category.startsWith("v3:") && v3Categories.has(category.slice(3)))) &&
    typeof method === "string" &&
    methods.has(method) &&
    typeof status === "number" &&
    Number.isInteger(status) &&
    (status === 0 || (status >= 100 && status <= 599)) &&
    typeof count === "number" &&
    Number.isSafeInteger(count) &&
    count > 0 &&
    typeof total === "number" &&
    Number.isSafeInteger(total) &&
    total >= 0 &&
    typeof max === "number" &&
    Number.isSafeInteger(max) &&
    max >= 0 &&
    max <= total
  );
}

export function createApiTelemetry(fetcher: typeof fetch) {
  const metrics = new Map<string, ApiMetric>();
  const measured: typeof fetch = async (input, init) => {
    let category: string | undefined;
    let method = "GET";
    try {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.protocol === "https:" && url.hostname === "api.clickup.com") {
        const parts = url.pathname.split("/").filter(Boolean);
        const candidate = parts[2] ?? "";
        const nested = parts[4] ?? "";
        category =
          parts[0] === "api" && parts[1] === "v2" && v2Categories.has(candidate)
            ? "v2:" + candidate
            : parts[0] === "api" &&
                parts[1] === "v3" &&
                candidate === "workspaces" &&
                v3Categories.has(nested)
              ? "v3:" + nested
              : "other";
        method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      }
    } catch {
      // Invalid inputs are left to the original fetch implementation.
    }
    if (!category || !methods.has(method)) return fetcher(input, init);
    const start = performance.now();
    let status = 0;
    try {
      const response = await fetcher(input, init);
      status = response.status;
      return response;
    } finally {
      // This is response-header latency, not body parsing or complete tool latency.
      const elapsed = Math.max(0, Math.round(performance.now() - start));
      const key = JSON.stringify([category, method, status]);
      const row = metrics.get(key) ?? {
        category,
        method,
        status,
        count: 0,
        total_ms: 0,
        max_ms: 0,
      };
      row.count++;
      row.total_ms += elapsed;
      row.max_ms = Math.max(row.max_ms, elapsed);
      metrics.set(key, row);
    }
  };
  return {
    fetch: measured,
    snapshot: () => [...metrics.values()].map((row) => ({ ...row })),
  };
}

/** Best-effort batched telemetry; never convert an upstream success into a failure. */
export async function flushApiTelemetry(
  grant: ReadGrant,
  operation: string,
  metrics: ApiMetric[],
): Promise<void> {
  if (!metrics.length) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = new AbortController();
  try {
    const stub = grant.quota.get(
      grant.quota.idFromName("clickup-account:" + grant.clickupUserId) as never,
    );
    await Promise.race([
      stub.fetch(
        new Request("https://internal.invalid/api-metrics", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subject: grant.subject, operation, metrics }),
          signal: abort.signal,
        }),
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          abort.abort();
          resolve();
        }, 1000);
      }),
    ]);
  } catch {
    // Telemetry is nonessential and must not change the original tool outcome.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
