import { describe, expect, it, vi } from "vitest";
import { runCatalogOperation } from "../src/clickup/catalog-runtime.js";
import {
  chatMessageAuthorId,
  chatReactionName,
  requireOwnChatMessage,
} from "../src/clickup/chat-lifecycle.js";
import type { ReadGrant } from "../src/clickup/policy.js";

const grant: ReadGrant = {
  subject: "github:707",
  clickupUserId: "707",
  workspaceId: "555",
  listId: "12345",
  resourceScope: "workspace",
  apiToken: "synthetic-nonproduction-token",
  quota: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
  },
};

function mockLifecycle(options: {
  otherAuthor?: boolean;
  readbackCursor?: boolean;
  omitReplyId?: boolean;
  malformedChannel?: boolean;
} = {}) {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
  let content = "Original";
  let deleted = false;
  let reply: Record<string, unknown> | null = null;
  let reactions: Array<Record<string, unknown>> = [];
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const address = new URL(String(url));
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, path: address.pathname, body });
    if (address.hostname !== "api.clickup.com") throw Error("external address");
    if (method === "GET" && address.pathname.endsWith("/chat/channels/chan-1"))
      return Response.json({
        data: {
          id: options.malformedChannel ? "other" : "chan-1",
          workspace_id: "555",
          type: "CHANNEL",
        },
      });
    if (method === "GET" && address.pathname.endsWith("/chat/channels/chan-1/messages"))
      return Response.json({
        data: deleted ? [] : [
          {
            id: "msg-1",
            channel_id: "chan-1",
            user: { id: options.otherAuthor ? "808" : "707" },
            content,
          },
        ],
        next_cursor: deleted && options.readbackCursor ? "older" : null,
      });
    if (method === "POST" && address.pathname.endsWith("/chat/messages/msg-1/replies")) {
      reply = { id: "reply-1", user: { id: "707" }, channel_id: "chan-1", content: body?.["content"] };
      return Response.json(options.omitReplyId ? {} : { id: "reply-1" }, { status: 201 });
    }
    if (method === "GET" && address.pathname.endsWith("/chat/messages/msg-1/replies"))
      return Response.json({ data: reply ? [reply] : [], next_cursor: null });
    if (method === "PATCH" && address.pathname.endsWith("/chat/messages/msg-1")) {
      content = String(body?.["content"] ?? "");
      return Response.json({ id: "msg-1" });
    }
    if (method === "DELETE" && address.pathname.endsWith("/chat/messages/msg-1")) {
      deleted = true;
      return new Response(null, { status: 204 });
    }
    if (address.pathname.endsWith("/chat/messages/msg-1/reactions")) {
      if (method === "GET") return Response.json({ data: reactions, next_cursor: null });
      if (method === "POST") {
        reactions = [...reactions, { reaction: body?.["reaction"], user: { id: "707" } }];
        return Response.json({ id: "reaction-1" }, { status: 201 });
      }
    }
    if (method === "DELETE" && address.pathname.endsWith("/chat/messages/msg-1/reactions/thumbsup")) {
      reactions = reactions.filter((item) => String(item["reaction"]) !== "thumbsup");
      return new Response(null, { status: 204 });
    }
    throw Error("unexpected test request: " + method + " " + address.pathname);
  });
  return { fetcher, calls };
}

const base = { channel_id: "chan-1", message_id: "msg-1" };

