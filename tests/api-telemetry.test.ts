import { describe, expect, it, vi } from "vitest";
import {
  createApiTelemetry,
  flushApiTelemetry,
  validApiMetric,
} from "../src/clickup/api-telemetry.js";
import type { ReadGrant } from "../src/clickup/policy.js";

describe("API response telemetry", () => {
  it("counts only ClickUp responses and transport failures without retaining URL or payload", async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockRejectedValueOnce(new Error("network failure"))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const telemetry = createApiTelemetry(upstream);
    const task = "https://api.clickup.com/api/v2/task/private-id?private-query=secret";
    await telemetry.fetch(task);
    await telemetry.fetch(task);
    await expect(telemetry.fetch(task)).rejects.toThrow("network failure");
    await telemetry.fetch("https://example.com/private-file");
    expect(telemetry.snapshot()).toMatchObject([
      { category: "v2:task", method: "GET", status: 200, count: 1 },
      { category: "v2:task", method: "GET", status: 429, count: 1 },
      { category: "v2:task", method: "GET", status: 0, count: 1 },
    ]);
    expect(telemetry.snapshot().every(validApiMetric)).toBe(true);
    expect(JSON.stringify(telemetry.snapshot())).not.toContain("private");
    expect(upstream).toHaveBeenCalledTimes(4);
  });

  it("batches telemetry once and never replaces the original tool outcome on storage failure", async () => {
    const requests = vi.fn(async (_request: Request) => {
      throw new Error("telemetry offline");
    });
    const grant = {
      subject: "github:11",
      clickupUserId: "707",
      quota: { idFromName: (name: string) => name, get: () => ({ fetch: requests }) },
    } as unknown as ReadGrant;
    const row = {
      category: "v3:chat",
      method: "POST",
      status: 201,
      count: 1,
      total_ms: 10,
      max_ms: 10,
    };
    await expect(
      flushApiTelemetry(grant, "clickup_send_chat_message", [row]),
    ).resolves.toBeUndefined();
    expect(requests).toHaveBeenCalledTimes(1);
    const request = requests.mock.calls[0]![0];
    expect(new URL(request.url).pathname).toBe("/api-metrics");
    expect(await request.json()).toMatchObject({
      operation: "clickup_send_chat_message",
      metrics: [row],
    });
    await flushApiTelemetry(grant, "clickup_get_api_diagnostics", []);
    expect(requests).toHaveBeenCalledTimes(1);
  });
});
