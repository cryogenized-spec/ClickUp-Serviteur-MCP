import { describe, expect, it, vi } from "vitest";
import { runCatalogOperation } from "../src/clickup/catalog-runtime.js";
import type { ReadGrant } from "../src/clickup/policy.js";
import { CLICKUP_MODEL_TOOL_CATALOG } from "../src/mcp/tool-catalog.js";

const grant: ReadGrant = {
  subject: "github:markdown-qa",
  clickupUserId: "707",
  workspaceId: "555",
  listId: "12345",
  resourceScope: "workspace",
  apiToken: "synthetic-personal-token",
  quota: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
  },
};

function mockClickUp(taskMarkdown = "# Existing formatted content") {
  const requests: Array<{ method: string; url: URL; body: Record<string, unknown> | null }> = [];
  const fetcher = vi.fn(async (request: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(request));
    const method = options?.method ?? "GET";
    const body = options?.body
      ? (JSON.parse(String(options.body)) as Record<string, unknown>)
      : null;
    requests.push({ method, url, body });
    expect(url.hostname).toBe("api.clickup.com");
    const path = url.pathname;
    if (path === "/api/v2/list/12345" && method === "GET")
      return Response.json({ id: "12345", name: "QA list", space: { id: "777" } });
    if (path === "/api/v2/team/555/space" && method === "GET")
      return Response.json({ spaces: [{ id: "777" }] });
    if (path === "/api/v2/task/abc123" && method === "GET")
      return Response.json({
        id: "abc123",
        list: { id: "12345" },
        markdown_description: taskMarkdown,
      });
    if (
      method === "GET" &&
      path.startsWith("/api/v3/workspaces/555/chat/channels/") &&
      path.split("/").length === 8
    )
      return Response.json({ id: path.split("/").at(-1), workspace_id: "555" });
    if (
      method === "POST" &&
      path.startsWith("/api/v3/workspaces/555/chat/channels/") &&
      path.endsWith("/messages")
    )
      return Response.json({ id: "new123" }, { status: 201 });
    return Response.json({ id: "new123", name: "Synthetic" });
  });
  return { fetcher, requests };
}

const lastWrite = (requests: ReturnType<typeof mockClickUp>["requests"]) => {
  const write = requests.filter((request) => request.method !== "GET").at(-1);
  expect(write).toBeDefined();
  return write!;
};

