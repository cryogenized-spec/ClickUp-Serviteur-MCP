import { describe, expect, it, vi } from "vitest";
import { runCatalogOperation } from "../src/clickup/catalog-runtime.js";
import type { ReadGrant } from "../src/clickup/policy.js";

function setup(
  denied = false,
  foreignCommentAuthor = false,
  priorReceipt: Record<string, unknown> | null = null,
  commentDeleted = false,
) {
  const privateCalls = vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === "/followups/receipt") return Response.json({ receipt: priorReceipt });
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
        replayed: priorReceipt !== null,
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
      if (commentDeleted) return Response.json({ comments: [] });
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
    resourceScope: "list",
    apiToken: "private",
    quota: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
    },
    // Private task index exists even for List-only OAuth grants with no webhooks.
    taskIndex: {
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
    expect(privateCalls).toHaveBeenCalledTimes(2);
    const request = privateCalls.mock.calls[1]![0];
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
    expect(privateCalls).toHaveBeenCalledTimes(1);
    expect(new URL(privateCalls.mock.calls[0]![0].url).pathname).toBe("/followups/receipt");
  });

  it("accepts a committed identical replay after the original comment was deleted", async () => {
    const action = {
      task_id: "abc123",
      action_key: "comment:1500260000111534",
      action_kind: "instruction_sent",
      state_after: "awaiting_response",
      expected_revision: 0,
      note: null,
      evidence_comment_id: "1500260000111534",
      waiting_on_user_id: null,
      next_check_at_ms: null,
    };
    const { api, grant, privateCalls } = setup(
      false,
      false,
      {
        task_id: "abc123",
        action_key: action.action_key,
        revision: 1,
        request_json: JSON.stringify(action),
      },
      true,
    );
    const result = await runCatalogOperation(
      "clickup_record_followup_action",
      {
        task_id: action.task_id,
        followup_action_key: action.action_key,
        followup_action_kind: action.action_kind,
        followup_state_after: action.state_after,
        followup_expected_revision: action.expected_revision,
        followup_evidence_comment_id: action.evidence_comment_id,
      },
      grant,
      api as typeof fetch,
    );
    expect(result).toMatchObject({
      replayed: true,
      prior_exact_receipt_verified: true,
      provider_comment_evidence_verified: false,
    });
    expect(privateCalls).toHaveBeenCalledTimes(2);
    expect(api.mock.calls.some(([request]) => String(request).includes("/comment"))).toBe(false);
  });

  it("rejects conflicting payloads even when the action key already exists", async () => {
    const { api, grant, privateCalls } = setup(false, false, {
      task_id: "abc123",
      action_key: "review:123",
      revision: 1,
      request_json: JSON.stringify({ incorrect: "payload" }),
    });
    await expect(
      runCatalogOperation(
        "clickup_record_followup_action",
        {
          task_id: "abc123",
          followup_action_key: "review:123",
          followup_action_kind: "observation",
          followup_state_after: "awaiting_response",
          followup_expected_revision: 0,
        },
        grant,
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_FOLLOWUP_REVISION_CONFLICT");
    expect(privateCalls).toHaveBeenCalledTimes(1);
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
    expect(privateCalls).toHaveBeenCalledTimes(2);
    expect(api.mock.calls.some(([request]) => String(request).includes("/comment"))).toBe(true);
  });
  it("requires author-verified concrete evidence for manually claimed verified comments", async () => {
    const { api, grant, privateCalls } = setup(false, true);
    const action = {
      task_id: "abc123",
      followup_action_key: "verified-comment:1500260000111534",
      followup_action_kind: "verified_comment_posted",
      followup_state_after: "verified",
      followup_expected_revision: 0,
    };
    await expect(
      runCatalogOperation("clickup_record_followup_action", action, grant, api as typeof fetch),
    ).rejects.toThrow("CLICKUP_FOLLOWUP_EVIDENCE_REQUIRED");
    expect(privateCalls).not.toHaveBeenCalled();
    await expect(
      runCatalogOperation(
        "clickup_record_followup_action",
        { ...action, followup_evidence_comment_id: "1500260000111534" },
        grant,
        api as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_FOLLOWUP_EVIDENCE_UNVERIFIED");
    expect(privateCalls).toHaveBeenCalledTimes(1);
  });
});
