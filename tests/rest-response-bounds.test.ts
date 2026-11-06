import { describe, expect, it, vi } from "vitest";
import { runCatalogOperation } from "../src/clickup/catalog-runtime.js";
import type { ReadGrant } from "../src/clickup/policy.js";

const grant = (): ReadGrant => ({
  subject: "github:qa",
  clickupUserId: "707",
  workspaceId: "555",
  listId: "12345",
  resourceScope: "workspace",
  apiToken: "synthetic-only",
  quota: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
  },
});

function largeJsonResponse(onCancel: () => void, headers: Record<string, string> = {}) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_000_001));
      },
      cancel() {
        onCancel();
      },
    }),
    { status: 200, headers: { "content-type": "application/json", ...headers } },
  );
}

describe("bounded ClickUp REST response reads (#49)", () => {
  it("cancels oversized chunked GET responses instead of buffering them", async () => {
    let cancelled = false;
    const fetcher = vi.fn(async () => largeJsonResponse(() => (cancelled = true)));
    await expect(
      runCatalogOperation("clickup_get_workspace_members", {}, grant(), fetcher as typeof fetch),
    ).rejects.toThrow("CLICKUP_BAD_RESPONSE");
    expect(cancelled).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("never repeats an ambiguous task-creation write after an oversized response", async () => {
    let cancelled = false;
    let posted = 0;
    const fetcher = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(request)).pathname;
      if (path === "/api/v2/list/12345")
        return Response.json({ id: "12345", space: { id: "777" } });
      if (path === "/api/v2/team/555/space")
        return Response.json({ spaces: [{ id: "777" }] });
      if (path === "/api/v2/list/12345/task" && init?.method === "POST") {
        posted++;
        return largeJsonResponse(() => (cancelled = true));
      }
      throw Error("Unexpected API route " + path);
    });
    await expect(
      runCatalogOperation(
        "clickup_create_task",
        { list_id: "12345", new_task: { name: "Synthetic non-customer QA" } },
        grant(),
        fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_WRITE_OUTCOME_UNKNOWN");
    expect(cancelled).toBe(true);
    expect(posted).toBe(1);
  });

  it("rejects and cancels oversized declared JSON bodies before reading", async () => {
    let cancelled = false;
    const fetcher = vi.fn(async () =>
      largeJsonResponse(() => (cancelled = true), { "content-length": "2000000" }),
    );
    await expect(
      runCatalogOperation("clickup_get_workspace_members", {}, grant(), fetcher as typeof fetch),
    ).rejects.toThrow("CLICKUP_BAD_RESPONSE");
    expect(cancelled).toBe(true);
  });

  it("rejects invalid Content-Length without treating a GET as success", async () => {
    let cancelled = false;
    const fetcher = vi.fn(async () =>
      largeJsonResponse(() => (cancelled = true), { "content-length": "invalid" }),
    );
    await expect(
      runCatalogOperation("clickup_get_workspace_members", {}, grant(), fetcher as typeof fetch),
    ).rejects.toThrow("CLICKUP_BAD_RESPONSE");
    expect(cancelled).toBe(true);
  });
});
