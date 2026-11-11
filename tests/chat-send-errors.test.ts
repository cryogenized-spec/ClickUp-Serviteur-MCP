import { describe, expect, it, vi } from "vitest";
import { runCatalogOperation } from "../src/clickup/catalog-runtime.js";
import { ReadFailure, type ReadGrant } from "../src/clickup/policy.js";
import { toolError } from "../src/mcp/create-server.js";

const grant: ReadGrant = {
  subject: "github:707",
  clickupUserId: "707",
  workspaceId: "555",
  listId: "12345",
  resourceScope: "workspace",
  apiToken: "private-synthetic-test-token",
  quota: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
  },
};

const send = (fetcher: typeof fetch) =>
  runCatalogOperation(
    "clickup_send_chat_message",
    { channel_id: "test-channel", content: "Benign synthetic test", content_format: "text/plain" },
    grant,
    fetcher,
  );

describe("private Chat v3 delivery error classification (issue #120)", () => {
  it("keeps the documented POST body and accepts a 201 acknowledgement", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, options?: RequestInit) => {
      expect(options?.method).toBe("POST");
      expect(JSON.parse(String(options?.body))).toEqual({
        type: "message",
        content: "Benign synthetic test",
        content_format: "text/plain",
      });
      return Response.json({ id: "synthetic-msg-id" }, { status: 201 });
    });
    await expect(send(fetcher as typeof fetch)).resolves.toMatchObject({
      id: "synthetic-msg-id",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "https://api.clickup.com/api/v3/workspaces/555/chat/channels/test-channel/messages",
    );
  });

  it.each([
    [400, "CLICKUP_CHAT_REQUEST_REJECTED", "rejected"],
    [422, "CLICKUP_CHAT_REQUEST_REJECTED", "rejected"],
    [404, "CLICKUP_CHAT_DESTINATION_UNAVAILABLE", "rejected"],
    [409, "CLICKUP_CHAT_CONFLICT", "rejected"],
    [401, "CLICKUP_UPSTREAM_DENIED", "rejected"],
    [403, "CLICKUP_UPSTREAM_DENIED", "rejected"],
    [429, "CLICKUP_RATE_LIMITED", "rejected"],
    [502, "CLICKUP_WRITE_OUTCOME_UNKNOWN", "unknown"],
    [503, "CLICKUP_WRITE_OUTCOME_UNKNOWN", "unknown"],
  ] as const)("maps HTTP %i to %s and exposes only sanitized diagnostics", async (status, code, outcome) => {
    const fetcher = vi.fn(async () =>
      Response.json(
        {
          error: "private channel test-user@example.com",
          request: { authorization: "private-synthetic-test-token" },
          content: "Benign synthetic test",
        },
        { status },
      ),
    );
    let failure: ReadFailure | undefined;
    try {
      await send(fetcher as typeof fetch);
    } catch (error) {
      if (error instanceof ReadFailure) failure = error;
      else throw error;
    }
    expect(failure).toBeInstanceOf(ReadFailure);
    expect(failure?.code).toBe(code);
    expect(failure?.diagnostic).toEqual({
      endpoint_category: "chat_message_send",
      http_status: status,
      write_outcome: outcome,
    });
    expect(fetcher).toHaveBeenCalledTimes(1); // never replay a potentially delivered write
    expect(JSON.stringify(failure)).not.toContain("test-user@example.com");
    expect(JSON.stringify(failure)).not.toContain("private-synthetic-test-token");
  });

  it("treats a lost response after POST as unknown, without a blind second send", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("The upstream may have delivered private contents");
    });
    let failure: ReadFailure | undefined;
    try {
      await send(fetcher as typeof fetch);
    } catch (error) {
      if (error instanceof ReadFailure) failure = error;
      else throw error;
    }
    expect(failure?.code).toBe("CLICKUP_WRITE_OUTCOME_UNKNOWN");
    expect(failure?.diagnostic).toEqual({
      endpoint_category: "chat_message_send",
      write_outcome: "unknown",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(failure)).not.toContain("private contents");
  });

  it("serializes only allowlisted fields at the MCP error boundary", () => {
    const upstream = new ReadFailure("CLICKUP_CHAT_DESTINATION_UNAVAILABLE", {
      endpoint_category: "chat_message_send",
      http_status: 404,
      write_outcome: "rejected",
    });
    Object.assign(upstream, {
      private_message: "Confidential staff message",
      channel_id: "private-channel",
      authorization: "private-synthetic-test-token",
    });
    const result = toolError(upstream);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      code: "CLICKUP_CHAT_DESTINATION_UNAVAILABLE",
      endpoint_category: "chat_message_send",
      http_status: 404,
      write_outcome: "rejected",
    });
    expect(JSON.stringify(result)).not.toContain("Confidential staff message");
    expect(JSON.stringify(result)).not.toContain("private-channel");
    expect(JSON.stringify(result)).not.toContain("private-synthetic-test-token");
    expect(JSON.parse(toolError(new Error("secret upstream body")).content[0]!.text)).toEqual({
      code: "CLICKUP_UNAVAILABLE",
    });
  });

  it("does not change error classification of other ClickUp reads", async () => {
    const fetcher = vi.fn(async () => Response.json({ reason: "private" }, { status: 404 }));
    let failure: ReadFailure | undefined;
    try {
      await runCatalogOperation("clickup_get_chat_channels", {}, grant, fetcher as typeof fetch);
    } catch (error) {
      if (error instanceof ReadFailure) failure = error;
      else throw error;
    }
    expect(failure?.code).toBe("CLICKUP_UPSTREAM_UNAVAILABLE");
    expect(failure?.diagnostic).toBeUndefined();
  });
});
