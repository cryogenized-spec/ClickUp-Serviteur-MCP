import { describe, expect, it, vi } from "vitest";
import { runCatalogOperation } from "../src/clickup/catalog-runtime.js";
import { CLICKUP_MODEL_TOOL_CATALOG } from "../src/mcp/tool-catalog.js";
import type { ReadGrant } from "../src/clickup/policy.js";

const grant = (scope: "list" | "workspace" = "workspace"): ReadGrant => ({
  subject: "github:11",
  clickupUserId: "707",
  workspaceId: "555",
  listId: "12345",
  resourceScope: scope,
  apiToken: "test-token",
  quota: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
  },
});
function fakeApi(
  options: {
    wrongChannel?: boolean;
    foreignMessage?: boolean;
    missingParent?: boolean;
    fullDocsWithoutCursor?: boolean;
    maliciousDoc?: boolean;
  } = {},
) {
  const calls: Array<{ path: string; params: URLSearchParams; method: string }> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    calls.push({ path, params: new URLSearchParams(url.search), method: init?.method ?? "GET" });
    const reply = (body: unknown) => Response.json(body);
    if (path === "/api/v3/workspaces/555/chat/channels/chan1")
      return reply({
        channel: { id: options.wrongChannel ? "chan2" : "chan1", workspace_id: 555 },
      });
    if (path === "/api/v3/workspaces/555/chat/channels/chan1/messages") {
      const requested = url.searchParams.get("cursor");
      const page =
        requested === "parent-page"
          ? [{ id: "oldmsg", channel_id: "chan1", content: "Old message" }]
          : [
              {
                id: "msg1",
                channel_id: options.foreignMessage ? "chan2" : "chan1",
                content: "Message 1",
              },
              ...(!options.missingParent
                ? [{ id: "msg2", channel_id: "chan1", content: "Message 2" }]
                : []),
            ];
      return reply({ messages: page, next_cursor: requested ? null : "parent-page" });
    }
    if (path === "/api/v3/workspaces/555/chat/messages/msg1/replies")
      return reply({ messages: [{ id: "r1", content: "Acknowledged" }], next_cursor: null });
    if (path === "/api/v3/workspaces/555/chat/messages/oldmsg/replies")
      return reply({ messages: [{ id: "r-old", content: "Archived" }], next_cursor: null });
    if (path === "/api/v2/list/12345") return reply({ id: "12345", space: { id: "777" } });
    if (path === "/api/v2/team/555/space") return reply({ spaces: [{ id: "777" }] });
    if (path === "/api/v3/workspaces/555/docs")
      return reply({
        docs: options.fullDocsWithoutCursor
          ? Array.from({ length: 20 }, (_, i) => ({ id: "doc-" + i, name: "Doc " + i }))
          : options.maliciousDoc
            ? [null]
            : [{ id: "doc1", name: "Workshop SOP" }],
        ...(options.fullDocsWithoutCursor ? {} : { next_cursor: "doc-next" }),
      });
    throw new Error("Unexpected route " + path);
  });
  return { fetcher, calls };
}

