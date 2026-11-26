import { describe, expect, it, vi } from "vitest";
import { runCatalogOperation } from "../src/clickup/catalog-runtime.js";
import type { ReadGrant } from "../src/clickup/policy.js";

function fixture(
  options: {
    authorId?: number;
    receiptFails?: boolean;
    resultId?: string;
  } = {},
) {
  const providerCalls: Array<{ path: string; method: string }> = [];
  const privateCalls: Array<{ path: string; body?: Record<string, unknown> | undefined }> = [];
  const commentId = options.resultId ?? "1500260000111534";
  const api = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    providerCalls.push({ path, method });
    if (path === "/api/v2/task/task123") {
      return Response.json({
        id: "task123",
        list: { id: "12345" },
        name: "Sample client query",
        status: { status: "price request" },
        assignees: [{ id: 707 }],
      });
    }
    if (path === "/api/v2/list/12345") return Response.json({ id: "12345", space: { id: "777" } });
    if (path === "/api/v2/team/555/space") return Response.json({ spaces: [{ id: "777" }] });
    if (path === "/api/v2/task/task123/comment") {
      if (method === "POST") return Response.json({ id: commentId });
      if (method === "GET")
        return Response.json({
          comments: [
            {
              id: commentId,
              user: { id: options.authorId ?? 707 },
              comment_text: "Please check the supplier's quotation.",
            },
          ],
        });
    }
    throw Error("Unexpected provider call: " + method + " " + path);
  });
  const privateFetch = vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    const body =
      request.method === "POST" ? ((await request.json()) as Record<string, unknown>) : undefined;
    privateCalls.push({ path, body });
    if (path === "/followups/receipt")
      return options.receiptFails
        ? new Response(null, { status: 503 })
        : Response.json({ receipt: null });
    if (path === "/followups/task")
      return Response.json({
        task_id: "task123",
        state: null,
        history: [],
      });
    if (path === "/followups/record")
      return Response.json({ task_id: "task123", revision: 1, replayed: false });
    throw Error("Unexpected private request " + path);
  });
  const grant: ReadGrant = {
    subject: "github:11",
    clickupUserId: "707",
    workspaceId: "555",
    listId: "12345",
    resourceScope: "list",
    companyListTaskAccess: true,
    apiToken: "personal-secret-not-in-output",
    quota: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
    },
    taskIndex: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: privateFetch }),
    },
  };
  return { api, grant, providerCalls, privateCalls };
}

describe("factual private ledger capture after own ClickUp comments", () => {
  it("observes a posted plain comment only after fresh ID, author and text verification", async () => {
    const { api, grant, providerCalls, privateCalls } = fixture();
    const result = await runCatalogOperation(
      "clickup_create_task_comment",
      { task_id: "task123", text: "Please check the supplier's quotation." },
      grant,
      api as typeof fetch,
    );
    expect(result).toMatchObject({
      id: "1500260000111534",
      verified_by_readback: true,
      notification_delivery_unverified: true,
      followup_observation: {
        recorded: true,
        action_key: "verified-comment:1500260000111534",
        revision: 1,
      },
    });
    expect(providerCalls.filter((x) => x.method === "POST")).toEqual([
      {
        path: "/api/v2/task/task123/comment",
        method: "POST",
      },
    ]);
    expect(privateCalls.map((x) => x.path)).toEqual([
      "/followups/receipt",
      "/followups/task",
      "/followups/record",
    ]);
    expect(privateCalls[2]!.body).toMatchObject({
      action_kind: "verified_comment_posted",
      task_id: "task123",
      evidence_comment_id: "1500260000111534",
      state_after: "verified",
      expected_revision: 0,
    });
    expect(JSON.stringify(result)).not.toContain("personal-secret-not-in-output");
  });

  it("does not invent evidence when the posted comment was authored by a different person", async () => {
    const { api, grant, providerCalls, privateCalls } = fixture({ authorId: 999 });
    const result = await runCatalogOperation(
      "clickup_create_task_comment",
      { task_id: "task123", text: "Please check the supplier's quotation." },
      grant,
      api as typeof fetch,
    );
    expect(result).toMatchObject({
      id: "1500260000111534",
      followup_observation: {
        recorded: false,
        reason: "clickup_readback_unverified",
      },
    });
    expect(privateCalls).toHaveLength(0);
    expect(providerCalls.filter((x) => x.method === "POST")).toHaveLength(1);
  });

  it("reports private ledger outage without masking or retrying a successful ClickUp POST", async () => {
    const { api, grant, providerCalls, privateCalls } = fixture({ receiptFails: true });
    const result = await runCatalogOperation(
      "clickup_create_task_comment",
      { task_id: "task123", text: "Please check the supplier's quotation." },
      grant,
      api as typeof fetch,
    );
    expect(result).toMatchObject({
      verified_by_readback: true,
      followup_observation: { recorded: false, reason: "private_storage_failed" },
    });
    expect(providerCalls.filter((x) => x.method === "POST")).toHaveLength(1);
    expect(privateCalls.map((x) => x.path)).toEqual(["/followups/receipt"]);
  });

  it("requires a concrete provider comment ID before logging an observation", async () => {
    const { api, grant, privateCalls } = fixture({ resultId: "bad comment!" });
    const result = await runCatalogOperation(
      "clickup_create_task_comment",
      { task_id: "task123", text: "Please check the supplier's quotation." },
      grant,
      api as typeof fetch,
    );
    expect(result).toMatchObject({
      followup_observation: { recorded: false, reason: "invalid_evidence" },
    });
    expect(privateCalls).toHaveLength(0);
  });
});
