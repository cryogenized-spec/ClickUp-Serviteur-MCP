import { describe, expect, it, vi } from "vitest";
import { runCatalogOperation } from "../src/clickup/catalog-runtime.js";
import {
  chatCollection,
  chatCursor,
  chatEntity,
  chatMemberIds,
  validateRequestedRecipients,
} from "../src/clickup/chat-v3.js";
import type { ReadGrant } from "../src/clickup/policy.js";

const grant: ReadGrant = {
  subject: "github:707",
  clickupUserId: "707",
  workspaceId: "555",
  listId: "12345",
  resourceScope: "workspace",
  apiToken: "synthetic-test-token",
  quota: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
  },
};

function mockChat(opts: {
  channelType?: "DM" | "GROUP_DM" | "CHANNEL";
  participants?: string[];
  wrongWorkspace?: boolean;
  incorrectChannel?: boolean;
  nextCursor?: string | null;
} = {}) {
  const calls: Array<{ path: string; method: string; body: Record<string, unknown> | null }> = [];
  const participants = opts.participants ?? ["707", "808"];
  const channel = {
    id: opts.incorrectChannel ? "foreign" : "chan-123",
    workspace_id: opts.wrongWorkspace ? "666" : "555",
    type: opts.channelType ?? "DM",
  };
  const fetcher = vi.fn(async (req: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(req));
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ path: url.pathname + url.search, method, body });
    if (url.hostname !== "api.clickup.com") throw Error("foreign host");
    if (url.pathname === "/api/v2/team")
      return Response.json({
        teams: [{ id: "555", members: [
          { user: { id: 707, username: "Caller" } },
          { user: { id: 808, username: "Coworker" } },
          { user: { id: 909, username: "Another member" } },
        ] }],
      });
    if (url.pathname.endsWith("/chat/channels/direct_message") && method === "POST")
      return Response.json({ data: { id: "chan-123", type: "DM" } }, { status: 200 });
    if (url.pathname.endsWith("/chat/channels/chan-123/members"))
      return Response.json({
        data: participants.map((id) => ({ user: { id } })),
        next_cursor: opts.nextCursor ?? null,
      });
    if (url.pathname.endsWith("/chat/channels/chan-123") && method === "GET")
      return Response.json({ data: { channel } });
    if (url.pathname.endsWith("/chat/channels/chan-123/messages") && method === "POST")
      return Response.json({ id: "msg-1" }, { status: 201 });
    if (url.pathname.endsWith("/chat/channels/chan-123/messages") && method === "GET")
      return Response.json({ data: [{ id: "msg-1", channel_id: "chan-123" }], next_cursor: null });
    if (url.pathname.endsWith("/chat/channels") && method === "GET")
      return Response.json({ data: [channel], next_cursor: "page-two" });
    throw Error("unexpected route " + url.pathname);
  });
  return { fetcher, calls };
}

