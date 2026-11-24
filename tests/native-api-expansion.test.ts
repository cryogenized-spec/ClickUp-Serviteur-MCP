import { describe, expect, it, vi } from "vitest";
import { runCatalogOperation } from "../src/clickup/catalog-runtime.js";
import type { ReadGrant } from "../src/clickup/policy.js";
import { verifyClickUpWebhookSignature } from "../src/clickup/webhook-signature.js";

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

const fixture = () =>
  vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(request));
    const path = url.pathname;
    if (path === "/api/v2/team/555/shared")
      return Response.json({
        shared: {
          tasks: [{ id: "abc123", name: "Shared task" }],
          lists: [{ id: "12345", name: "Shared List" }],
          folders: [],
        },
      });
    if (path === "/api/v2/team/555/space") return Response.json({ spaces: [{ id: "777" }] });
    if (path === "/api/v2/list/12345") return Response.json({ id: "12345", space: { id: "777" } });
    if (path === "/api/v2/task/abc123" || path === "/api/v2/task/def456")
      return Response.json({
        id: path.split("/").at(-1),
        name: "Task",
        list: { id: "12345" },
        date_updated: "1234",
      });
    if (path === "/api/v3/workspaces/555/attachments/abc123/attachments")
      return Response.json({
        data: [{ id: "att.png", title: "Image", url: "https://signed.invalid/private" }],
        next_cursor: "next",
      });
    if (path === "/api/v2/team/555/list_template" || path === "/api/v2/team/555/folder_template")
      return Response.json({ templates: [{ id: "t-123", name: "Template" }] });
    if (path === "/api/v2/space/777/list_template/t-123" && init?.method === "POST")
      return Response.json({ id: "12346" });
    if (path === "/api/v2/task/abc123/merge" && init?.method === "POST")
      return Response.json({ id: "abc123" });
    if (path === "/api/v2/team/555/webhook")
      return Response.json({
        webhooks: [{ id: "hook", secret: "secret-value", endpoint: "https://private.invalid" }],
      });
    throw Error("Unexpected request " + path);
  });

describe("native API expansion", () => {
  it("discovers shared resources and paginates without granting broader List access", async () => {
    const f = fixture();
    await expect(
      runCatalogOperation("clickup_get_shared_resources", { max_results: 1 }, grant, f),
    ).resolves.toMatchObject({
      total: 2,
      next_resource_offset: 1,
      resources: [{ id: "abc123", kind: "tasks" }],
    });
    await expect(
      runCatalogOperation(
        "clickup_get_shared_resources",
        {},
        { ...grant, resourceScope: "list" },
        f,
      ),
    ).rejects.toThrow("CLICKUP_WORKSPACE_SCOPE_REQUIRED");
  });

  it("uses the v3 data envelope and keeps signed attachment URLs out of metadata", async () => {
    const f = fixture();
    const result = await runCatalogOperation(
      "clickup_get_task_attachments",
      { task_id: "abc123" },
      grant,
      f,
    );
    expect(result).toMatchObject({
      attachments: [{ id: "att.png", title: "Image" }],
      next_attachment_cursor: "next",
    });
    expect(JSON.stringify(result)).not.toContain("signed.invalid");
  });

  it("discovers templates and submits one creation only to a verified parent", async () => {
    const f = fixture();
    const result = await runCatalogOperation(
      "clickup_create_list_from_template",
      { hierarchy_template_id: "t-123", space_id: "777", name: "New List" },
      grant,
      f,
    );
    expect(result).toMatchObject({ completion_verified: false, retry_safe: false });
    expect(f.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("requires a fresh merge preview and explicit confirmation", async () => {
    const f = fixture();
    const args = { task_id: "abc123", task_ids: ["def456"] };
    const preview = await runCatalogOperation("clickup_preview_task_merge", args, grant, f);
    expect(preview["merged"]).toBe(false);
    await expect(runCatalogOperation("clickup_merge_tasks", args, grant, f)).rejects.toThrow();
    expect(f.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    await expect(
      runCatalogOperation(
        "clickup_merge_tasks",
        { ...args, confirm_merge: true, expected_merge_fingerprint: preview["fingerprint"] },
        grant,
        f,
      ),
    ).resolves.toMatchObject({ retry_safe: false });
    expect(f.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("returns webhook inventory without secrets or private destinations", async () => {
    const result = await runCatalogOperation("clickup_get_webhooks", {}, grant, fixture());
    expect(result["webhooks"]).toEqual([{ id: "hook" }]);
    expect(JSON.stringify(result)).not.toContain("secret-value");
    expect(JSON.stringify(result)).not.toContain("private.invalid");
  });

  it("verifies the exact raw body signature and rejects tampering", async () => {
    const body = new TextEncoder().encode("test event");
    const secret = "test-signing-secret";
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signed = await crypto.subtle.sign("HMAC", key, body);
    const hex = Array.from(new Uint8Array(signed), (b) => b.toString(16).padStart(2, "0")).join("");
    await expect(verifyClickUpWebhookSignature(body, hex, secret)).resolves.toBe(true);
    await expect(
      verifyClickUpWebhookSignature(new TextEncoder().encode("tampered"), hex, secret),
    ).resolves.toBe(false);
  });
});
