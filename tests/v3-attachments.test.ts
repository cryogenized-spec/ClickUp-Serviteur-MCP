import { describe, expect, it, vi } from "vitest";
import { runCatalogOperation } from "../src/clickup/catalog-runtime.js";
import type { ReadGrant } from "../src/clickup/policy.js";

function grant(scope: "workspace" | "list" = "workspace"): ReadGrant {
  return {
    subject: "github:11",
    clickupUserId: "707",
    workspaceId: "555",
    listId: "12345",
    resourceScope: scope,
    apiToken: "private-test-token",
    quota: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
    },
  };
}

function fixture(options: { foreign?: boolean; rejectStorage?: boolean } = {}) {
  let fieldValue: unknown = null;
  const requests: { path: string; method: string; init?: RequestInit }[] = [];
  const f = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(request)).pathname;
    const method = init?.method ?? "GET";
    requests.push({ path, method, init });
    if (path === "/api/v2/team/555/space") return Response.json({ spaces: [{ id: "777" }] });
    if (path === "/api/v2/list/12345") return Response.json({ id: "12345", space: { id: "777" } });
    if (path === "/api/v2/list/12345/field")
      return Response.json({ fields: [{ id: "file-field", type: "attachment" }] });
    if (path === "/api/v2/task/abc123")
      return Response.json({
        id: "abc123",
        name: "Synthetic QA task",
        list: { id: options.foreign ? "98765" : "12345" },
        custom_fields: [{ id: "file-field", type: "attachment", value: fieldValue }],
      });
    if (path === "/api/v2/task/abc123/field/file-field" && method === "POST") {
      fieldValue = JSON.parse(String(init?.body)).value;
      return Response.json({});
    }
    if (path === "/api/v3/workspaces/555/attachments/abc123/attachments") {
      if (method === "POST") {
        const form = init?.body as FormData;
        expect(form.get("attachment")).toBeInstanceOf(Blob);
        expect(form.get("filename")).toBe("sample.pdf");
        if (options.rejectStorage) return Response.json({ ECODE: "GBUSED_005" }, { status: 400 });
        return Response.json({ id: "uploaded-task", parent_id: "abc123", title: "sample.pdf" });
      }
      return Response.json({
        data: [{ id: "uploaded-task", title: "sample.pdf" }],
        next_cursor: null,
      });
    }
    if (path === "/api/v3/workspaces/555/custom_fields/file-field/attachments") {
      if (method === "POST") {
        const form = init?.body as FormData;
        expect(form.get("attachment")).toBeInstanceOf(Blob);
        return Response.json({
          id: "uploaded-field",
          parent_id: "file-field",
          title: "sample.pdf",
        });
      }
      return Response.json({
        data: [
          { id: "uploaded-field", parent_id: "file-field", title: "sample.pdf" },
          { id: "other-task-file", parent_id: "file-field", title: "private.pdf" },
        ],
        next_cursor: null,
      });
    }
    throw Error("Unexpected endpoint " + method + " " + path);
  });
  return {
    f,
    requests,
    set fieldValue(value: unknown) {
      fieldValue = value;
    },
  };
}

const args = {
  task_id: "abc123",
  file_name: "sample.pdf",
  file_base64: btoa("%PDF-1.7 sample"),
  media_type: "application/pdf",
};

describe("v3 task and Files Custom Field attachment lifecycle", () => {
  it("uses the documented v3 task GET path, not the obsolete 404 route", async () => {
    const api = fixture();
    const read = await runCatalogOperation(
      "clickup_get_task_attachments",
      { task_id: "abc123", max_results: 3 },
      grant(),
      api.f as typeof fetch,
    );
    expect(read).toMatchObject({
      attachments: [{ id: "uploaded-task" }],
      next_attachment_cursor: null,
    });
    expect(api.requests.some((r) => r.path.includes("/attachments/abc123/attachments"))).toBe(true);
  });

  it("uploads task and Files field bytes via v3 and requires a separate association", async () => {
    const api = fixture();
    const taskUpload = await runCatalogOperation(
      "clickup_upload_task_attachment",
      args,
      grant(),
      api.f as typeof fetch,
    );
    expect(taskUpload).toMatchObject({
      attachment_id: "uploaded-task",
      requires_task_association: false,
      retry_safe: false,
    });
    const uploaded = await runCatalogOperation(
      "clickup_upload_file_field_attachment",
      { ...args, field_id: "file-field" },
      grant(),
      api.f as typeof fetch,
    );
    expect(uploaded).toMatchObject({
      attachment_id: "uploaded-field",
      requires_task_association: true,
    });
    const linked = await runCatalogOperation(
      "clickup_associate_file_field_attachment",
      {
        task_id: "abc123",
        field_id: "file-field",
        attachment_id: "uploaded-field",
        confirm_file_association: true,
      },
      grant(),
      api.f as typeof fetch,
    );
    expect(linked).toMatchObject({ linked: true, attachment_id: "uploaded-field" });
    await expect(
      runCatalogOperation(
        "clickup_associate_file_field_attachment",
        {
          task_id: "abc123",
          field_id: "file-field",
          attachment_id: "uploaded-field",
          confirm_file_association: true,
        },
        grant(),
        api.f as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_FILE_FIELD_NOT_EMPTY");
  });

  it("never lists other tasks' files through a shared Files field", async () => {
    const api = fixture();
    api.fieldValue = ["uploaded-field"];
    const read = await runCatalogOperation(
      "clickup_get_file_field_attachments",
      { task_id: "abc123", field_id: "file-field", max_results: 10 },
      grant(),
      api.f as typeof fetch,
    );
    expect(read).toMatchObject({ attachments: [{ id: "uploaded-field" }] });
    expect(JSON.stringify(read)).not.toContain("other-task-file");
    const exact = await runCatalogOperation(
      "clickup_get_file_field_attachments",
      { task_id: "abc123", field_id: "file-field", attachment_id: "uploaded-field" },
      grant(),
      api.f as typeof fetch,
    );
    expect(exact).toMatchObject({ attachments: [{ id: "uploaded-field" }] });
  });

  it("denies foreign or non-Files-field uploads before any v3 POST", async () => {
    const foreign = fixture({ foreign: true });
    await expect(
      runCatalogOperation(
        "clickup_upload_task_attachment",
        args,
        grant(),
        foreign.f as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(foreign.requests.some((r) => r.method === "POST")).toBe(false);
    const api = fixture();
    await expect(
      runCatalogOperation(
        "clickup_upload_file_field_attachment",
        { ...args, field_id: "unknown-field" },
        grant(),
        api.f as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(api.requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("surfaces the real ClickUp storage error instead of claiming upload success", async () => {
    const api = fixture({ rejectStorage: true });
    await expect(
      runCatalogOperation("clickup_upload_task_attachment", args, grant(), api.f as typeof fetch),
    ).rejects.toThrow("CLICKUP_ATTACHMENT_HTTP_400_GBUSED_005");
    expect(api.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });
});