describe("v3 Chat envelope normalization and safe recipient identity (#135)", () => {
  it("accepts the documented v3 data envelope without converting a private DM to schema denial", () => {
    expect(chatEntity({ data: { channel: { id: "chan-123" } } }, "channel")).toEqual({
      id: "chan-123",
    });
    expect(chatCollection({ data: [{ id: "one" }] }, "messages")).toEqual([{ id: "one" }]);
    expect(chatCollection({ messages: [{ id: "two" }] }, "messages")).toEqual([{ id: "two" }]);
    expect(chatCursor({ data: { pagination: { next_cursor: "next" } } })).toBe("next");
    expect(() => chatCollection({ data: "malformed" }, "messages")).toThrow("CLICKUP_BAD_RESPONSE");
  });

  it("does not confuse GitHub, member display names or repeated IDs with verified recipients", () => {
    expect(validateRequestedRecipients(["808"], undefined)).toEqual(["808"]);
    expect(validateRequestedRecipients(undefined, true)).toEqual([]);
    for (const params of [
      [["808", "808"], undefined],
      [[], undefined],
      [["someone"], undefined],
      [["707", "808"], true],
      [undefined, undefined],
    ] as const) {
      expect(() => validateRequestedRecipients(params[0], params[1])).toThrow(
        "CLICKUP_INVALID_ARGUMENT",
      );
    }
    expect(() => chatMemberIds({ members: [{ name: "Coworker" }] })).toThrow(
      "CLICKUP_SCOPE_OR_SCHEMA_REJECTED",
    );
  });

  it("reads a candidate DM channel using same-Workspace data envelope", async () => {
    const api = mockChat();
    const result = await runCatalogOperation(
      "clickup_get_chat_channel_details",
      { channel_id: "chan-123" },
      grant,
      api.fetcher as typeof fetch,
    );
    expect(result).toMatchObject({
      channel_id: "chan-123",
      recipient_identity_verified: false,
    });
    expect(api.calls).toHaveLength(1);
  });

  it("retrieves a bounded member page with a cursor but does not treat it as proof of complete identity", async () => {
    const api = mockChat({ nextCursor: "more" });
    const result = await runCatalogOperation(
      "clickup_get_chat_channel_members",
      { channel_id: "chan-123", max_results: 3 },
      grant,
      api.fetcher as typeof fetch,
    );
    expect(result).toMatchObject({ next_cursor: "more", incomplete: true });
    expect(result["members"]).toHaveLength(2);
    expect(api.calls).toHaveLength(2);
  });

  it("previews exact DM recipients without writing or sending anything", async () => {
    const api = mockChat();
    const result = await runCatalogOperation(
      "clickup_verify_chat_recipients",
      { channel_id: "chan-123", user_ids: ["808"] },
      grant,
      api.fetcher as typeof fetch,
    );
    expect(result).toMatchObject({
      channel_id: "chan-123",
      verified_recipient_ids: ["808"],
      participant_ids: ["707", "808"],
      exact_recipients_verified: true,
      message_sent: false,
    });
    expect(api.calls.map((call) => call.method)).toEqual(["GET", "GET", "GET"]);
  });

  it("opens an existing DM with the verified coworker but never sends a message", async () => {
    const api = mockChat();
    const result = await runCatalogOperation(
      "clickup_open_direct_message",
      { user_ids: ["808"] },
      grant,
      api.fetcher as typeof fetch,
    );
    expect(result).toMatchObject({
      channel_id: "chan-123",
      exact_recipients_verified: true,
      message_sent: false,
    });
    const posts = api.calls.filter((call) => call.method === "POST");
    expect(posts).toEqual([
      {
        method: "POST",
        path: "/api/v3/workspaces/555/chat/channels/direct_message",
        body: { user_ids: ["808"] },
      },
    ]);
  });

  it("requires actual complete membership, current user and correct DM type after opening", async () => {
    const cases = [
      { participants: ["707", "909"] },
      { participants: ["808"] },
      { participants: ["707", "808", "909"] },
      { participants: ["707", "808"], nextCursor: "more" },
      { participants: ["707", "808"], wrongWorkspace: true },
      { participants: ["707", "808"], incorrectChannel: true },
      { participants: ["707", "808"], channelType: "CHANNEL" as const },
    ];
    for (const options of cases) {
      const api = mockChat(options);
      await expect(
        runCatalogOperation(
          "clickup_open_direct_message",
          { user_ids: ["808"] },
          grant,
          api.fetcher as typeof fetch,
        ),
      ).rejects.toThrow();
      expect(api.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    }
  });

  it("refuses an unverified or foreign member ID before creating any DM", async () => {
    const api = mockChat();
    await expect(
      runCatalogOperation(
        "clickup_open_direct_message",
        { user_ids: ["999"] },
        grant,
        api.fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(api.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("keeps private DM send separate, requiring exact recipient verification before the POST", async () => {
    const api = mockChat();
    await expect(
      runCatalogOperation(
        "clickup_send_chat_message",
        { channel_id: "chan-123", content: "Approved message" },
        grant,
        api.fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_INVALID_ARGUMENT");
    expect(api.calls.filter((call) => call.method === "POST")).toHaveLength(0);
    const result = await runCatalogOperation(
      "clickup_send_chat_message",
      { channel_id: "chan-123", content: "Approved message", user_ids: ["808"] },
      grant,
      api.fetcher as typeof fetch,
    );
    expect(result).toMatchObject({ id: "msg-1" });
    expect(api.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("handles v3 cursor data envelopes for channel and message reads", async () => {
    const api = mockChat();
    const channels = await runCatalogOperation(
      "clickup_get_chat_channels",
      { max_results: 3 },
      grant,
      api.fetcher as typeof fetch,
    );
    expect(channels).toMatchObject({ next_cursor: "page-two", incomplete: true });
    expect(channels["channels"]).toHaveLength(1);
    const messages = await runCatalogOperation(
      "clickup_get_chat_channel_messages",
      { channel_id: "chan-123", max_results: 3 },
      grant,
      api.fetcher as typeof fetch,
    );
    expect(messages["messages"]).toHaveLength(1);
  });

  it("rejects Workspace-only Chat operations for a List-only grant before network calls", async () => {
    const api = mockChat();
    await expect(
      runCatalogOperation(
        "clickup_open_direct_message",
        { user_ids: ["808"] },
        { ...grant, resourceScope: "list" },
        api.fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_WORKSPACE_SCOPE_REQUIRED");
    expect(api.calls).toHaveLength(0);
  });
});