describe("Chat message lifecycle: owner identity, replies and reactions (#135 P1)", () => {
  it("rejects author identity inferred from names or contradictory IDs", () => {
    expect(chatMessageAuthorId({ user: { id: "707" } })).toBe("707");
    expect(() => chatMessageAuthorId({ username: "Someone" })).toThrow(
      "CLICKUP_CHAT_AUTHOR_UNVERIFIED",
    );
    expect(() => chatMessageAuthorId({ user_id: "707", author: { id: "808" } })).toThrow(
      "CLICKUP_CHAT_AUTHOR_UNVERIFIED",
    );
    expect(() => requireOwnChatMessage({ author: { id: "808" }, content: "text" }, "707"))
      .toThrow("CLICKUP_CHAT_AUTHOR_MISMATCH");
  });

  it("creates one reply only after verifying its parent in the Workspace channel", async () => {
    const api = mockLifecycle();
    const result = await runCatalogOperation(
      "clickup_create_chat_reply",
      { ...base, content: "Reply to this message", content_format: "text/plain" },
      grant,
      api.fetcher as typeof fetch,
    );
    expect(result).toMatchObject({ id: "reply-1", verified_by_readback: true });
    const writes = api.calls.filter((call) => call.method === "POST");
    expect(writes).toEqual([
      {
        method: "POST",
        path: "/api/v3/workspaces/555/chat/messages/msg-1/replies",
        body: {
          type: "message",
          content: "Reply to this message",
          content_format: "text/plain",
        },
      },
    ]);
  });

  it("does not blindly retry an unacknowledged reply", async () => {
    const api = mockLifecycle({ omitReplyId: true });
    await expect(
      runCatalogOperation(
        "clickup_create_chat_reply",
        { ...base, content: "Reply" },
        grant,
        api.fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_WRITE_OUTCOME_UNKNOWN");
    expect(api.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("edits only own exact message and confirms new text with a readback", async () => {
    const api = mockLifecycle();
    const result = await runCatalogOperation(
      "clickup_edit_own_chat_message",
      { ...base, expected_content: "Original", content: "Corrected" },
      grant,
      api.fetcher as typeof fetch,
    );
    expect(result).toMatchObject({ id: "msg-1", verified_by_readback: true });
    expect(api.calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
  });

  it("denies other author's edit and any unexpected original content without PATCH", async () => {
    for (const input of [
      { expected_content: "Original", content: "Other person's text" },
      { expected_content: "Incorrect", content: "Risky update" },
    ]) {
      const api = mockLifecycle(input.expected_content === "Original" ? { otherAuthor: true } : {});
      await expect(
        runCatalogOperation(
          "clickup_edit_own_chat_message",
          { ...base, ...input },
          grant,
          api.fetcher as typeof fetch,
        ),
      ).rejects.toThrow();
      expect(api.calls.filter((call) => call.method === "PATCH")).toHaveLength(0);
    }
  });

  it("deletes only own explicitly confirmed exact message, verifies absence", async () => {
    const api = mockLifecycle();
    const result = await runCatalogOperation(
      "clickup_delete_own_chat_message",
      { ...base, confirm_delete: true, expected_content: "Original" },
      grant,
      api.fetcher as typeof fetch,
    );
    expect(result).toMatchObject({ deleted: true, verified_by_readback: true });
    expect(api.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
  });

  it("refuses delete without confirmation, own authorship, or complete readback", async () => {
    const noApproval = mockLifecycle();
    await expect(
      runCatalogOperation(
        "clickup_delete_own_chat_message",
        { ...base, expected_content: "Original" },
        grant,
        noApproval.fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_INVALID_ARGUMENT");
    expect(noApproval.calls).toHaveLength(0);
    const other = mockLifecycle({ otherAuthor: true });
    await expect(
      runCatalogOperation(
        "clickup_delete_own_chat_message",
        { ...base, confirm_delete: true, expected_content: "Original" },
        grant,
        other.fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_CHAT_AUTHOR_MISMATCH");
    expect(other.calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
    const unknown = mockLifecycle({ readbackCursor: true });
    await expect(
      runCatalogOperation(
        "clickup_delete_own_chat_message",
        { ...base, confirm_delete: true, expected_content: "Original" },
        grant,
        unknown.fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_WRITE_OUTCOME_UNKNOWN");
    expect(unknown.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
  });

  it("accepts only lower-case emoji names; no Unicode path construction", () => {
    expect(chatReactionName("thumbsup")).toBe("thumbsup");
    for (const bad of ["👍", "Thumbsup", "../evil", ":smile:", ""]) {
      expect(() => chatReactionName(bad)).toThrow("CLICKUP_INVALID_ARGUMENT");
    }
  });

  it("adds and reads back only the connected user's reaction, then removes it", async () => {
    const api = mockLifecycle();
    const added = await runCatalogOperation(
      "clickup_add_chat_reaction",
      { ...base, reaction_name: "thumbsup" },
      grant,
      api.fetcher as typeof fetch,
    );
    expect(added).toMatchObject({ reaction: "thumbsup", verified_by_readback: true });
    const read = await runCatalogOperation(
      "clickup_get_chat_message_reactions",
      base,
      grant,
      api.fetcher as typeof fetch,
    );
    expect(read["reactions"]).toHaveLength(1);
    const removed = await runCatalogOperation(
      "clickup_remove_own_chat_reaction",
      { ...base, reaction_name: "thumbsup" },
      grant,
      api.fetcher as typeof fetch,
    );
    expect(removed).toMatchObject({ removed: true, verified_by_readback: true });
    expect(api.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(api.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
  });

  it("refuses removal of another person's or missing reaction", async () => {
    const api = mockLifecycle();
    await expect(
      runCatalogOperation(
        "clickup_remove_own_chat_reaction",
        { ...base, reaction_name: "thumbsup" },
        grant,
        api.fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_CHAT_REACTION_NOT_VERIFIED");
    expect(api.calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
  });

  it("denies all new operations with List-only authorization before calling upstream", async () => {
    const api = mockLifecycle();
    for (const operation of [
      "clickup_create_chat_reply",
      "clickup_edit_own_chat_message",
      "clickup_delete_own_chat_message",
      "clickup_get_chat_message_reactions",
      "clickup_add_chat_reaction",
      "clickup_remove_own_chat_reaction",
    ]) {
      await expect(
        runCatalogOperation(operation, base, { ...grant, resourceScope: "list" }, api.fetcher as typeof fetch),
      ).rejects.toThrow("CLICKUP_WORKSPACE_SCOPE_REQUIRED");
    }
    expect(api.calls).toHaveLength(0);
  });
});
