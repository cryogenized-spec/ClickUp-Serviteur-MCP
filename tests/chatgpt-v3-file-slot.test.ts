import { describe, expect, it, vi } from "vitest";
import { attachChatGPTFileV3, type ChatGPTProvidedFile } from "../src/clickup/chatgpt-uploads.js";
import type { ReadGrant } from "../src/clickup/policy.js";

const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const file: ChatGPTProvidedFile = {
  download_url: "https://files.oaiusercontent.com/signed/approved",
  file_id: "file_synthetic12345",
  mime_type: "image/png",
  file_name: "small.png",
};
const grant: ReadGrant = {
  subject: "github:11",
  clickupUserId: "707",
  workspaceId: "555",
  listId: "12345",
  resourceScope: "workspace",
  apiToken: "never-forward-to-file-host",
  quota: {
    idFromName: (value: string) => value,
    get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
  },
};

function mockUpload(sourceBytes: Uint8Array = image) {
  const requests: Array<{ path: string; method: string; headers?: RequestInit["headers"] }> = [];
  let postCount = 0;
  const uploadedFilenames: string[] = [];
  const fetcher = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(request));
    const path = url.pathname;
    const method = init?.method ?? "GET";
    requests.push({ path, method, ...(init?.headers ? { headers: init.headers } : {}) });
    if (url.hostname === "files.oaiusercontent.com") {
      expect(JSON.stringify(init?.headers)).not.toContain("never-forward-to-file-host");
      expect(init?.redirect).toBe("manual");
      return new Response(sourceBytes, { status: 200 });
    }
    if (path === "/api/v2/task/abc123")
      return Response.json({
        id: "abc123",
        list: { id: "12345" },
        custom_fields: [{ id: "field-file", type: "attachment", value: null }],
        attachments: [],
      });
    if (path === "/api/v2/list/12345") return Response.json({ id: "12345", space: { id: "777" } });
    if (path === "/api/v2/team/555/space") return Response.json({ spaces: [{ id: "777" }] });
    if (path === "/api/v2/list/12345/field")
      return Response.json({ fields: [{ id: "field-file", type: "attachment" }] });
    if (path === "/api/v3/workspaces/555/attachments/abc123/attachments") {
      if (method === "POST") {
        postCount++;
        const attachment = (init?.body as FormData).get("attachment");
        expect(attachment).toBeInstanceOf(Blob);
        uploadedFilenames.push((attachment as File).name);
        return Response.json({ id: "uploaded-image", parent_id: "abc123", title: "small.png" });
      }
      return Response.json({
        data: [{ id: "uploaded-image", title: "small.png" }],
        next_cursor: null,
      });
    }
    if (path === "/api/v3/workspaces/555/custom_fields/field-file/attachments") {
      if (method === "POST") {
        postCount++;
        return Response.json({ id: "uploaded-file", parent_id: "field-file", title: "small.png" });
      }
      return Response.json({
        data: [{ id: "uploaded-file", title: "small.png" }],
        next_cursor: null,
      });
    }
    throw Error("Unexpected request " + method + " " + path);
  });
  return {
    fetcher,
    requests,
    get postCount() {
      return postCount;
    },
    get uploadedFilenames() {
      return uploadedFilenames;
    },
  };
}

describe("ChatGPT v3 attached-file bridge", () => {
  it("uploads a real file slot to a task without forwarding ClickUp auth", async () => {
    const api = mockUpload();
    const uploaded = await attachChatGPTFileV3(grant, api.fetcher as typeof fetch, "abc123", file);
    expect(uploaded).toMatchObject({
      attachment_id: "uploaded-image",
      verified_by_readback: true,
      requires_task_association: false,
      byte_size: image.byteLength,
      media_type: "image/png",
    });
    expect(api.postCount).toBe(1);
  });

  it("uploads an applicable Files field, but never associates it automatically", async () => {
    const api = mockUpload();
    const uploaded = await attachChatGPTFileV3(
      grant,
      api.fetcher as typeof fetch,
      "abc123",
      file,
      "field-file",
    );
    expect(uploaded).toMatchObject({
      field_id: "field-file",
      attachment_id: "uploaded-file",
      verified_by_readback: true,
      requires_task_association: true,
    });
    expect(api.postCount).toBe(1);
    expect(api.requests.some((entry) => entry.path.includes("/api/v2/task/abc123/field/"))).toBe(
      false,
    );
  });

  it("preflights and uploads a Files field under company List-scoped task access", async () => {
    const api = mockUpload();
    const listGrant: ReadGrant = { ...grant, resourceScope: "list", companyListTaskAccess: true };
    const uploaded = await attachChatGPTFileV3(
      listGrant,
      api.fetcher as typeof fetch,
      "abc123",
      file,
      "field-file",
    );
    expect(uploaded).toMatchObject({
      attachment_id: "uploaded-file",
      verified_by_readback: true,
      requires_task_association: true,
    });
    expect(api.postCount).toBe(1);
  });

  it("renames a transcoded camera photo to its detected WebP extension", async () => {
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
    ]);
    const api = mockUpload(webp);
    const result = await attachChatGPTFileV3(grant, api.fetcher as typeof fetch, "abc123", {
      ...file,
      file_name: "photo.jpg",
      mime_type: "image/webp",
    });
    expect(result).toMatchObject({
      attachment_id: "uploaded-image",
      media_type: "image/webp",
    });
    expect(api.uploadedFilenames).toEqual(["photo.webp"]);
  });

  it("reports only the untrusted hostname and never a signed file URL", async () => {
    const api = mockUpload();
    const url = "https://outside.example.com/private/token?a=secret-credential";
    await expect(
      attachChatGPTFileV3(grant, api.fetcher as typeof fetch, "abc123", {
        ...file,
        download_url: url,
      }),
    ).rejects.toMatchObject({
      code: "CLICKUP_FILE_HOST_NOT_ALLOWED",
      diagnostic: {
        endpoint_category: "file_source_validation",
        file_source_host: "outside.example.com",
      },
    });
    expect(api.fetcher).not.toHaveBeenCalled();
  });

  it("accepts known OpenAI file delivery origins without permitting lookalikes", async () => {
    const api = mockUpload();
    await expect(
      attachChatGPTFileV3(grant, api.fetcher as typeof fetch, "abc123", {
        ...file,
        download_url: "https://files.openai.com/signed/image",
      }),
    ).rejects.not.toThrow("CLICKUP_FILE_HOST_NOT_ALLOWED");
    const evil = mockUpload();
    await expect(
      attachChatGPTFileV3(grant, evil.fetcher as typeof fetch, "abc123", {
        ...file,
        download_url: "https://files.openai.com.evil.example/signed",
      }),
    ).rejects.toThrow("CLICKUP_FILE_HOST_NOT_ALLOWED");
  });

  it("rejects unresolved file slots and disallowed source URLs before fetching", async () => {
    const api = mockUpload();
    await expect(
      attachChatGPTFileV3(grant, api.fetcher as typeof fetch, "abc123", "file_id" as never),
    ).rejects.toThrow("CLICKUP_FILE_PARAM_UNRESOLVED");
    await expect(
      attachChatGPTFileV3(grant, api.fetcher as typeof fetch, "abc123", {
        ...file,
        download_url: "https://example.net/internal",
      }),
    ).rejects.toThrow("CLICKUP_FILE_HOST_NOT_ALLOWED");
    expect(api.fetcher).not.toHaveBeenCalled();
  });
});