describe("ClickUp API-native Markdown authoring surfaces", () => {
  it("exposes explicit Markdown inputs alongside legacy plain task fields", () => {
    for (const name of [
      "clickup_create_task",
      "clickup_update_task",
      "clickup_create_bulk_tasks",
    ]) {
      const definition = CLICKUP_MODEL_TOOL_CATALOG.find((entry) => entry.name === name);
      expect(definition).toBeDefined();
      const properties =
        name === "clickup_create_task"
          ? definition!.inputSchema.properties["new_task"]?.properties
          : name === "clickup_update_task"
            ? definition!.inputSchema.properties["changes"]?.properties
            : definition!.inputSchema.properties["tasks"]?.items?.properties;
      expect(properties?.["description_markdown"]?.type).toBe("string");
    }
  });

  it("creates a Markdown task without sending conflicting plain description", async () => {
    const api = mockClickUp();
    const markdown = "# Repair\n\n**Bold** | `inline code`\n\n- [x] Item";
    await runCatalogOperation(
      "clickup_create_task",
      { list_id: "12345", new_task: { name: "QA", description_markdown: markdown } },
      grant,
      api.fetcher as typeof fetch,
    );
    expect(lastWrite(api.requests).body).toMatchObject({
      name: "QA",
      markdown_content: markdown,
      notify_all: false,
    });
    expect(lastWrite(api.requests).body).not.toHaveProperty("description");
  });

  it("updates a Markdown task and requests Markdown readback from ClickUp", async () => {
    const api = mockClickUp();
    const result = await runCatalogOperation(
      "clickup_update_task",
      { task_id: "abc123", changes: { description_markdown: "## Changed" } },
      grant,
      api.fetcher as typeof fetch,
    );
    expect(result).toMatchObject({ id: "new123" });
    expect(lastWrite(api.requests).body).toMatchObject({ markdown_content: "## Changed" });
    const taskRead = api.requests.find((request) => request.url.pathname === "/api/v2/task/abc123");
    expect(taskRead?.url.searchParams.get("include_markdown_description")).toBe("true");
  });

  it("returns supported long Markdown without silent truncation, and flags oversized upstream content", async () => {
    const saved = "# QA\\n" + "x".repeat(20_000);
    const api = mockClickUp(saved);
    const task = await runCatalogOperation(
      "clickup_get_task",
      { task_id: "abc123" },
      grant,
      api.fetcher as typeof fetch,
    );
    expect(task["markdown_description"]).toBe(saved);
    expect(task["incomplete"]).toBe(false);

    const oversized = "# QA\\n" + "x".repeat(41_000);
    const huge = mockClickUp(oversized);
    const limited = await runCatalogOperation(
      "clickup_get_task",
      { task_id: "abc123" },
      grant,
      huge.fetcher as typeof fetch,
    );
    expect(String(limited["markdown_description"])).toHaveLength(40_000);
    expect(limited["incomplete"]).toBe(true);
  });

  it("preserves bulk Markdown drafts and refuses ambiguous dual descriptions", async () => {
    const api = mockClickUp();
    await runCatalogOperation(
      "clickup_create_bulk_tasks",
      { list_id: "12345", tasks: [{ name: "QA", description_markdown: "**batch**" }] },
      grant,
      api.fetcher as typeof fetch,
    );
    expect(lastWrite(api.requests).body).toMatchObject({ markdown_content: "**batch**" });
    await expect(
      runCatalogOperation(
        "clickup_create_task",
        {
          list_id: "12345",
          new_task: { name: "QA", description: "plain", description_markdown: "# MD" },
        },
        grant,
        api.fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_INVALID_ARGUMENT");
    expect(api.requests.filter((request) => request.method === "POST")).toHaveLength(1);
  });

  it("uses ClickUp markdown_content for new and updated Lists", async () => {
    const api = mockClickUp();
    await runCatalogOperation(
      "clickup_create_list",
      { space_id: "777", name: "QA list", description_markdown: "# Inventory\n\n| A | B |" },
      grant,
      api.fetcher as typeof fetch,
    );
    expect(lastWrite(api.requests).body).toMatchObject({
      markdown_content: "# Inventory\n\n| A | B |",
    });
    expect(lastWrite(api.requests).body).not.toHaveProperty("content");

    await runCatalogOperation(
      "clickup_update_list",
      { list_id: "12345", name: "QA list", description_markdown: "**New description**" },
      grant,
      api.fetcher as typeof fetch,
    );
    expect(lastWrite(api.requests).body).toMatchObject({
      name: "QA list",
      markdown_content: "**New description**",
    });
    expect(lastWrite(api.requests).body).not.toHaveProperty("content");

    await expect(
      runCatalogOperation(
        "clickup_update_list",
        {
          list_id: "12345",
          name: "QA list",
          description: "plain",
          description_markdown: "**rich**",
        },
        grant,
        api.fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_INVALID_ARGUMENT");
  });

  it("sets explicit Chat Markdown or plain content format without changing its legacy text field", async () => {
    const api = mockClickUp();
    await runCatalogOperation(
      "clickup_send_chat_message",
      { channel_id: "chan-1", text: "**Important**" },
      grant,
      api.fetcher as typeof fetch,
    );
    expect(lastWrite(api.requests).body).toEqual({
      type: "message",
      content: "**Important**",
      content_format: "text/md",
    });
    await runCatalogOperation(
      "clickup_send_chat_message",
      { channel_id: "chan-1", text: "**literal**", content_format: "text/plain" },
      grant,
      api.fetcher as typeof fetch,
    );
    expect(lastWrite(api.requests).body).toMatchObject({ content_format: "text/plain" });
    await expect(
      runCatalogOperation(
        "clickup_send_chat_message",
        { channel_id: "chan-1", text: "unsafe", content_format: "text/html" },
        grant,
        api.fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_INVALID_ARGUMENT");
    expect(api.requests.filter((r) => r.method === "POST")).toHaveLength(2);
  });

  it("supports both declared Docs formats, including update readback format selection", async () => {
    const api = mockClickUp();
    await runCatalogOperation(
      "clickup_create_document_page",
      { document_id: "doc1", name: "Readme", doc_content: "# Header", content_format: "text/md" },
      grant,
      api.fetcher as typeof fetch,
    );
    expect(lastWrite(api.requests).body).toMatchObject({
      content: "# Header",
      content_format: "text/md",
    });
    await runCatalogOperation(
      "clickup_update_document_page",
      {
        document_id: "doc1",
        page_id: "page1",
        doc_content: "**literal**",
        content_format: "text/plain",
      },
      grant,
      api.fetcher as typeof fetch,
    );
    expect(lastWrite(api.requests).body).toMatchObject({
      content: "**literal**",
      content_edit_mode: "replace",
      content_format: "text/plain",
    });
  });
});
