import { describe, expect, it, vi } from "vitest";
import { runCatalogOperation } from "../src/clickup/catalog-runtime.js";
import { readVerifiedTaskImage } from "../src/clickup/image-reader.js";
import type { ReadGrant } from "../src/clickup/policy.js";
import { toolImage } from "../src/mcp/create-server.js";

const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jcZ0AAAAASUVORK5CYII=";
const png = Uint8Array.from(atob(pngBase64), (value) => value.charCodeAt(0));
const source = "https://t555.p.clickup-attachments.com/t555/qa/image.png?authz_token=synthetic";
const attachment = () => ({
  id: "11111111-2222-4333-8444-555555555555.png",
  title: "whatsapp.png",
  extension: "png",
  mimetype: "image/png",
  size: png.length,
  url: source,
});
const grant = (): ReadGrant => ({
  subject: "github:qa",
  clickupUserId: "707",
  workspaceId: "555",
  listId: "12345",
  resourceScope: "list",
  companyListTaskAccess: true,
  apiToken: "synthetic-personal-oauth-token",
  quota: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
  },
});

const getApi = (options: {
  foreign?: boolean;
  redirect?: boolean;
  responseType?: string;
  tooLarge?: boolean;
  data?: Uint8Array;
} = {}) => {
  let cdnCalls = 0;
  let cancelled = false;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host === "t555.p.clickup-attachments.com") {
      cdnCalls++;
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
      expect(JSON.stringify(init?.headers)).not.toContain("synthetic-personal-oauth-token");
      if (options.redirect)
        return new Response(null, { status: 302, headers: { location: "http://localhost/private" } });
      if (options.tooLarge)
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(3 * 1024 * 1024 + 1));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200, headers: { "content-type": "image/png" } },
        );
      const raw = options.data ?? png;
      const bytes = new Uint8Array(raw);
      return new Response(bytes, {
        status: 200,
        headers: { "content-type": options.responseType ?? "image/png" },
      });
    }
    if (url.pathname === "/api/v2/task/abc123")
      return Response.json({
        id: "abc123",
        list: { id: options.foreign ? "12346" : "12345" },
        attachments: [attachment()],
      });
    if (url.pathname === "/api/v2/list/12345")
      return Response.json({ id: "12345", space: { id: "777" } });
    if (url.pathname === "/api/v2/team/555/space")
      return Response.json({ spaces: [{ id: "777" }] });
    throw Error("Unexpected synthetic API request");
  });
  return {
    fetcher,
    get cdnCalls() {
      return cdnCalls;
    },
    get cancelled() {
      return cancelled;
    },
  };
};

