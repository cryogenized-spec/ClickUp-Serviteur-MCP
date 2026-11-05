import { describe, expect, it, vi } from "vitest";
import {
  attachChatGPTFileToTask,
  type ChatGPTProvidedFile,
} from "../src/clickup/chatgpt-uploads.js";
import type { ReadGrant } from "../src/clickup/policy.js";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const pdf = new TextEncoder().encode("%PDF-1.7\nTest");
const file = (name = "photo.png"): ChatGPTProvidedFile => ({
  download_url: "https://files.oaiusercontent.com/signed/file-image",
  file_id: "file_abcdefgh12345",
  file_name: name,
  mime_type: name.endsWith(".pdf") ? "application/pdf" : "image/png",
});
const grant = (scope: "list" | "workspace" = "workspace"): ReadGrant => ({
  subject: "github:11",
  clickupUserId: "707",
  workspaceId: "555",
  listId: "12345",
  resourceScope: scope,
  apiToken: "fake-oauth-only-to-clickup",
  quota: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
  },
});
const json = (data: unknown) => Response.json(data);
function mockHost(
  bytes: Uint8Array,
  options: {
    foreign?: boolean;
    redirect?: boolean;
    tooLarge?: boolean;
    tooLargeStream?: boolean;
  } = {},
) {
  const calls: Array<{ url: URL; init: RequestInit | undefined }> = [];
  let uploaded = false;
  let cancelled = false;
  const fetcher = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(request));
    calls.push({ url, init });
    if (url.hostname.endsWith(".oaiusercontent.com")) {
      if (options.redirect) {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://localhost/private" },
        });
      }
      if (options.tooLargeStream) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 },
        );
      }
      return new Response(bytes, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          ...(options.tooLarge ? { "Content-Length": String(8 * 1024 * 1024 + 1) } : {}),
        },
      });
    }
    if (url.pathname === "/api/v2/task/abc123/attachment" && init?.method === "POST") {
      uploaded = true;
      const body = init.body as FormData;
      expect(body.get("attachment[0]")).not.toBeNull();
      return json({ id: "new-attachment", title: "photo.png", url: "https://clickup.com/asset" });
    }
    if (url.pathname === "/api/v2/task/abc123")
      return json({
        id: "abc123",
        name: "QA fixture",
        list: { id: options.foreign ? "12346" : "12345" },
        attachments: uploaded ? [{ id: "new-attachment" }] : [],
      });
    if (url.pathname === "/api/v2/list/12345") {
      return json({ id: "12345", space: { id: "777" } });
    }
    if (url.pathname === "/api/v2/team/555/space") {
      return json({ spaces: [{ id: "777" }] });
    }
    throw Error("Unexpected endpoint " + url.pathname);
  });
  return {
    fetcher,
    calls,
    get cancelled() {
      return cancelled;
    },
  };
}

describe("ChatGPT attached-file bridge (#78)", () => {
  it("uploads a supplied image and verifies the ClickUp attachment ID", async () => {
    const api = mockHost(png);
    const result = await attachChatGPTFileToTask(
      grant(),
      api.fetcher as typeof fetch,
      "abc123",
      file(),
    );
    expect(result).toMatchObject({
      attachment_id: "new-attachment",
      attachment_name: "photo.png",
      verified_by_readback: true,
      byte_size: png.length,
      media_type: "image/png",
    });
    const hostRequest = api.calls.find((call) => call.url.hostname === "files.oaiusercontent.com");
    expect(hostRequest?.init?.redirect).toBe("manual");
    expect(JSON.stringify(hostRequest?.init?.headers)).not.toContain("fake-oauth-only-to-clickup");
    expect(api.calls.filter((call) => call.init?.method === "POST")).toHaveLength(1);
  });

  it("uploads a PDF with verified type and filename", async () => {
    const api = mockHost(pdf);
    const result = await attachChatGPTFileToTask(
      grant(),
      api.fetcher as typeof fetch,
      "abc123",
      file("report.pdf"),
    );
    expect(result).toMatchObject({ media_type: "application/pdf", byte_size: pdf.length });
    expect(api.calls.filter((call) => call.init?.method === "POST")).toHaveLength(1);
  });

  it("rejects arbitrary URL hosts without any outbound request", async () => {
    const api = mockHost(png);
    await expect(
      attachChatGPTFileToTask(grant(), api.fetcher as typeof fetch, "abc123", {
        ...file(),
        download_url: "http://127.0.0.1/latest/meta-data",
      }),
    ).rejects.toThrow("CLICKUP_FILE_HOST_NOT_ALLOWED");
    expect(api.fetcher).not.toHaveBeenCalled();
  });

  it("does not follow redirects or POST after a failed file download", async () => {
    const api = mockHost(png, { redirect: true });
    await expect(
      attachChatGPTFileToTask(grant(), api.fetcher as typeof fetch, "abc123", file()),
    ).rejects.toThrow("CLICKUP_FILE_FETCH_HTTP_302");
    expect(api.calls.filter((call) => call.init?.method === "POST")).toHaveLength(0);
  });

  it("rejects oversized files before reading the body or posting", async () => {
    const api = mockHost(png, { tooLarge: true });
    await expect(
      attachChatGPTFileToTask(grant(), api.fetcher as typeof fetch, "abc123", file()),
    ).rejects.toThrow("CLICKUP_FILE_TOO_LARGE");
    expect(api.calls.filter((call) => call.init?.method === "POST")).toHaveLength(0);
  });

  it("rejects mismatched MIME and binary content without uploading", async () => {
    const api = mockHost(pdf);
    await expect(
      attachChatGPTFileToTask(grant(), api.fetcher as typeof fetch, "abc123", file()),
    ).rejects.toThrow("CLICKUP_UNSUPPORTED_FILE_TYPE");
    expect(api.calls.filter((call) => call.init?.method === "POST")).toHaveLength(0);
  });

  it("keeps non-company List-only callers behind the original write-scope gate", async () => {
    const api = mockHost(png);
    await expect(
      attachChatGPTFileToTask(grant("list"), api.fetcher as typeof fetch, "abc123", file()),
    ).rejects.toThrow("CLICKUP_WORKSPACE_SCOPE_REQUIRED");
    expect(api.fetcher).not.toHaveBeenCalled();
  });

  it("cancels a streamed upload source as soon as the 8 MiB limit is exceeded", async () => {
    const api = mockHost(png, { tooLargeStream: true });
    await expect(
      attachChatGPTFileToTask(grant(), api.fetcher as typeof fetch, "abc123", file()),
    ).rejects.toThrow("CLICKUP_FILE_TOO_LARGE");
    expect(api.cancelled).toBe(true);
    expect(api.calls.filter((call) => call.init?.method === "POST")).toHaveLength(0);
  });

  it("rejects foreign-home tasks before any supplied-file download", async () => {
    const api = mockHost(png, { foreign: true });
    const companyListGrant: ReadGrant = { ...grant("list"), companyListTaskAccess: true };
    await expect(
      attachChatGPTFileToTask(companyListGrant, api.fetcher as typeof fetch, "abc123", file()),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(api.calls.some((call) => call.url.hostname === "files.oaiusercontent.com")).toBe(false);
    expect(api.calls.filter((call) => call.init?.method === "POST")).toHaveLength(0);
  });
});
