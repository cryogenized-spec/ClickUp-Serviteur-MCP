import { describe, expect, it, vi } from "vitest";
import { runCatalogOperation } from "../src/clickup/catalog-runtime.js";
import type { ReadGrant } from "../src/clickup/policy.js";

const hookId = "7689a169-a000-4985-8676-6902b96d6627";
const endpoint = "https://company.example.com/clickup/webhook";
const grant: ReadGrant = {
  subject: "github:11",
  clickupUserId: "707",
  workspaceId: "555",
  listId: "12345",
  resourceScope: "workspace",
  apiToken: "synthetic-token",
  quota: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
  },
};
const fileField = "field-file";
function fixture() {
  let value: unknown;
  let hook: Record<string, unknown> | undefined;
  const f = vi.fn(async (req: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(req)).pathname;
    const method = init?.method ?? "GET";
    if (path === "/api/v2/team/555/space") return Response.json({ spaces: [{ id: "777" }] });
    if (path === "/api/v2/list/12345") return Response.json({ id: "12345", space: { id: "777" } });
    if (path === "/api/v2/folder/888") return Response.json({ id: "888", space: { id: "777" } });
    if (path === "/api/v2/task/abc123")
      return Response.json({
        id: "abc123",
        list: { id: "12345" },
        custom_fields: [{ id: fileField, type: "attachment", value }],
      });
    if (path.endsWith("/field")) return Response.json({ fields: [{ id: fileField }] });
    if (path === "/api/v2/task/abc123/field/" + fileField) {
      if (method === "DELETE") value = undefined;
      if (method === "POST") value = JSON.parse(String(init?.body)).value;
      return Response.json({});
    }
    if (path.startsWith("/api/v3/workspaces/555/")) {
      const parent = path.includes("/custom_fields/") ? fileField : "abc123";
      const attachment = { id: "sample.pdf", parent_id: parent, title: "Sample" };
      if (method === "POST") {
        expect(init?.body).toBeInstanceOf(FormData);
        return Response.json(attachment);
      }
      return Response.json({ data: [attachment], next_cursor: "" });
    }
    if (path === "/api/v2/team/555/webhook") {
      if (method === "POST") {
        hook = {
          id: hookId,
          userid: 707,
          team_id: 555,
          endpoint,
          secret: "synthetic-signing-secret",
          health: { status: "active" },
        };
        return Response.json({ id: hookId, webhook: hook });
      }
      return Response.json({ webhooks: hook ? [hook] : [] });
    }
    if (path === "/api/v2/webhook/" + hookId && method === "PUT" && hook) {
      hook = { ...hook, health: { status: "active" } };
      return Response.json({ id: hookId, webhook: hook });
    }
    if (path === "/api/v2/webhook/" + hookId && method === "DELETE") {
      hook = undefined;
      return Response.json({});
    }
    throw Error("Unexpected test endpoint " + path);
  });
  return f;
}

describe("high-priority native API completion", () => {
  it("reads Workspace, Space and Folder fields using exact authorized parents", async () => {
    const f = fixture();
    for (const [level, args] of [
      ["workspace", {}],
      ["space", { space_id: "777" }],
      ["folder", { folder_id: "888" }],
    ] as const) {
      await expect(
        runCatalogOperation("clickup_get_" + level + "_custom_fields", args, grant, f),
      ).resolves.toMatchObject({ fields: [{ id: fileField }], level });
    }
    await expect(
      runCatalogOperation("clickup_get_space_custom_fields", { space_id: "999" }, grant, f),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  });

  it("uploads v3 task and File field attachments and associates only an empty field", async () => {
    const f = fixture();
    const args = { task_id: "abc123", file_name: "sample.pdf", file_base64: btoa("example") };
    await expect(
      runCatalogOperation("clickup_upload_task_attachment", args, grant, f),
    ).resolves.toMatchObject({ attachment_id: "sample.pdf", requires_task_association: false });
    const fieldArgs = { ...args, field_id: fileField };
    await expect(
      runCatalogOperation("clickup_upload_file_field_attachment", fieldArgs, grant, f),
    ).resolves.toMatchObject({ attachment_id: "sample.pdf", requires_task_association: true });
    await expect(
      runCatalogOperation(
        "clickup_get_file_field_attachments",
        { task_id: "abc123", field_id: fileField },
        grant,
        f,
      ),
    ).resolves.toMatchObject({ attachments: [{ id: "sample.pdf" }] });
    const link = {
      task_id: "abc123",
      field_id: fileField,
      attachment_id: "sample.pdf",
      confirm_file_association: true,
    };
    await expect(
      runCatalogOperation("clickup_associate_file_field_attachment", link, grant, f),
    ).resolves.toMatchObject({ linked: true });
    await expect(
      runCatalogOperation("clickup_associate_file_field_attachment", link, grant, f),
    ).rejects.toThrow("CLICKUP_FILE_FIELD_NOT_EMPTY");
    await expect(
      runCatalogOperation(
        "clickup_clear_custom_field",
        { task_id: "abc123", field_id: fileField, confirm_clear: true },
        grant,
        f,
      ),
    ).resolves.toMatchObject({ cleared: true });
  });

  it("manages only the fixed owned webhook and never exposes its signing secret", async () => {
    const f = fixture();
    const registry = vi.fn(async () => new Response(null, { status: 204 }));
    const g = {
      ...grant,
      webhookEndpoint: endpoint,
      webhookEvents: { idFromName: (name: string) => name, get: () => ({ fetch: registry }) },
    };
    const args = { confirm_webhook: true };
    const created = await runCatalogOperation("clickup_create_activity_webhook", args, g, f);
    expect(created).toMatchObject({ webhook_id: hookId, signing_secret_stored: true });
    expect(JSON.stringify(created)).not.toContain("synthetic-signing-secret");
    await expect(
      runCatalogOperation("clickup_create_activity_webhook", args, g, f),
    ).resolves.toMatchObject({ created: false, existing_webhook_ids: [hookId] });
    await expect(
      runCatalogOperation(
        "clickup_update_activity_webhook",
        { ...args, webhook_id: hookId, webhook_status: "active" },
        g,
        f,
      ),
    ).resolves.toMatchObject({ signing_secret_stored: true });
    await expect(
      runCatalogOperation(
        "clickup_delete_activity_webhook",
        { ...args, webhook_id: hookId },
        g,
        f,
      ),
    ).resolves.toMatchObject({ deleted: true });
    expect(registry).toHaveBeenCalledTimes(3);
  });
});
