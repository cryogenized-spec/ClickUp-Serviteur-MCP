import { describe, expect, it, vi } from "vitest";
import { runCatalogOperation } from "../src/clickup/catalog-runtime.js";
import type { ReadGrant } from "../src/clickup/policy.js";

const grant: ReadGrant = {
  subject: "github:11",
  clickupUserId: "707",
  workspaceId: "555",
  listId: "12345",
  resourceScope: "workspace",
  apiToken: "person-707",
  quota: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
  },
};

const uuid = "7689a169-a000-4985-8676-6902b96d6627";
const makeEvent = (i: number, taskId = "abc123") => ({
  event_key: `${uuid}:history${String(i).padStart(3, "0")}`,
  task_id: taskId,
  event: i % 2 === 0 ? "taskCreated" : "taskCommentPosted",
  received_at: 123_400 + i,
});

function fixture(events: ReturnType<typeof makeEvent>[], rateLimitTask?: string) {
  const requests = vi.fn(async (request: Request) => {
    expect(request.method).toBe("GET");
    const url = new URL(request.url);
    const after = Number(url.searchParams.get("after_time") ?? 0);
    const afterKey = url.searchParams.get("after_key") ?? "";
    const remaining = events.filter(
      (event) =>
        event.received_at > after ||
        (event.received_at === after && event.event_key > afterKey),
    );
    return Response.json({
      events: remaining.slice(0, 10),
      incomplete: remaining.length > 10,
    });
  });
  const api = vi.fn(async (request: RequestInfo | URL) => {
    const path = new URL(String(request)).pathname;
    if (path === "/api/v2/team/555/space")
      return Response.json({ spaces: [{ id: "777" }] });
    if (path === "/api/v2/list/12345")
      return Response.json({ id: "12345", space: { id: "777" } });
    const task = /^\/api\/v2\/task\/(abc123|def456)$/.exec(path)?.[1];
    if (task) {
      if (task === rateLimitTask) return Response.json({}, { status: 429 });
      return Response.json({
        id: task,
        name: `Verified ${task}`,
        list: { id: "12345" },
        status: { status: "open" },
        url: `https://app.clickup.com/t/${task}`,
      });
    }
    throw Error(`Unexpected upstream request: ${path}`);
  });
  return {
    requests,
    api,
    enrichedGrant: {
      ...grant,
      webhookEvents: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: requests }),
      },
    },
  };
}

describe("pending activity batched pagination", () => {
  it("reads more than one ten-event storage page and groups verified tasks", async () => {
    const events = Array.from({ length: 27 }, (_, i) =>
      makeEvent(i, i % 2 === 0 ? "abc123" : "def456"),
    );
    const f = fixture(events);
    const response = await runCatalogOperation(
      "clickup_get_pending_activity",
      { max_results: 50 },
      f.enrichedGrant,
      f.api as typeof fetch,
    );
    expect(response).toMatchObject({
      events_scanned: 27,
      pages_scanned: 3,
      incomplete: false,
      next_event_after_time: null,
      next_event_after_key: null,
      read_only: true,
      interrupted_reason: null,
    });
    expect(f.requests).toHaveBeenCalledTimes(3);
    expect((response["tasks"] as Array<{ events: unknown[] }>).map((item) => item.events.length))
      .toEqual([14, 13]);
    expect(f.api.mock.calls.filter(([request]) => String(request).includes("/task/"))).toHaveLength(2);
    expect(f.requests.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
  });

  it("returns the exact cursor at a result cap without skipping later events", async () => {
    const events = Array.from({ length: 27 }, (_, i) => makeEvent(i));
    const f = fixture(events);
    const first = await runCatalogOperation(
      "clickup_get_pending_activity",
      { max_results: 15 },
      f.enrichedGrant,
      f.api as typeof fetch,
    );
    expect(first).toMatchObject({
      events_scanned: 15,
      incomplete: true,
      next_event_after_time: events[14].received_at,
      next_event_after_key: events[14].event_key,
    });
    const second = await runCatalogOperation(
      "clickup_get_pending_activity",
      {
        max_results: 50,
        event_after_time: first["next_event_after_time"],
        event_after_key: first["next_event_after_key"],
      },
      f.enrichedGrant,
      f.api as typeof fetch,
    );
    expect(second).toMatchObject({ events_scanned: 12, incomplete: false });
    const firstEvents = (first["tasks"] as Array<{ events: Array<{ event_key: string }> }>).flatMap(
      (t) => t.events.map((e) => e.event_key),
    );
    const secondEvents = (second["tasks"] as Array<{ events: Array<{ event_key: string }> }>).flatMap(
      (t) => t.events.map((e) => e.event_key),
    );
    expect([...firstEvents, ...secondEvents]).toEqual(events.map((e) => e.event_key));
  });

  it("returns an explicit partial result and does not consume a rate-limited event", async () => {
    const events = [makeEvent(0), makeEvent(1, "def456"), makeEvent(2, "abc123")];
    const f = fixture(events, "def456");
    const response = await runCatalogOperation(
      "clickup_get_pending_activity",
      { max_results: 50 },
      f.enrichedGrant,
      f.api as typeof fetch,
    );
    expect(response).toMatchObject({
      events_scanned: 1,
      incomplete: true,
      partial: true,
      interrupted_reason: "clickup_rate_limited",
      next_event_after_time: events[0].received_at,
      next_event_after_key: events[0].event_key,
    });
    expect((response["tasks"] as Array<{ events: unknown[] }>)[0].events).toHaveLength(1);
    expect(f.requests).toHaveBeenCalledTimes(1);
  });
});