describe("ClickUp v3 scoped Chat history and Docs discovery", () => {
  it("advertises three dedicated read tools with no API token arguments", () => {
    for (const name of [
      "clickup_get_chat_channel_messages",
      "clickup_get_chat_message_replies",
      "clickup_search_documents",
    ]) {
      const tools = CLICKUP_MODEL_TOOL_CATALOG.filter((tool) => tool.name === name);
      expect(tools).toHaveLength(1);
      expect(tools[0]!.effect).toBe("read");
      expect(tools[0]!.inputSchema.properties).not.toHaveProperty("api_token");
    }
  });

  it.each([
    "clickup_get_chat_channel_messages",
    "clickup_get_chat_message_replies",
    "clickup_search_documents",
  ])("denies %s to a single-List grant before making upstream calls", async (name) => {
    const api = fakeApi();
    await expect(
      runCatalogOperation(
        name,
        { channel_id: "chan1", message_id: "msg1" },
        grant("list"),
        api.fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_WORKSPACE_SCOPE_REQUIRED");
    expect(api.calls).toHaveLength(0);
  });

  it("reads messages only after independently resolving the authorized Workspace channel", async () => {
    const api = fakeApi();
    const result = await runCatalogOperation(
      "clickup_get_chat_channel_messages",
      { channel_id: "chan1", max_results: 10 },
      grant(),
      api.fetcher as typeof fetch,
    );
    expect((result["messages"] as Array<unknown>).length).toBe(2);
    expect(result).toMatchObject({ next_cursor: "parent-page", incomplete: true });
    expect(api.calls.map((c) => c.path)).toEqual([
      "/api/v3/workspaces/555/chat/channels/chan1",
      "/api/v3/workspaces/555/chat/channels/chan1/messages",
    ]);
    expect(api.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("passes a returned Chat cursor unchanged as one query parameter", async () => {
    const api = fakeApi();
    const result = await runCatalogOperation(
      "clickup_get_chat_channel_messages",
      { channel_id: "chan1", chat_cursor: "parent-page" },
      grant(),
      api.fetcher as typeof fetch,
    );
    expect((result["messages"] as Array<{ id: string }>)[0]?.id).toBe("oldmsg");
    expect(api.calls.at(-1)?.params.get("cursor")).toBe("parent-page");
  });

  it("rejects mismatched channel identity before reading message history", async () => {
    const api = fakeApi({ wrongChannel: true });
    await expect(
      runCatalogOperation(
        "clickup_get_chat_channel_messages",
        { channel_id: "chan1" },
        grant(),
        api.fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(api.calls).toHaveLength(1);
  });

  it("rejects foreign-channel message data instead of returning a mixed page", async () => {
    const api = fakeApi({ foreignMessage: true });
    await expect(
      runCatalogOperation(
        "clickup_get_chat_channel_messages",
        { channel_id: "chan1" },
        grant(),
        api.fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  });

  it("checks parent ownership before requesting replies by message ID", async () => {
    const api = fakeApi();
    const result = await runCatalogOperation(
      "clickup_get_chat_message_replies",
      { channel_id: "chan1", message_id: "msg1" },
      grant(),
      api.fetcher as typeof fetch,
    );
    expect(result).toMatchObject({ parent_message_id: "msg1", channel_id: "chan1" });
    expect((result["messages"] as Array<{ id: string }>)[0]?.id).toBe("r1");
    expect(api.calls.at(-1)?.path).toBe("/api/v3/workspaces/555/chat/messages/msg1/replies");
  });

  it("can prove an old message's parentage using an explicit channel-page cursor", async () => {
    const api = fakeApi();
    const result = await runCatalogOperation(
      "clickup_get_chat_message_replies",
      { channel_id: "chan1", message_id: "oldmsg", parent_chat_cursor: "parent-page" },
      grant(),
      api.fetcher as typeof fetch,
    );
    expect((result["messages"] as Array<{ id: string }>)[0]?.id).toBe("r-old");
    expect(api.calls[1]?.params.get("cursor")).toBe("parent-page");
  });

  it("never fetches replies to a fabricated parent message ID", async () => {
    const api = fakeApi();
    await expect(
      runCatalogOperation(
        "clickup_get_chat_message_replies",
        { channel_id: "chan1", message_id: "fabricated" },
        grant(),
        api.fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(api.calls.every((c) => !c.path.includes("/replies"))).toBe(true);
  });

  it("discovers Docs with v3 cursor and explicit provider-supported page size", async () => {
    const api = fakeApi();
    const result = await runCatalogOperation(
      "clickup_search_documents",
      { docs_limit: 20, docs_cursor: "abc_next" },
      grant(),
      api.fetcher as typeof fetch,
    );
    expect(result["docs"]).toMatchObject([{ id: "doc1", name: "Workshop SOP" }]);
    expect(result).toMatchObject({ next_cursor: "doc-next", incomplete: true });
    expect(api.calls[0]?.params.get("cursor")).toBe("abc_next");
    expect(api.calls[0]?.params.get("limit")).toBe("20");
  });

  it("verifies requested Docs List ancestry before reading documents", async () => {
    const api = fakeApi();
    await runCatalogOperation(
      "clickup_search_documents",
      { docs_parent_type: "LIST", docs_parent_id: "12345" },
      grant(),
      api.fetcher as typeof fetch,
    );
    expect(api.calls.map((c) => c.path)).toEqual([
      "/api/v2/list/12345",
      "/api/v2/team/555/space",
      "/api/v3/workspaces/555/docs",
    ]);
    expect(api.calls.at(-1)?.params.get("parent_type")).toBe("LIST");
    expect(api.calls.at(-1)?.params.get("parent_id")).toBe("12345");
  });

  it("rejects a foreign Workspace parent or orphan parent filter before document reads", async () => {
    for (const input of [
      { docs_parent_type: "WORKSPACE", docs_parent_id: "777" },
      { docs_parent_type: "LIST" },
    ]) {
      const api = fakeApi();
      await expect(
        runCatalogOperation(
          "clickup_search_documents",
          input,
          grant(),
          api.fetcher as typeof fetch,
        ),
      ).rejects.toThrow(/CLICKUP_(SCOPE_OR_SCHEMA_REJECTED|INVALID_ARGUMENT)/);
      expect(api.calls.filter((c) => c.path.endsWith("/docs"))).toHaveLength(0);
    }
  });

  it("discloses incomplete Docs pages without inventing a continuation cursor", async () => {
    const api = fakeApi({ fullDocsWithoutCursor: true });
    const result = await runCatalogOperation(
      "clickup_search_documents",
      {},
      grant(),
      api.fetcher as typeof fetch,
    );
    expect(result).toMatchObject({
      incomplete: true,
      continuation_unavailable: true,
      next_cursor: null,
    });
  });

  it("rejects malformed Doc records instead of returning an unvalidated page", async () => {
    const api = fakeApi({ maliciousDoc: true });
    await expect(
      runCatalogOperation("clickup_search_documents", {}, grant(), api.fetcher as typeof fetch),
    ).rejects.toThrow("CLICKUP_BAD_RESPONSE");
  });
});
