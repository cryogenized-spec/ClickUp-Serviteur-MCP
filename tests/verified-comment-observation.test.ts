import { describe, expect, it, vi } from "vitest";
import { recordVerifiedCommentObservation } from "../src/clickup/verified-comment-observation.js";
import type { ReadGrant } from "../src/clickup/policy.js";

function fixture(
  options: {
    prior?: boolean;
    state?: Record<string, unknown> | null;
    failReceipt?: boolean;
    failWrite?: boolean;
    conflict?: boolean;
  } = {},
) {
  const calls: Array<{ path: string; body?: Record<string, unknown> | undefined }> = [];
  const privateFetch = vi.fn(async (req: Request) => {
    const path = new URL(req.url).pathname;
    const body =
      req.method === "POST" ? ((await req.json()) as Record<string, unknown>) : undefined;
    calls.push({ path, body });
    if (path === "/followups/receipt") {
      if (options.failReceipt) return new Response(null, { status: 503 });
      return Response.json({
        receipt: options.prior
          ? {
              task_id: "task123",
              action_key: "verified-comment:6001",
              revision: 4,
              request_json: JSON.stringify({
                task_id: "task123",
                action_key: "verified-comment:6001",
                action_kind: "verified_comment_posted",
                evidence_comment_id: "6001",
              }),
            }
          : null,
      });
    }
    if (path === "/followups/task") {
      return Response.json({
        task_id: "task123",
        state: options.state === undefined ? null : options.state,
        history: [],
      });
    }
    if (path === "/followups/record") {
      if (options.conflict) return new Response(null, { status: 409 });
      if (options.failWrite) return new Response(null, { status: 503 });
      return Response.json({ task_id: "task123", revision: 5, replayed: false });
    }
    throw Error("Unexpected private RPC");
  });
  const identity = vi.fn((name: string) => name);
  const grant: ReadGrant = {
    subject: "github:11",
    clickupUserId: "707",
    workspaceId: "555",
    listId: "12345",
    resourceScope: "list",
    apiToken: "personal-token",
    quota: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
    },
    taskIndex: { idFromName: identity, get: () => ({ fetch: privateFetch }) },
  };
  return { calls, grant, privateFetch, identity };
}

describe("verified own-comment private observation", () => {
  it("preserves an existing obligation, responsible staff and due date while recording factual evidence", async () => {
    const { grant, calls, identity } = fixture({
      state: {
        state: "awaiting_response",
        waiting_on_user_id: "707",
        next_check_at_ms: 1795800000000,
        revision: 4,
      },
    });
    const result = await recordVerifiedCommentObservation(grant, "task123", "6001");
    expect(result).toMatchObject({
      recorded: true,
      action_key: "verified-comment:6001",
      revision: 5,
    });
    expect(identity).toHaveBeenCalledWith("555:github:11");
    expect(calls.map((r) => r.path)).toEqual([
      "/followups/receipt",
      "/followups/task",
      "/followups/record",
    ]);
    expect(calls[2]!.body).toMatchObject({
      task_id: "task123",
      action_key: "verified-comment:6001",
      action_kind: "verified_comment_posted",
      state_after: "awaiting_response",
      expected_revision: 4,
      evidence_comment_id: "6001",
      waiting_on_user_id: "707",
      next_check_at_ms: 1795800000000,
    });
    expect(String(calls[2]!.body?.["note"])).toContain(
      "delivery and recipient response unverified",
    );
  });

  it("starts a neutral verified record without inventing follow-up responsibility or due date", async () => {
    const { grant, calls } = fixture();
    const result = await recordVerifiedCommentObservation(grant, "task123", "6001");
    expect(result.recorded).toBe(true);
    expect(calls[2]!.body).toMatchObject({
      state_after: "verified",
      expected_revision: 0,
      waiting_on_user_id: null,
      next_check_at_ms: null,
    });
  });

  it("reuses the stored exact receipt without appending a duplicate action", async () => {
    const { grant, calls } = fixture({ prior: true });
    const result = await recordVerifiedCommentObservation(grant, "task123", "6001");
    expect(result).toMatchObject({
      recorded: true,
      revision: 4,
      action_key: "verified-comment:6001",
    });
    expect(calls.map((r) => r.path)).toEqual(["/followups/receipt"]);
  });

  it("does not erase resolved state when an authorized user posts a later comment", async () => {
    const { grant, calls } = fixture({
      state: {
        state: "resolved",
        waiting_on_user_id: null,
        next_check_at_ms: null,
        revision: 4,
      },
    });
    await recordVerifiedCommentObservation(grant, "task123", "6001");
    expect(calls[2]!.body).toMatchObject({ state_after: "resolved" });
  });

  it("reports storage problems or optimistic revision conflicts without repeating ClickUp", async () => {
    for (const options of [{ failReceipt: true }, { failWrite: true }, { conflict: true }]) {
      const { grant, calls } = fixture(options);
      const result = await recordVerifiedCommentObservation(grant, "task123", "6001");
      expect(result.recorded).toBe(false);
      expect(calls.filter((r) => r.path === "/followups/record")).toHaveLength(
        options.failReceipt ? 0 : 1,
      );
    }
  });

  it("rejects malformed IDs without attempting a private ledger lookup", async () => {
    const { grant, privateFetch } = fixture();
    expect(await recordVerifiedCommentObservation(grant, "../task", "6001")).toMatchObject({
      recorded: false,
      reason: "invalid_evidence",
    });
    expect(privateFetch).not.toHaveBeenCalled();
  });
});
