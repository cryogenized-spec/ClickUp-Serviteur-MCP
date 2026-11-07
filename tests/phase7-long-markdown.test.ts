import { describe, expect, it, vi } from "vitest";
import { runCatalogOperation } from "../src/clickup/catalog-runtime.js";
import type { ReadGrant } from "../src/clickup/policy.js";
import { CLICKUP_MODEL_TOOL_CATALOG } from "../src/mcp/tool-catalog.js";

const grant: ReadGrant = {
  subject: "github:docs-chat-qa",
  clickupUserId: "707",
  workspaceId: "555",
  listId: "12345",
  resourceScope: "workspace",
  apiToken: "synthetic-token-only",
  quota: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
  },
};

function mock() {
  const calls: Array<{ url: URL; method: string; body: Record<string, unknown> | null }> = [];
  const fetcher = vi.fn(async (req: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(req));
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, method, body });
    expect(url.hostname).toBe("api.clickup.com");
    return Response.json({ id: "synthetic-1", name: "test" });
  });
  return { calls, fetcher };
}

describe("full-length Markdown authoring for v3 Docs and Chat", () => {
  it("advertises 40k v3 content and explicit Markdown read format", () => {
    const chat = CLICKUP_MODEL_TOOL_CATALOG.find(
      (item) => item.name === "clickup_send_chat_message",
    );
    expect(chat?.inputSchema.properties["content"]?.maxLength).toBe(40_000);
    const docs = CLICKUP_MODEL_TOOL_CATALOG.find(
      (item) => item.name === "clickup_create_document_page",
    );
    expect(docs?.inputSchema.properties["doc_content"]?.maxLength).toBe(40_000);
    const read = CLICKUP_MODEL_TOOL_CATALOG.find(
      (item) => item.name === "clickup_get_document_pages",
    );
    expect(read?.inputSchema.properties["content_format"]?.enum).toEqual([
      "text/md",
      "text/plain",
    ]);
  });

  it("posts a 25k Markdown Chat message with the native full content field", async () => {
    const api = mock();
    const markdown = "# Heading\n" + "x".repeat(25_000);
    await runCatalogOperation(
      "clickup_send_chat_message",
      { channel_id: "chan-123", content: markdown, content_format: "text/md" },
      grant,
      api.fetcher as typeof fetch,
    );
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]?.body).toEqual({
      type: "message",
      content: markdown,
      content_format: "text/md",
    });
    await expect(
      runCatalogOperation(
        "clickup_send_chat_message",
        { channel_id: "chan-123", text: "legacy", content: "conflicting" },
        grant,
        api.fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_INVALID_ARGUMENT");
    expect(api.calls).toHaveLength(1);
  });

  it("creates and updates 30k Docs page content and retrieves plain export format", async () => {
    const api = mock();
    const markdown = "## Long document\n" + "x".repeat(30_000);
    await runCatalogOperation(
      "clickup_create_document_page",
      { document_id: "doc-1", name: "QA", doc_content: markdown },
      grant,
      api.fetcher as typeof fetch,
    );
    expect(api.calls.at(-1)?.body).toMatchObject({
      content: markdown,
      content_format: "text/md",
    });

    await runCatalogOperation(
      "clickup_update_document_page",
      {
        document_id: "doc-1",
        page_id: "page-1",
        doc_content: markdown,
        content_format: "text/plain",
      },
      grant,
      api.fetcher as typeof fetch,
    );
    expect(api.calls.at(-1)?.body).toMatchObject({
      content: markdown,
      content_edit_mode: "replace",
      content_format: "text/plain",
    });

    await runCatalogOperation(
      "clickup_get_document_pages",
      { document_id: "doc-1", page_id: "page-1", content_format: "text/plain" },
      grant,
      api.fetcher as typeof fetch,
    );
    expect(api.calls.at(-1)?.url.searchParams.get("content_format")).toBe("text/plain");

    const writes = api.calls.filter((item) => item.method !== "GET").length;
    await expect(
      runCatalogOperation(
        "clickup_create_document_page",
        { document_id: "doc-1", name: "Too big", doc_content: "z".repeat(40_001) },
        grant,
        api.fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_INVALID_ARGUMENT");
    expect(api.calls.filter((item) => item.method !== "GET")).toHaveLength(writes);
  });
});
