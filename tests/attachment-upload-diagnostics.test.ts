import { describe, expect, it, vi } from "vitest";
import { runCatalogOperation } from "../src/clickup/catalog-runtime.js";
import type { ReadGrant } from "../src/clickup/policy.js";

const grant = (): ReadGrant => ({
  subject: "github:11",
  clickupUserId: "707",
  workspaceId: "555",
  listId: "12345",
  resourceScope: "workspace",
  apiToken: "test-secret-should-not-leak",
  quota: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
  },
});

describe("ClickUp multipart upload diagnostic codes", () => {
  it.each([
    [400, "UPLOAD_004", "CLICKUP_ATTACHMENT_HTTP_400_UPLOAD_004"],
    [400, "UPLOAD_002", "CLICKUP_ATTACHMENT_HTTP_400_UPLOAD_002"],
    [413, "GBUSED_005", "CLICKUP_ATTACHMENT_HTTP_413_GBUSED_005"],
    [415, "bad-unsafe-string", "CLICKUP_ATTACHMENT_HTTP_415"],
    [500, "INTERNAL", "CLICKUP_WRITE_OUTCOME_UNKNOWN"],
  ])("preserves rejected HTTP %i and safely whitelisted ECODE %s", async (status, code, expected) => {
    let uploads = 0;
    const fetcher = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(request));
      if (url.pathname === "/api/v2/task/abc123/attachment" && init?.method === "POST") {
        uploads++;
        const form = init.body as FormData;
        expect(form.get("attachment[0]")).not.toBeNull();
        const headers = init.headers as Record<string, string>;
        expect(headers["Content-Type"]).toBeUndefined();
        expect(headers["Authorization"]).toBe("test-secret-should-not-leak");
        return Response.json({ ECODE: code, err: "private customer details" }, { status });
      }
      if (url.pathname === "/api/v2/task/abc123")
        return Response.json({ id: "abc123", list: { id: "12345" } });
      if (url.pathname === "/api/v2/list/12345")
        return Response.json({ id: "12345", space: { id: "777" } });
      if (url.pathname === "/api/v2/team/555/space")
        return Response.json({ spaces: [{ id: "777" }] });
      throw Error("Unexpected request " + url.pathname);
    });
    await expect(
      runCatalogOperation(
        "clickup_attach_file_to_task",
        {
          task_id: "abc123",
          file_name: "test.png",
          file_base64: btoa("small test image"),
          media_type: "image/png",
        },
        grant(),
        fetcher as typeof fetch,
      ),
    ).rejects.toThrow(expected);
    expect(uploads).toBe(1);
  });

  it("returns HTTP status without parsing non-JSON text or exposing it", async () => {
    const fetcher = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(request));
      if (init?.method === "POST")
        return new Response("private diagnostic response", { status: 400 });
      if (url.pathname === "/api/v2/task/abc123")
        return Response.json({ id: "abc123", list: { id: "12345" } });
      if (url.pathname === "/api/v2/list/12345")
        return Response.json({ id: "12345", space: { id: "777" } });
      return Response.json({ spaces: [{ id: "777" }] });
    });
    await expect(
      runCatalogOperation(
        "clickup_attach_file_to_task",
        { task_id: "abc123", file_name: "test.txt", file_base64: btoa("Hi") },
        grant(),
        fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_ATTACHMENT_HTTP_400");
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
});
