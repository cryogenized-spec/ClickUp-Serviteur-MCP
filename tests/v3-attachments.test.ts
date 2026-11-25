import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCatalogOperation } from "../src/clickup/catalog-runtime.js";
import { filePendingLedger } from "../src/clickup/file-field-ledger.js";
import type { ReadGrant } from "../src/clickup/policy.js";

// Simulates the same per-field durable ledger for multiple grant instances.
const pendingUploads = new Map<string, string>();
const claimedFields = new Set<string>();
beforeEach(() => {
  pendingUploads.clear();
  claimedFields.clear();
});
const quota = {
  idFromName: (name: string) => name,
  get: (id: never) => ({
    fetch: async (request: Request) => {
      const route = new URL(request.url).pathname;
      if (route === "/reserve") return Response.json({ allowed: true });
      const body = (await request.json()) as Record<string, string>;
      const field = String(id);
      const key = field + "/" + body["attachmentId"];
      const owner = JSON.stringify([body["subject"], body["clickupUserId"], body["generation"]]);
      const recorded = pendingUploads.get(key);
      const match = recorded === owner;
      if (route === "/file-pending-register") {
        if (claimedFields.has(field) || recorded) return Response.json({ allowed: false });
        pendingUploads.set(key, owner);
        return Response.json({ allowed: true });
      }
      if (route === "/file-pending-verify") return Response.json({ allowed: match });
      if (route === "/file-pending-claim") {
        if (!match || claimedFields.has(field)) return Response.json({ allowed: false });
        claimedFields.add(field);
        return Response.json({ allowed: true });
      }
      throw Error("Unexpected ledger route " + route);
    },
  }),
};

function grant(scope: "workspace" | "list" = "workspace"): ReadGrant {
  return {
    subject: "github:11",
    clickupUserId: "707",
    workspaceId: "555",
    listId: "12345",
    resourceScope: scope,
    apiToken: "private-test-token",
    quota,
  };
}

function fixture(
  options: { foreign?: boolean; rejectStorage?: boolean; v3NotFound?: boolean } = {},
) {
  let fieldValue: unknown = null;
  const requests: { path: string; method: string; init?: RequestInit }[] = [];
  const f = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(request)).pathname;
    const method = init?.method ?? "GET";
    requests.push({ path, method, ...(init ? { init } : {}) });
    if (path === "/api/v2/team/555/space") return Response.json({ spaces: [{ id: "777" }] });
    if (path === "/api/v2/list/12345") return Response.json({ id: "12345", space: { id: "777" } });
    if (path === "/api/v2/list/98765") return Response.json({ id: "98765", space: { id: "888" } });
    if (path === "/api/v2/list/12345/field")
      return Response.json({ fields: [{ id: "file-field", type: "attachment" }] });
    if (path === "/api/v2/task/abc123")
      return Response.json({
        id: "abc123",
        name: "Synthetic QA task",
        list: { id: options.foreign ? "98765" : "12345" },
        custom_fields: [{ id: "file-field", type: "attachment", value: fieldValue }],
        attachments: [
          {
            id: "existing.jpg",
            title: "existing.jpg",
            size: 100,
            url: "https://signed-private.example.com/file",
          },
        ],
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
      if (options.v3NotFound) return Response.json({ error: "missing" }, { status: 404 });
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
          { id: "second-file", parent_id: "file-field", title: "another.pdf" },
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

  it("falls back to verified task metadata when v3 attachment GET responds 404", async () => {
    const api = fixture({ v3NotFound: true });
    const read = await runCatalogOperation(
      "clickup_get_task_attachments",
      { task_id: "abc123", max_results: 3 },
      grant(),
      api.f as typeof fetch,
    );
    expect(read).toMatchObject({
      source: "clickup-api-v2-task-fallback",
      attachments: [{ id: "existing.jpg", title: "existing.jpg" }],
      next_attachment_cursor: null,
      incomplete: true,
    });
    expect(JSON.stringify(read)).not.toContain("signed-private.example.com");
    expect(api.requests.some((entry) => entry.method === "POST")).toBe(false);
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

  it("does not reveal or associate another task's shared-field attachment by opaque ID", async () => {
    const api = fixture();
    const g = grant("workspace");
    await expect(
      runCatalogOperation(
        "clickup_get_file_field_attachments",
        { task_id: "abc123", field_id: "file-field", attachment_id: "other-task-file" },
        g,
        api.f as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    await expect(
      runCatalogOperation(
        "clickup_associate_file_field_attachment",
        {
          task_id: "abc123",
          field_id: "file-field",
          attachment_id: "other-task-file",
          confirm_file_association: true,
        },
        g,
        api.f as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(api.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  it("permits only one claim when two valid uploads race for the same empty field", async () => {
    const api = fixture();
    const g = grant();
    expect(await filePendingLedger(g, "abc123", "file-field", "uploaded-field", "register")).toBe(
      true,
    );
    expect(await filePendingLedger(g, "abc123", "file-field", "second-file", "register")).toBe(
      true,
    );
    const associate = (attachment_id: string) =>
      runCatalogOperation(
        "clickup_associate_file_field_attachment",
        {
          task_id: "abc123",
          field_id: "file-field",
          attachment_id,
          confirm_file_association: true,
        },
        g,
        api.f as typeof fetch,
      );
    const results = await Promise.allSettled([
      associate("uploaded-field"),
      associate("second-file"),
    ]);
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect(api.requests.filter((r) => r.method === "POST")).toHaveLength(1);
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
