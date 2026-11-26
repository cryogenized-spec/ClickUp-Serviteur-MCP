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

function fixture(
  events: (ReturnType<typeof makeEvent> & { metadata?: Record<string, unknown> })[],
  rateLimitTask?: string,
  rateLimitAttempts = 1,
  taskFailures: Record<string, number[]> = {},
) {
  let rateLimitFailures = 0;
  const processed = new Map<string, Set<string>>();
  const requests = vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname === "/consumer-processed") {
      expect(request.method).toBe("POST");
      const body = (await request.json()) as { consumer: string; event_keys: string[] };
      const keys = processed.get(body.consumer) ?? new Set<string>();
      for (const key of body.event_keys) keys.add(key);
      processed.set(body.consumer, keys);
      return Response.json({
        consumer: body.consumer,
        processed_event_keys: [...new Set(body.event_keys)],
      });
    }
    expect(request.method).toBe("GET");
    if (url.pathname === "/task-timeline") {
      const selected = events.filter((event) => event.task_id === url.searchParams.get("task_id"));
      return Response.json({ events: selected, incomplete: false });
    }
    if (url.pathname === "/diagnostics")
      return Response.json({ retained: events.length, pending: events.length, retention_days: 7 });
    const after = Number(url.searchParams.get("after_time") ?? 0);
    const afterKey = url.searchParams.get("after_key") ?? "";
    const consumer = url.searchParams.get("consumer");
    const remaining = events.filter(
      (event) =>
        !(consumer && processed.get(consumer)?.has(event.event_key)) &&
        (event.received_at > after || (event.received_at === after && event.event_key > afterKey)),
    );
    return Response.json({
      events: remaining.slice(0, 10),
      incomplete: remaining.length > 10,
    });
  });
  const api = vi.fn(async (request: RequestInfo | URL) => {
    const path = new URL(String(request)).pathname;
    if (path === "/api/v2/team/555/space") return Response.json({ spaces: [{ id: "777" }] });
    if (path === "/api/v2/list/12345") return Response.json({ id: "12345", space: { id: "777" } });
    if (path === "/api/v2/task/abc123/comment")
      return Response.json({
        comments: [
          {
            id: "456",
            date: "123402",
            comment_text: "Follow-up received",
            user: { id: 707, username: "Member" },
          },
        ],
      });
    const task = /^\/api\/v2\/task\/([a-zA-Z0-9_-]+)$/.exec(path)?.[1];
    if (task) {
      if (task === rateLimitTask && rateLimitFailures++ < rateLimitAttempts)
        return Response.json({}, { status: 429 });
      const failure = taskFailures[task]?.shift();
      if (failure !== undefined) return Response.json({}, { status: failure });
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

describe("task activity timeline and diagnostics", () => {
  it("combines chronological comments and webhook hints after a single task verification", async () => {
    const f = fixture([
      makeEvent(0),
      { ...makeEvent(1), metadata: { comment_id: "456" } },
      makeEvent(3, "other"),
    ]);
    const result = await runCatalogOperation(
      "clickup_get_task_activity_timeline",
      { task_id: "abc123" },
      f.enrichedGrant,
      f.api as typeof fetch,
    );
    expect(result).toMatchObject({
      task: { id: "abc123" },
      timeline: [
        { kind: "taskCreated", at_ms: 123400 },
        { kind: "comment", at_ms: 123402, comment_id: "456", text: "Follow-up received" },
      ],
      coverage: { comments_read: 1, webhook_events_read: 2, webhook_incomplete: false },
      incomplete: true,
    });
    expect(
      f.api.mock.calls.filter(
        ([request]) => new URL(String(request)).pathname === "/api/v2/task/abc123",
      ),
    ).toHaveLength(1);
    expect(f.requests).toHaveBeenCalledTimes(1);
  });

  it("does not access retained hints when task verification fails", async () => {
    const f = fixture([makeEvent(0)], undefined, 1, { abc123: [404] });
    await expect(
      runCatalogOperation(
        "clickup_get_task_activity_timeline",
        { task_id: "abc123" },
        f.enrichedGrant,
        f.api as typeof fetch,
      ),
    ).rejects.toThrow();
    expect(f.requests).not.toHaveBeenCalled();
  });

  it("reports unavailable quota metrics explicitly without calling ClickUp", async () => {
    const f = fixture([makeEvent(0)]);
    const result = await runCatalogOperation(
      "clickup_get_api_diagnostics",
      {},
      f.enrichedGrant,
      f.api as typeof fetch,
    );
    expect(result).toMatchObject({
      quota: null,
      webhook: { retained: 1, pending: 1 },
      issues: ["quota_diagnostics_unavailable"],
      incomplete: true,
    });
    expect(f.api).not.toHaveBeenCalled();
  });
});

describe("independent activity consumers and filtering", () => {
  it("filters before task verification and retains a cursor across matching pages", async () => {
    const events = [
      makeEvent(0, "irrelevant"),
      { ...makeEvent(1, "selected"), metadata: { actor_user_id: "707" } },
      makeEvent(2, "other"),
      { ...makeEvent(3, "second"), metadata: { actor_user_id: "707" } },
    ];
    const f = fixture(events);
    const args = {
      activity_consumer: "hourly-watch",
      activity_event_types: ["taskCommentPosted"],
      activity_actor_user_id: "707",
      max_results: 1,
    };
    const first = await runCatalogOperation(
      "clickup_get_pending_activity",
      args,
      f.enrichedGrant,
      f.api as typeof fetch,
    );
    expect(first).toMatchObject({
      consumer: "hourly-watch",
      events_scanned: 2,
      events_filtered_before_verification: 1,
      incomplete: true,
      tasks: [{ task_id: "selected" }],
      next_event_after_key: events[1]!.event_key,
    });
    const second = await runCatalogOperation(
      "clickup_get_pending_activity",
      {
        ...args,
        event_after_time: first["next_event_after_time"],
        event_after_key: first["next_event_after_key"],
      },
      f.enrichedGrant,
      f.api as typeof fetch,
    );
    expect(second).toMatchObject({
      events_scanned: 2,
      events_filtered_before_verification: 1,
      incomplete: false,
      tasks: [{ task_id: "second" }],
    });
    expect(f.api.mock.calls.filter(([request]) => String(request).includes("/task/"))).toHaveLength(
      2,
    );
    expect(
      f.requests.mock.calls.every(
        ([request]) => new URL(request.url).searchParams.get("consumer") === "hourly-watch",
      ),
    ).toBe(true);
  });

  it("reports missing metadata instead of treating it as a confirmed absence of mentions", async () => {
    const f = fixture([makeEvent(1)]);
    const result = await runCatalogOperation(
      "clickup_get_pending_activity",
      { activity_mentioned_user_id: "707" },
      f.enrichedGrant,
      f.api as typeof fetch,
    );
    expect(result).toMatchObject({
      events_scanned: 1,
      events_filtered_before_verification: 1,
      events_filtered_missing_metadata: 1,
      tasks: [],
    });
    expect(f.api).not.toHaveBeenCalled();
  });

  it("marks only the named consumer after authorizing the task", async () => {
    const event = makeEvent(1);
    const f = fixture([event]);
    const result = await runCatalogOperation(
      "clickup_mark_consumer_activity_processed",
      { task_id: "abc123", activity_consumer: "hourly-watch", event_keys: [event.event_key] },
      f.enrichedGrant,
      f.api as typeof fetch,
    );
    expect(result).toMatchObject({
      consumer: "hourly-watch",
      processed_event_keys: [event.event_key],
    });
    expect(f.requests).toHaveBeenCalledTimes(1);
    expect(new URL(f.requests.mock.calls[0]![0].url).pathname).toBe("/consumer-processed");
    const read = (consumer: string) =>
      runCatalogOperation(
        "clickup_get_pending_activity",
        { activity_consumer: consumer },
        f.enrichedGrant,
        f.api as typeof fetch,
      );
    expect(await read("hourly-watch")).toMatchObject({ events_scanned: 0, tasks: [] });
    expect(await read("afternoon-briefing")).toMatchObject({ events_scanned: 1 });
  });
});

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
    expect(
      (response["tasks"] as Array<{ events: unknown[] }>).map((item) => item.events.length),
    ).toEqual([14, 13]);
    expect(f.api.mock.calls.filter(([request]) => String(request).includes("/task/"))).toHaveLength(
      2,
    );
    expect(f.requests.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
    expect(
      f.api.mock.calls.filter(([request]) => String(request).includes("/list/12345")),
    ).toHaveLength(1);
    expect(
      f.api.mock.calls.filter(([request]) => String(request).includes("/team/555/space")),
    ).toHaveLength(1);
  });

  it("exposes only sanitized metadata on verified tasks and none on denied tasks", async () => {
    const metadata = {
      actor_user_id: "183",
      field: "comment",
      comment_id: "648893191",
      mentioned_user_ids: ["707", "707", "invalid"],
      raw_comment: "private comment",
    };
    const events = [
      { ...makeEvent(0), metadata },
      { ...makeEvent(1, "denied"), metadata: { ...metadata, actor_user_id: "999" } },
    ];
    const f = fixture(events, undefined, 1, { denied: [404] });
    const response = await runCatalogOperation(
      "clickup_get_pending_activity",
      {},
      f.enrichedGrant,
      f.api as typeof fetch,
    );
    expect(response).toMatchObject({
      tasks: [
        {
          task_id: "abc123",
          events: [
            {
              metadata: {
                actor_user_id: "183",
                field: "comment",
                comment_id: "648893191",
                mentioned_user_ids: ["707"],
              },
            },
          ],
        },
      ],
      unverified_task_count: 1,
    });
    expect(JSON.stringify(response)).not.toContain("private comment");
    expect(JSON.stringify(response)).not.toContain('"actor_user_id":"999"');
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
      next_event_after_time: events[14]!.received_at,
      next_event_after_key: events[14]!.event_key,
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
    const secondEvents = (
      second["tasks"] as Array<{ events: Array<{ event_key: string }> }>
    ).flatMap((t) => t.events.map((e) => e.event_key));
    expect([...firstEvents, ...secondEvents]).toEqual(events.map((e) => e.event_key));
  });

  it("retries the exact task after successive ClickUp 429 responses without dropping events", async () => {
    const events = [makeEvent(0), makeEvent(1, "def456"), makeEvent(2, "abc123")];
    const f = fixture(events, "def456", 2);
    const wait = vi.fn(async (_ms: number) => undefined);
    const response = await runCatalogOperation(
      "clickup_get_pending_activity",
      { max_results: 50 },
      f.enrichedGrant,
      f.api as typeof fetch,
      wait,
    );
    expect(response).toMatchObject({
      events_scanned: 3,
      incomplete: false,
      partial: false,
      interrupted_reason: null,
      next_event_after_time: null,
      next_event_after_key: null,
    });
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenNthCalledWith(1, 60_000);
    expect(wait).toHaveBeenNthCalledWith(2, 60_000);
    expect(
      f.api.mock.calls.filter(([request]) => String(request).includes("/task/def456")),
    ).toHaveLength(3);
    const eventKeys = (
      response["tasks"] as Array<{ events: Array<{ event_key: string }> }>
    ).flatMap((task) => task.events.map((event) => event.event_key));
    expect(eventKeys.sort()).toEqual(events.map((event) => event.event_key).sort());
    expect(f.requests).toHaveBeenCalledTimes(1);
  });

  it("verifies all distinct tasks without imposing a task-verification ceiling", async () => {
    const events = Array.from({ length: 23 }, (_, i) => makeEvent(i, `task${i}`));
    const f = fixture(events);
    const response = await runCatalogOperation(
      "clickup_get_pending_activity",
      {},
      f.enrichedGrant,
      f.api as typeof fetch,
    );
    expect(response).toMatchObject({
      events_scanned: 23,
      pages_scanned: 3,
      interrupted_reason: null,
      incomplete: false,
      next_event_after_time: null,
      next_event_after_key: null,
    });
    expect(response["tasks"]).toHaveLength(23);
    expect(f.api.mock.calls.filter(([request]) => String(request).includes("/task/"))).toHaveLength(
      23,
    );
  });

  it("reads more than fifty events when no caller limit was requested", async () => {
    const events = Array.from({ length: 57 }, (_, i) =>
      makeEvent(i, i % 2 === 0 ? "abc123" : "def456"),
    );
    const f = fixture(events);
    const response = await runCatalogOperation(
      "clickup_get_pending_activity",
      {},
      f.enrichedGrant,
      f.api as typeof fetch,
    );
    expect(response).toMatchObject({
      events_scanned: 57,
      pages_scanned: 6,
      interrupted_reason: null,
      incomplete: false,
      next_event_after_time: null,
      next_event_after_key: null,
    });
    expect(response["tasks"]).toHaveLength(2);
    expect(
      (response["tasks"] as Array<{ events: unknown[] }>).map((task) => task.events.length),
    ).toEqual([29, 28]);
  });

  it("continues past a direct task 404 without exposing or acknowledging the missing task", async () => {
    const events = [makeEvent(0), makeEvent(1, "missing"), makeEvent(2, "later")];
    const f = fixture(events, undefined, 1, { missing: [404] });
    const response = await runCatalogOperation(
      "clickup_get_pending_activity",
      {},
      f.enrichedGrant,
      f.api as typeof fetch,
    );
    expect(response).toMatchObject({
      events_scanned: 3,
      unverified_task_count: 1,
      task_not_found_count: 1,
      incomplete: true,
      interrupted_reason: null,
      next_event_after_time: null,
    });
    expect((response["tasks"] as Array<{ task_id: string }>).map((t) => t.task_id)).toEqual([
      "abc123",
      "later",
    ]);
    expect(JSON.stringify(response)).not.toContain('"task_id":"missing"');
    expect(f.requests.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
  });

  it("retries transient verification errors on the same event", async () => {
    const events = [makeEvent(0), makeEvent(1, "flaky"), makeEvent(2, "later")];
    const f = fixture(events, undefined, 1, { flaky: [503, 502] });
    const wait = vi.fn(async (_ms: number) => undefined);
    const response = await runCatalogOperation(
      "clickup_get_pending_activity",
      {},
      f.enrichedGrant,
      f.api as typeof fetch,
      wait,
    );
    expect(response).toMatchObject({ events_scanned: 3, incomplete: false });
    expect(wait.mock.calls).toEqual([[1000], [2000]]);
  });

  it("preserves an existing cursor and exposes a sanitized diagnostic on persistent failure", async () => {
    const events = [makeEvent(0), makeEvent(1, "flaky"), makeEvent(2, "later")];
    const f = fixture(events, undefined, 1, { flaky: [503, 503, 503] });
    const wait = vi.fn(async (_ms: number) => undefined);
    const response = await runCatalogOperation(
      "clickup_get_pending_activity",
      { event_after_time: events[0]!.received_at, event_after_key: events[0]!.event_key },
      f.enrichedGrant,
      f.api as typeof fetch,
      wait,
    );
    expect(response).toMatchObject({
      events_scanned: 0,
      incomplete: true,
      interrupted_reason: "task_verification_unavailable",
      interrupted_code: "CLICKUP_UPSTREAM_UNAVAILABLE",
      interrupted_http_status: 503,
      next_event_after_time: events[0]!.received_at,
      next_event_after_key: events[0]!.event_key,
      resume_from_beginning: false,
    });
    expect(response["tasks"]).toEqual([]);
    expect(wait).toHaveBeenCalledTimes(2);
  });
});