describe("read-only ClickUp task image transport", () => {
  it("returns actual PNG bytes as MCP image content without leaking the signed URL", async () => {
    const api = getApi();
    const result = await runCatalogOperation(
      "clickup_read_task_image",
      { task_id: "abc123", attachment_id: attachment().id },
      grant(),
      api.fetcher as typeof fetch,
    );
    const converted = toolImage(result);
    expect(converted.content).toEqual([
      expect.objectContaining({ type: "text" }),
      { type: "image", mimeType: "image/png", data: pngBase64 },
    ]);
    expect(converted.structuredContent).toMatchObject({
      attachment_id: attachment().id,
      width: 1,
      height: 1,
      size_bytes: png.length,
    });
    expect(JSON.stringify(converted.structuredContent)).not.toContain("authz_token");
    expect(JSON.stringify(converted.content[0])).not.toContain("image_data_base64");
    expect(api.cdnCalls).toBe(1);
  });

  it("rejects a foreign task List without contacting the attachment CDN", async () => {
    const api = getApi({ foreign: true });
    await expect(
      runCatalogOperation(
        "clickup_read_task_image",
        { task_id: "abc123", attachment_id: attachment().id },
        grant(),
        api.fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(api.cdnCalls).toBe(0);
  });

  it("rejects an unlisted attachment before download", async () => {
    const api = getApi();
    await expect(
      runCatalogOperation(
        "clickup_read_task_image",
        { task_id: "abc123", attachment_id: "another-image.png" },
        grant(),
        api.fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(api.cdnCalls).toBe(0);
  });

  it("blocks arbitrary origins, foreign Workspaces, and malformed attachment identifiers", async () => {
    for (const url of [
      "https://127.0.0.1/image.png",
      "https://t555.p.clickup-attachments.com.evil.invalid/image.png",
      "https://t999.p.clickup-attachments.com/t999/image.png",
      "https://t555.p.clickup-attachments.com/not-authorized/image.png",
      "http://t555.p.clickup-attachments.com/t555/qa/image.png",
    ]) {
      const api = getApi();
      await expect(
        readVerifiedTaskImage({ ...attachment(), url }, api.fetcher as typeof fetch, "555"),
      ).rejects.toThrow("CLICKUP_IMAGE_HOST_NOT_ALLOWED");
      expect(api.cdnCalls).toBe(0);
    }
    for (const id of ["../x.png", "a/b.png", "a..png", "bad id.png", "?.png"]) {
      const api = getApi();
      await expect(
        readVerifiedTaskImage({ ...attachment(), id }, api.fetcher as typeof fetch, "555"),
      ).rejects.toThrow("CLICKUP_IMAGE_ATTACHMENT_INVALID");
      expect(api.cdnCalls).toBe(0);
    }
  });

  it("rejects redirects, oversized streams, and wrong content types", async () => {
    const redirect = getApi({ redirect: true });
    await expect(
      readVerifiedTaskImage(attachment(), redirect.fetcher as typeof fetch, "555"),
    ).rejects.toThrow("CLICKUP_IMAGE_REDIRECT_BLOCKED");
    const large = getApi({ tooLarge: true });
    await expect(
      readVerifiedTaskImage(attachment(), large.fetcher as typeof fetch, "555"),
    ).rejects.toThrow("CLICKUP_IMAGE_TOO_LARGE");
    expect(large.cancelled).toBe(true);
    const html = getApi({ responseType: "text/html" });
    await expect(
      readVerifiedTaskImage(attachment(), html.fetcher as typeof fetch, "555"),
    ).rejects.toThrow("CLICKUP_IMAGE_UNSUPPORTED_TYPE");
  });

  it("rejects wrong file signatures and image dimensions regardless of metadata", async () => {
    const bad = getApi({ data: new TextEncoder().encode("not a png") });
    await expect(
      readVerifiedTaskImage(attachment(), bad.fetcher as typeof fetch, "555"),
    ).rejects.toThrow("CLICKUP_IMAGE_INVALID_CONTENT");
    const bomb = new Uint8Array(png);
    // PNG IHDR width 8193 (0x00002001) exceeds the edge cap.
    bomb[16] = 0;
    bomb[17] = 0;
    bomb[18] = 0x20;
    bomb[19] = 1;
    const tooWide = getApi({ data: bomb });
    await expect(
      readVerifiedTaskImage(attachment(), tooWide.fetcher as typeof fetch, "555"),
    ).rejects.toThrow("CLICKUP_IMAGE_DIMENSIONS_REJECTED");
    const api = getApi();
    await expect(
      readVerifiedTaskImage(
        { ...attachment(), size: 3 * 1024 * 1024 + 1 },
        api.fetcher as typeof fetch,
        "555",
      ),
    ).rejects.toThrow("CLICKUP_IMAGE_TOO_LARGE");
    expect(api.cdnCalls).toBe(0);
  });

  it("rejects bad MIME/extension pair without a network request", async () => {
    const api = getApi();
    await expect(
      readVerifiedTaskImage(
        { ...attachment(), mimetype: "text/html" },
        api.fetcher as typeof fetch,
        "555",
      ),
    ).rejects.toThrow("CLICKUP_IMAGE_UNSUPPORTED_TYPE");
    expect(api.cdnCalls).toBe(0);
  });
});
