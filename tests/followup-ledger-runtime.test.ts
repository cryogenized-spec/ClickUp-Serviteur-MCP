import { describe, expect, it, vi } from "vitest";
import { runCatalogOperation } from "../src/clickup/catalog-runtime.js";
import type { ReadGrant } from "../src/clickup/policy.js";

function setup(denied = false, foreignCommentAuthor = false) {
  const privateCalls = vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === "/followups/task")
      return Response.json({
        task_id: "abc123",
        state: null,
        history: [],
        incomplete: false,
        next_before_revision: null,
      });
    if (path === "/followups/record") {
      const body = (await request.json()) as { task_id: string };
      return Response.json({
        task_id: body.task_id,
        revision: 1,
        replayed: false,
        state: { state: "awaiting_response", revision: 1 },
      });
    }
    return new Response(null, { status: 404 });
  });
  const api = vi.fn(async (request: RequestInfo | URL, _init?: RequestInit) => {
    const path = new URL(String(request)).pathname;
    if (path === "/api/v2/task/abc123") {
      return denied
        ? Response.json({}, { status: 403 })
        : Response.json({
            id: "abc123",
            name: "Customer enquiry",
            list: { id: "12345" },
            status: { status: "price request" },
            assignees: [{ id: 707 }],
            date_updated: "1795680000000",
          });
    }
    if (path === "/api/v2/task/abc123/comment") {
      return Response.json({
        comments: [
          {
            id: "1500260000111534",
            date: "1795680000000",
            user: { id: foreignCommentAuthor ? 999 : 707 },
            comment_text: "Original verified message",
          },
        ],
      });
    }
    if (path === "/api/v2/list/12345") {
      return Response.json({ id: "12345", space: { id: "777" } });
    }
    if (path === "/api/v2/team/555/space") {
      return Response.json({ spaces: [{ id: "777" }] });
    }
    throw Error("Unexpected upstream path " + path);
  });
  const grant: ReadGrant = {
    subject: "github:11",
    clickupUserId: "707",
    workspaceId: "555",
    listId: "12345",
    resourceScope: "workspace",
    apiToken: "private",
    quota: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
    },
    webhookEvents: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: privateCalls }),
    },
  };
  return { api, grant, privateCalls };
}

describe("OAuth-verifying follow-up MCP adapter", () => {
  it("reads private state only after the individual task is verified live", async () => {
    const { api, grant, privateCalls } = setup();
    const result = await runCatalogOperation(
      "clickup_get_followup_state",
      { task_id: "abc123" },
      grant,
      api as typeof fetch,
    );
    expect(result).toMatchObject({
      task_id: "abc123",
      task_access_verified: true,
      verified_clickup_task: {
        title: "Customer enquiry",
        status: "price request",
      },
      ledger_state_is_human_curated: true,
    });
    expect(privateCalls).toHaveBeenCalledTimes(1);
    expect(new URL(privateCalls.mock.calls[0]![0].url).pathname).toBe("/followups/task");
  });

  it("never reads the actor's private ledger when live ClickUp task denies access", async () => {
    const { api, grant, privateCalls } = setup(true);
    await expect(
      runCatalogOperation(
        "clickup_get_followup_state",
        { task_id: "abc123" },
        grant,
        api as typeof fetch,
      ),
    ).rejects.toThrow();
    expect(privateCalls).not.toHaveBeenCalled();
  });

  it("records internal review state without mutating ClickUp", async () => {
    const { api, grant, privateCalls } = setup();
    const response = await runCatalogOperation(
      "clickup_record_followup_action",
      {
        task_id: "abc123",
        followup_action_key: "review:123",
        followup_action_kind: "observation",
        followup_state_after: "awaiting_response",
        followup_expected_revision: 0,
        followup_note: "Awaiting supplier quote",
      },
      grant,
      api as typeof fetch,
    );
    expect(response).toMatchObject({
      revision: 1,
      private_ledger_only: true,
      provider_comment_evidence_verified: false,
      clickup_task_unchanged: true,
    });
    const request = privateCalls.mock.calls[0]![0];
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe("/followups/record");
    expect(
      api.mock.calls.every(
        ([, init]) => !init || init.method === undefined || init.method === "GET",
      ),
    ).toBe(true);
  });

  it("does not mistake another employee's comment for Gareth's sent instruction", async () => {
    const { api, grant, privateCalls } = setup(false, true);
    await expect(
      runCatalogOperation(
        "clickup_record_followup_action",
        {
          task_id: "abc123",
          followup_action_key: "comment:1500260000111534",
          followup_action_kind: "instruction_sent",
          followup_state_after: "awaiting_response",
          followup_expected_revision: 0,
          followup_evidence_comment_id: "1500260000111534",
        },
        grant,
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_FOLLOWUP_EVIDENCE_UNVERIFIED");
    expect(privateCalls).not.toHaveBeenCalled();
  });

  it("refuses a claimed sent action without evidence and verifies the exact provider comment", async () => {
    const { api, grant, privateCalls } = setup();
    const base = {
      task_id: "abc123",
      followup_action_key: "comment:1500260000111534",
      followup_action_kind: "instruction_sent",
      followup_state_after: "awaiting_response",
      followup_expected_revision: 0,
    };
    await expect(
      runCatalogOperation("clickup_record_followup_action", base, grant, api as typeof fetch),
    ).rejects.toThrow("CLICKUP_FOLLOWUP_EVIDENCE_REQUIRED");
    expect(privateCalls).not.toHaveBeenCalled();
    const result = await runCatalogOperation(
      "clickup_record_followup_action",
      { ...base, followup_evidence_comment_id: "1500260000111534" },
      grant,
      api as typeof fetch,
    );
    expect(result).toMatchObject({
      revision: 1,
      provider_comment_evidence_verified: true,
    });
    expect(privateCalls).toHaveBeenCalledTimes(1);
    expect(api.mock.calls.some(([request]) => String(request).includes("/comment"))).toBe(true);
  });
});
